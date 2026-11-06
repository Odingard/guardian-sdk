/**
 * Maps an OpenClaw tool call to the Guardian tool it is governed as.
 *
 * It reuses guardian-hook's classifier (`classifyCommand`, `governedCall`,
 * `mcpToolName`, `tierOf`), so a shell command gets the same Guardian tool
 * name whether Claude Code or OpenClaw runs it. The mapping only routes; the
 * human sets each connection's mode (Allow / Ask / Deny) in Guardian.
 *
 * Fail closed: only a short list of known read-only tools is skipped. Any
 * tool this file does not recognise, including tools added by other plugins,
 * is governed as `openclaw.<tool>` on the Ask-tier connection.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyCommand,
  governedCall,
  mcpToolName,
  tierOf,
  type GovernedCall,
  type HookToolName,
} from "../../hook/src/classify.js";

export type { GovernedCall, HookToolName };

/**
 * Tools that only read, so they run without asking Guardian. `read` on a
 * process environment file is still governed (see `governOpenClawCall`).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "web_search",
  "x_search",
  "session_status",
  "sessions_list",
  "sessions_history",
  "agents_list",
  "get_goal",
  "tool_search",
  "tool_describe",
]);

/** `process` actions that only look at a background exec session. */
const PROCESS_READ_ACTIONS = new Set(["list", "poll", "log", "status"]);
/**
 * `process` actions that type into a running background process, and the
 * only input fields OpenClaw 2026.7.1 reads for each (bash-tools: `write`
 * writes `data`; `paste` writes `text`; `send-keys` writes `literal`, then
 * the `hex` bytes, then the `keys` tokens; `submit` writes a CR). Any other
 * input field on the call is a decoy and the call is refused.
 */
const PROCESS_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  write: ["data", "eof"],
  paste: ["text", "bracketed"],
  "send-keys": ["literal", "hex", "keys"],
  submit: [],
};
const INPUT_FIELDS = [
  "data",
  "text",
  "literal",
  "hex",
  "keys",
  "eof",
  "bracketed",
] as const;

const MAX_TEXT = 2_000;

/**
 * Commands that try to read a process environment (where the Guardian
 * credential lives in the Gateway's start-up environment) go to the Ask tier
 * as `shell_destructive`, so a person sees them. This narrows, but cannot
 * close, the gap: see the README's "What is not governed".
 */
const CREDENTIAL_PROBE = /\/proc\/|environ|GUARDIAN_AGENT_CREDENTIAL/i;

/**
 * Commands that drive OpenClaw's own CLI (`openclaw plugins disable`,
 * `openclaw config set ...`), name its config file, its state directory
 * (outside the agent workspace), this plugin's package or the variables that
 * relocate them. OpenClaw hot-reloads `openclaw.json` (reload mode `hybrid`,
 * `plugins.*` is a hot `reload-plugins`), so one such call could switch
 * Guardian off. They go to the Ask tier as `shell_destructive`.
 */
const OPENCLAW_CLI =
  /(?:^|[\s;&|`(/'"\\=])openclaw(?:\.mjs)?(?=$|[\s;&|)`'"\\])/i;
/** Guardian's own config keys and plugin commands, however `openclaw` is spelt. */
const GUARDIAN_CONFIG_TEXT =
  /plugins\.entries\.guardian|plugins\s+(?:disable|uninstall|remove|rm)\s+\S*guardian/i;
const OPENCLAW_CONTROL_TEXT =
  /(?:openclaw|clawdbot)\.json|guardian-openclaw|OPENCLAW_(?:STATE_DIR|CONFIG_PATH|HOME)\b/i;
/**
 * `.openclaw` (or the legacy `.clawdbot`, which OpenClaw still reads) plus
 * the path that follows it, inside a command or a path.
 */
const STATE_DIR_REF =
  /\.(?:openclaw|clawdbot)(?![\w.-])(\/[^\s'"`;|&<>()]*)?/gi;
/** State directory names, compared lower-cased (APFS is case-insensitive). */
const STATE_DIR_NAMES = new Set([".openclaw", ".clawdbot"]);

/**
 * Commands that create a symbolic or hard link. A link made inside the
 * workspace (`ln -s .. s`) turns a later everyday `write s/openclaw.json`
 * into a write to the state directory, and the plugin does not resolve
 * links on disk, so every link creation goes to the Ask tier: `ln` and
 * `link` as a word, `cp -s` / `cp -l` / `--symbolic-link` / `--link`,
 * `mklink`, PowerShell's `-ItemType SymbolicLink|HardLink|Junction`, and
 * the `symlink` / `link` calls of Python, Node, Perl and Ruby. This is a
 * backstop: the primary defence is the install-integrity check
 * (integrity.ts), which blocks everything while the install is writable.
 */
const LINK_WORD = /(?:^|[\s;&|`(/])(?:ln|link|mklink)(?=$|[\s;&|)`])/i;
/**
 * `cp` short options with `s` or `l`, and any long option GNU getopt would
 * expand to `--symbolic-link` or `--link` (`--sym`, `--li`, ...): every
 * `--s…` / `--l…` except `--sparse`, `--strip-trailing-slashes`, `--suffix`.
 */
const CP_LINK =
  /(?:^|[\s;&|`(/])cp(?=\s)[^;&|\n]*\s(?:-[a-zA-Z]*[sl][a-zA-Z]*|--(?:s(?![ptu])|l)[\w-]*)(?=$|[\s;&|)`=])/;
const LINK_CALL =
  /(?:^|[^\w])(?:sym)?link(?:Sync)?\s*\(|(?:sym|hard)link_to\b|FileUtils\s*(?:\.|::)\s*(?:ln|link|symlink)\w*|ItemType\s+["']?(?:SymbolicLink|HardLink|Junction)/i;
/**
 * Inline interpreter code (`perl -e 'symlink "..", "s"'`, `ruby -e`,
 * `python -c`): any `symlink` / `link` / `ln_s` word, called with or
 * without parentheses.
 */
const INTERPRETER =
  /(?:^|[\s;&|`(/])(?:perl|ruby|python[\d.]*|node|php|lua|tclsh|osascript)(?=$|[\s;&|)`])/i;
const INTERPRETER_LINK = /\b(?:sym|hard)?link\w*|\bln(?:_\w+)?\b/i;

/** Does `command` create a symbolic or hard link? */
export function createsLink(command: string): boolean {
  const bare = command.replace(/['"\\]/g, "");
  return [command, bare].some(
    (t) =>
      LINK_WORD.test(t) ||
      CP_LINK.test(t) ||
      LINK_CALL.test(t) ||
      (INTERPRETER.test(t) && INTERPRETER_LINK.test(t)),
  );
}

/**
 * A `..` path component in a command (`mv ../extensions/guardian x`,
 * `cp -r evil/. ..`, `tar -C ..`, `git --work-tree=..`). From the agent's
 * default workspace, `<state>/workspace`, one `..` is the state directory.
 */
const PARENT_OPERAND = /(?:^|[\s=:'"`(/])\.\.(?=$|[/\s'"`;|&)])/;

/** Does `command` name a parent directory with `..`? */
export function climbsOut(command: string): boolean {
  const bare = command.replace(/['"\\]/g, "");
  return PARENT_OPERAND.test(command) || PARENT_OPERAND.test(bare);
}

export type OpenClawToolCall = Readonly<{
  toolName: string;
  params: Record<string, unknown>;
  /** From `event.derivedPaths` (apply_patch). Hints only. */
  derivedPaths?: readonly string[];
  /** From `event.toolKind`, e.g. `code_mode_exec` for Code Mode's exec. */
  toolKind?: string;
  /**
   * OpenClaw config and state locations the agent must not change without a
   * person (see `controlRootsFromEnv`). `~/.openclaw` is always covered.
   */
  controlRoots?: readonly string[];
}>;

/**
 * The locations, beyond `~/.openclaw`, where this Gateway keeps its config
 * and state: `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_HOME`.
 */
export function controlRootsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_HOME"]
    .map((k) => env[k]?.trim())
    .filter((v): v is string => Boolean(v && v !== "/"))
    .map((v) => {
      const root = v.replace(/\/+$/, "");
      if (root === "~" || root.startsWith("~/")) {
        return posix.normalize(homedir() + root.slice(1));
      }
      return root.startsWith("/") ? posix.normalize(root) : root;
    });
}

/** Unicode spaces OpenClaw's path tools turn into a plain space. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
/** Any `scheme://` prefix (OpenClaw only understands `file://`). */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalise a path the way OpenClaw 2026.7.1's `write`, `edit` and `read`
 * tools resolve it (`expandPath`/`resolveToCwd`): drop one leading `@`, turn
 * unicode spaces into spaces, decode a `file://` URL with `fileURLToPath`
 * (which also decodes percent-escapes), expand `~`, then collapse `.` and
 * `..`. A relative result stays relative (the hook does not know the cwd).
 *
 * Returns `null` for a path that cannot be normalised (a bad file URL, any
 * other URL scheme, a NUL byte); callers send those to the Ask tier.
 */
export function normalizeOpenClawPath(
  raw: string,
  home: string = homedir(),
): string | null {
  if (raw.includes("\0")) return null;
  let p = (raw.startsWith("@") ? raw.slice(1) : raw).replace(
    UNICODE_SPACES,
    " ",
  );
  if (p.startsWith("file://")) {
    try {
      p = fileURLToPath(p);
    } catch {
      return null;
    }
    if (p.includes("\0")) return null;
  } else if (URL_SCHEME.test(p)) {
    return null;
  }
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = home + p.slice(1);
  if (p === "") return null;
  return posix.normalize(p);
}

/** True for a path inside the agent workspace (`<state>/workspace...`). */
function inWorkspace(rest: string | undefined): boolean {
  if (!rest) return false;
  const norm = posix.normalize(rest);
  return (
    /^\/workspace(?:[\w.-]*)(?:\/|$)/.test(norm) && !/\/\.\.(\/|$)/.test(norm)
  );
}

/**
 * Could an exec with this `workdir` run inside the agent workspace (which
 * sits in the state directory)? True for no workdir, a relative or
 * unresolvable one, and any path in a state directory or control root.
 */
function mayRunInWorkspace(workdir: string, roots: readonly string[]): boolean {
  if (!workdir) return true;
  const norm = normalizeOpenClawPath(workdir);
  if (norm === null || !norm.startsWith("/")) return true;
  const segs = norm.toLowerCase().split("/");
  if (segs.some((s) => STATE_DIR_NAMES.has(s))) return true;
  const lower = norm.toLowerCase();
  return roots.some((root) => {
    const r = posix.normalize(root).toLowerCase();
    return lower === r || lower.startsWith(`${r}/`);
  });
}

/** Does `text` (a command or a path) reach OpenClaw's control plane? */
function touchesControlPlane(
  text: string,
  roots: readonly string[],
  isPath = false,
): boolean {
  if (OPENCLAW_CONTROL_TEXT.test(text)) return true;
  if (!isPath) {
    // Shell quoting and escapes do not change the word that runs
    // (`"openclaw"`, `o'p'enclaw`, `open\claw`), so match it without them.
    const bare = text.replace(/['"\\]/g, "");
    for (const t of [text, bare]) {
      if (OPENCLAW_CLI.test(t) || GUARDIAN_CONFIG_TEXT.test(t)) return true;
    }
  }
  for (const m of text.matchAll(STATE_DIR_REF)) {
    if (!inWorkspace(m[1])) return true;
  }
  // Control roots are matched case-insensitively: on macOS (APFS) a
  // differently-cased path names the same directory.
  const lower = text.toLowerCase();
  for (const root of roots) {
    const r = root.toLowerCase();
    let at = lower.indexOf(r);
    while (at !== -1) {
      const rest = /^[^\s'"`;|&<>()]*/.exec(text.slice(at + r.length))![0];
      if (rest === "" || rest.startsWith("/")) {
        if (!inWorkspace(rest)) return true;
      }
      at = lower.indexOf(r, at + 1);
    }
  }
  if (isPath) {
    // A relative path that climbs out of the workspace can reach the state
    // directory (`../openclaw.json`, `../extensions/...`).
    const norm = posix.normalize(text.replace(/\\/g, "/"));
    if (!norm.startsWith("/") && (norm === ".." || norm.startsWith("../"))) {
      return true;
    }
  }
  return false;
}

/** Does a normalised path (see `normalizeOpenClawPath`) reach the control plane? */
function normalizedPathTouches(
  norm: string,
  roots: readonly string[],
): boolean {
  if (OPENCLAW_CONTROL_TEXT.test(norm)) return true;
  if (!norm.startsWith("/") && (norm === ".." || norm.startsWith("../"))) {
    return true;
  }
  const segs = norm.split("/");
  for (let i = 0; i < segs.length; i++) {
    if (!STATE_DIR_NAMES.has(segs[i]!.toLowerCase())) continue;
    const rest = segs.slice(i + 1).join("/");
    if (!inWorkspace(rest ? `/${rest}` : undefined)) return true;
  }
  const lower = norm.toLowerCase();
  for (const root of roots) {
    const r = (
      root.startsWith("/") ? posix.normalize(root) : root
    ).toLowerCase();
    if (lower === r || lower.startsWith(`${r}/`)) {
      if (!inWorkspace(norm.slice(r.length) || undefined)) return true;
    }
  }
  return false;
}

/**
 * Where a tool's path argument lands, for governing it. `control` is true
 * when the raw string or its OpenClaw-normalised form reaches the control
 * plane, or when it cannot be normalised at all (fail closed).
 */
function classifyPath(
  raw: string,
  roots: readonly string[],
): { control: boolean; unresolved: boolean; resolved?: string } {
  const norm = normalizeOpenClawPath(raw);
  if (norm === null) return { control: true, unresolved: true };
  return {
    control:
      touchesControlPlane(raw, roots, true) ||
      normalizedPathTouches(norm, roots),
    unresolved: false,
    ...(norm !== raw ? { resolved: norm } : {}),
  };
}

function controlCall(
  operation: string,
  target: Record<string, unknown>,
  summary: string,
): GovernedCall {
  return {
    toolName: "shell_destructive",
    arguments: { operation, ...target, touches: "openclaw-control-plane" },
    summary: `${summary} (OpenClaw config, state or plugins)`,
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A field Guardian decides on must be the string that will run. Anything
 * else is refused (the handler turns the throw into a block).
 */
function required(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
}

function bounded(text: string, max = MAX_TEXT): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

function digest(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** A Guardian tool name for a tool OpenClaw (or a plugin) provides. */
export function openclawToolName(tool: string): HookToolName {
  const part =
    tool
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "x$1") || "x";
  return `openclaw.${part}`.slice(0, 64).replace(/[._-]+$/, "") as HookToolName;
}

function shellCall(
  command: string,
  extra: Record<string, unknown>,
  verb = "Run",
  roots: readonly string[] = [],
): GovernedCall {
  const toolName =
    CREDENTIAL_PROBE.test(command) ||
    touchesControlPlane(command, roots) ||
    createsLink(command)
      ? "shell_destructive"
      : classifyCommand(command);
  return {
    toolName,
    arguments: { command: bounded(command), ...extra },
    summary: `${verb}: ${bounded(command, 160)}`,
  };
}

function hexByte(raw: string): string {
  const t = raw.trim().replace(/^0x/i, "");
  return /^[0-9a-f]{1,2}$/i.test(t)
    ? String.fromCharCode(parseInt(t, 16))
    : `<hex:${raw}>`;
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new TypeError(`${field} must be a list of strings`);
  }
  return value as string[];
}

/**
 * The exact input a `process` action writes. Fields the action does not use
 * are refused, so the approver never sees a decoy instead of the payload.
 */
function processInput(action: string, p: Record<string, unknown>): string {
  const used = PROCESS_INPUT_FIELDS[action]!;
  for (const field of INPUT_FIELDS) {
    if (p[field] !== undefined && !used.includes(field)) {
      throw new TypeError(`process ${action} does not use ${field}`);
    }
  }
  const text = (field: string) =>
    p[field] === undefined ? "" : required(p[field], field);
  switch (action) {
    case "write":
      return text("data");
    case "paste":
      return text("text");
    case "send-keys":
      return (
        text("literal") +
        stringList(p.hex, "hex").map(hexByte).join("") +
        stringList(p.keys, "keys")
          .map((k) => `<${k}>`)
          .join("")
      );
    default:
      return "\r";
  }
}

/**
 * Paths an apply_patch envelope touches (`*** Add/Update/Delete File:`).
 * OpenClaw trims each line before reading a header, so leading whitespace
 * is accepted.
 */
export function patchPaths(input: string): {
  path: string;
  operation: string;
}[] {
  const out: { path: string; operation: string }[] = [];
  const re =
    /^[^\S\n]*\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$|^[^\S\n]*\*\*\* Move to:\s*(.+?)\s*$/gm;
  for (const m of input.matchAll(re)) {
    if (m[3]) out.push({ operation: "move", path: m[3] });
    else out.push({ operation: m[1]!.toLowerCase(), path: m[2]! });
  }
  return out.slice(0, 50);
}

/**
 * `null` = not governed (a read-only tool). Everything else returns the
 * Guardian call to make.
 */
export function governOpenClawCall(
  call: OpenClawToolCall,
): GovernedCall | null {
  const tool = call.toolName.trim().toLowerCase();
  const p = call.params ?? {};
  const roots = call.controlRoots ?? [];

  // Code Mode's exec runs JavaScript in OpenClaw's QuickJS sandbox, not a
  // shell; tools it calls are governed one by one. Govern the script itself
  // as its own Guardian tool so the receipt says what it was.
  if (call.toolKind === "code_mode_exec") {
    const code = required(p.code ?? p.command, "code");
    return {
      toolName: openclawToolName("code_mode_exec"),
      arguments: {
        language: str(p.language) || "javascript",
        code: bounded(code),
        codeBytes: Buffer.byteLength(code),
        codeDigest: digest(code),
      },
      summary: `Run Code Mode script: ${bounded(code, 160)}`,
    };
  }

  if (tool === "read") {
    const path = str(p.path) || str(p.file_path) || str(p.filePath);
    const norm = normalizeOpenClawPath(path);
    if (norm === null && path !== "") {
      return {
        toolName: "shell_destructive",
        arguments: { operation: "read", path: bounded(path, 500) },
        summary: `Read ${bounded(path, 160)} (a path Guardian could not resolve)`,
      };
    }
    if (!CREDENTIAL_PROBE.test(path) && !CREDENTIAL_PROBE.test(norm ?? "")) {
      return null;
    }
    return {
      toolName: "shell_destructive",
      arguments: {
        operation: "read",
        path: bounded(path, 500),
        ...(norm && norm !== path ? { resolvedPath: bounded(norm, 500) } : {}),
      },
      summary: `Read ${bounded(path, 160)} (a process environment)`,
    };
  }
  if (READ_ONLY_TOOLS.has(tool)) return null;

  if (tool === "exec" || tool === "bash") {
    const extra: Record<string, unknown> = {};
    const workdir = str(p.workdir) || str(p.cwd);
    if (workdir) extra.cwd = workdir;
    // Env overrides change what a command does; values may be secrets, so
    // the approver sees the names and a digest, never the values.
    if (p.env && typeof p.env === "object") {
      extra.envKeys = Object.keys(p.env as object).slice(0, 50);
      extra.envDigest = digest(p.env);
    }
    for (const key of ["host", "elevated", "background", "pty"] as const) {
      if (p[key] !== undefined) extra[key] = p[key];
    }
    const command = required(p.command, "command");
    const shell = shellCall(command, extra, "Run", roots);
    // With no workdir (or a relative one, or one inside a workspace) the
    // command may run in `<state>/workspace`, where `..` is the state
    // directory. Backstop only: see integrity.ts.
    if (climbsOut(command) && mayRunInWorkspace(workdir, roots)) {
      return {
        ...shell,
        toolName: "shell_destructive",
        arguments: { ...shell.arguments, touches: "openclaw-control-plane" },
      };
    }
    // A command run from inside the state directory reaches it with
    // relative paths (`rm -rf extensions/guardian`).
    if (workdir && classifyPath(workdir, roots).control) {
      return {
        ...shell,
        toolName: "shell_destructive",
        arguments: { ...shell.arguments, touches: "openclaw-control-plane" },
      };
    }
    // Env overrides can change what any command does (`bash -c "$X"`,
    // BASH_ENV, LD_PRELOAD, GIT_*), and the approver cannot see the values.
    // An exec that carries any is never on the everyday tier.
    const hasEnv =
      p.env !== undefined &&
      (typeof p.env !== "object" ||
        p.env === null ||
        Object.keys(p.env).length > 0);
    if (hasEnv && tierOf(shell.toolName) === "allow") {
      return { ...shell, toolName: "shell_destructive" };
    }
    return shell;
  }

  if (tool === "process") {
    const action = str(p.action).toLowerCase();
    if (PROCESS_READ_ACTIONS.has(action)) return null;
    const sessionId = str(p.sessionId);
    if (Object.hasOwn(PROCESS_INPUT_FIELDS, action)) {
      // Input to a running process (often an interactive shell started by
      // a plain `exec bash`) can be split across calls, so no single chunk
      // shows what it adds up to. It is never on the everyday tier: a
      // consequential chunk keeps its own name, anything else is
      // `openclaw.process_input` (Ask tier).
      const typed = processInput(action, p);
      const shell = shellCall(
        typed,
        { process: action, sessionId },
        "Type into background process",
        roots,
      );
      return tierOf(shell.toolName) === "allow"
        ? { ...shell, toolName: openclawToolName("process_input") }
        : shell;
    }
    if (action === "kill" || action === "remove" || action === "clear") {
      return {
        toolName: "shell",
        arguments: { process: action, sessionId },
        summary: `Stop background command ${sessionId}`,
      };
    }
    // Unknown action: Ask tier.
  }

  if (tool === "write" || tool === "edit") {
    const path = required(p.path ?? p.file_path ?? p.filePath, "path");
    const { path: _p, file_path: _f, filePath: _fp, ...rest } = p;
    const body = JSON.stringify(rest);
    const where = classifyPath(path, roots);
    if (where.control) {
      return controlCall(
        tool,
        {
          path: bounded(path, 500),
          ...(where.resolved
            ? { resolvedPath: bounded(where.resolved, 500) }
            : {}),
          ...(where.unresolved ? { pathUnresolved: true } : {}),
          contentBytes: Buffer.byteLength(body),
          contentDigest: digest(body),
        },
        `${tool === "write" ? "Write" : "Edit"} ${bounded(path, 160)}`,
      );
    }
    return {
      toolName: "file_write",
      arguments: {
        operation: tool,
        path: bounded(path, 500),
        ...(where.resolved
          ? { resolvedPath: bounded(where.resolved, 500) }
          : {}),
        contentBytes: Buffer.byteLength(body),
        contentDigest: digest(body),
      },
      summary: `${tool === "write" ? "Write" : "Edit"} ${bounded(path, 160)}`,
    };
  }

  if (tool === "apply_patch") {
    const input = required(p.input ?? p.patch, "input");
    const files = patchPaths(input);
    const paths = files.length
      ? files.map((f) => f.path)
      : [...(call.derivedPaths ?? [])].slice(0, 50);
    const all = [...paths, ...(call.derivedPaths ?? [])];
    return {
      toolName: all.some((path) => classifyPath(path, roots).control)
        ? "shell_destructive"
        : "file_write",
      arguments: {
        operation: "apply_patch",
        files: files.length ? files : paths.map((path) => ({ path })),
        contentBytes: Buffer.byteLength(input),
        contentDigest: digest(input),
      },
      summary: `Patch ${paths.length} file(s): ${bounded(paths.join(", "), 160)}`,
    };
  }

  if (tool === "web_fetch") {
    // Same shape as Claude Code's WebFetch.
    return governedCall({
      tool: "WebFetch",
      input: { url: required(p.url, "url") },
    });
  }

  // MCP tools arrive namespaced `server__tool` (e.g. composio__GMAIL_SEND_EMAIL).
  const mcp = /^([^_].*?)__(.+)$/.exec(call.toolName.trim());
  if (mcp) {
    const [, server, name] = mcp as unknown as [string, string, string];
    const json = JSON.stringify(p);
    return {
      toolName: mcpToolName(server, name),
      arguments:
        json.length <= MAX_TEXT
          ? { server, tool: name, input: p }
          : {
              server,
              tool: name,
              inputBytes: json.length,
              inputDigest: digest(json),
            },
      summary: `MCP ${server} → ${name}`,
    };
  }

  // message, browser, sessions_spawn, subagents, sessions_send, cron,
  // gateway, nodes, canvas, code_execution, tool_call, media generation,
  // plugin tools, and anything new: governed on the Ask tier.
  const json = JSON.stringify(p);
  return {
    toolName: openclawToolName(call.toolName.trim() || "unknown"),
    arguments:
      json.length <= MAX_TEXT
        ? { tool: call.toolName, input: p }
        : {
            tool: call.toolName,
            inputBytes: json.length,
            inputDigest: digest(json),
          },
    summary: `OpenClaw ${call.toolName}${str(p.action) ? ` (${bounded(str(p.action), 40)})` : ""}`,
  };
}
