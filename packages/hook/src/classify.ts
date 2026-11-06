/**
 * Maps a coding agent's tool call to the Guardian tool it is governed as.
 *
 * The mapping only *routes* a call to a tool name; it never decides. Each
 * name is a record-only tool on one Guardian tool-server connection, and
 * the human sets its mode (Allow / Ask / Deny) in the Guardian console.
 * Splitting shell commands by consequence is what lets `ls` run under Allow
 * while `terraform apply` waits for a phone approval.
 */
import { createHash } from "node:crypto";

/** Tool names the hook proposes. Register these once in the console. */
export const HOOK_TOOLS = [
  {
    name: "shell",
    suggestedMode: "allow",
    description: "Ordinary shell commands (build, test, read-only inspection).",
  },
  {
    name: "shell_deploy",
    suggestedMode: "ask",
    description:
      "Infrastructure and deploy commands: terraform/tofu apply or destroy, pulumi up, kubectl apply/delete, helm install/upgrade, cdk/serverless/fly/vercel deploys, cloud deploy CLIs.",
  },
  {
    name: "shell_destructive",
    suggestedMode: "ask",
    description:
      "Destructive commands: rm -rf, git reset --hard, git clean, force pushes, dropping databases, disk formatting.",
  },
  {
    name: "git_push",
    suggestedMode: "ask",
    description: "Pushing commits to a remote.",
  },
  {
    name: "shell_session",
    suggestedMode: "ask",
    description:
      "Starting an interactive shell, interpreter or remote session (bash, python, ssh, docker exec -it). What is typed into it later is not seen by Guardian.",
  },
  {
    name: "file_write",
    suggestedMode: "allow",
    description: "Creating or editing files in the workspace.",
  },
  {
    name: "web_fetch",
    suggestedMode: "allow",
    description: "Fetching a URL.",
  },
] as const;

export type HookToolName =
  | (typeof HOOK_TOOLS)[number]["name"]
  | `mcp.${string}`;

export type GovernedCall = Readonly<{
  toolName: HookToolName;
  /** What the approver sees. Bounded; file contents are digested, not sent. */
  arguments: Record<string, unknown>;
  /** One-line plain-words summary for the approval prompt. */
  summary: string;
}>;

const MAX_COMMAND = 2_000;

// Patterns err toward the Ask tools: a false match costs one approval; a
// miss lets a consequential command run under the ordinary shell mode.
const DEPLOY = [
  /\b(terraform|tofu)\b.*\s(apply|destroy|import|state\s+(rm|mv|push))\b/,
  /\bpulumi\s+(up|destroy|update)\b/,
  /\bkubectl\b.*\s(apply|delete|create|replace|patch|scale|rollout|drain|cordon)\b/,
  /\bhelm\s+(install|upgrade|uninstall|rollback|delete)\b/,
  /\b(cdk|serverless|sls|sam)\s+(deploy|destroy|remove)\b/,
  /\bfly(ctl)?\s+(deploy|destroy|apps\s+destroy|scale)\b/,
  /\bvercel\b.*(--prod\b|\bdeploy\b|\bpromote\b|\bremove\b)/,
  /\bnetlify\s+deploy\b.*--prod\b/,
  /\bgcloud\s+.*\b(deploy|delete)\b/,
  /\baws\s+.*\b(deploy|delete-stack|create-stack|update-stack|terminate-instances|delete-db-instance)\b/,
  /\baz\s+.*\b(deploy|delete|create)\b/,
  /\bwrangler\s+(deploy|publish|delete)\b/,
  /\bdocker\s+(push|compose\s+.*\bup\b.*--remote)\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\btwine\s+upload\b/,
  /\bgh\s+(release\s+create|workflow\s+run|pr\s+merge)\b/,
];

const DESTRUCTIVE = [
  /\brm\s+(?:-\S*[rR]\S*\s+(?:-\S+\s+)*|-\S*f\S*\s+-\S*[rR])/,
  /\bgit\s+reset\s+.*--hard\b/,
  /\bgit\s+clean\s+-\S*f/,
  /\bgit\s+push\b.*(\s--force\b|\s-f\b|--force-with-lease|\s\+\S)/,
  /\bgit\s+(branch\s+-D|checkout\s+--\s|restore\s+--source)\b/,
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
  /\bdelete\s+from\s+\w+\s*(;|$)/i,
  /\b(mkfs|dd\s+if=|shred|wipefs)\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bfind\b.*\s-delete\b/,
];

const GIT_PUSH = /\bgit\s+push\b/;

/** Shells and interpreters that read commands from stdin when given no script. */
const INTERPRETERS = new Set(
  (
    "sh bash zsh dash ksh mksh csh tcsh fish ash pwsh powershell python " +
    "python2 python3 ipython node nodejs deno bun ruby irb perl php lua " +
    "luajit r julia ghci scala groovysh jshell tclsh wish expect su login " +
    "tmux screen script"
  ).split(" "),
);

/** Clients that open a session unless given the statements to run. */
const DB_CLIENTS = new Set(
  "psql mysql mariadb mongo mongosh cqlsh sqlplus clickhouse-client".split(" "),
);
const DB_INLINE = /^(-c|-e|-f|--command|--execute|--file|--eval|--query)(=|$)/;

/** Network pipes: whatever is typed goes to the other end. */
const NET_PIPES = new Set("telnet nc ncat netcat socat openssl".split(" "));

/** Options that take a value, per launcher (so their value is not a positional). */
const SSH_VALUE_OPTS = new Set(
  "-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w".split(" "),
);
const SUDO_VALUE_OPTS = new Set("-u -g -U -C -D -h -p -r -t -T".split(" "));
const REDIS_VALUE_OPTS = new Set("-h -p -a -n -u --user --pass".split(" "));

/** Wrappers that run the next word as the command. */
const WRAPPERS = new Set(
  "exec command builtin nohup time env stdbuf nice ionice".split(" "),
);

function positionals(args: readonly string[], valueOpts: Set<string>) {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueOpts.has(a)) i++;
    else if (!a.startsWith("-")) out.push(a);
  }
  return out;
}

/**
 * True when one simple command starts something that keeps reading what is
 * typed into it: a bare shell or interpreter (no script, no `-c`), one given
 * `-i` or `-s`, `sudo -i`/`-s`, `ssh host` with no remote command, a database
 * client with no statement, a network pipe (`nc`, `telnet`), or
 * `docker|podman|kubectl exec|run -i…`. Codex's `write_stdin` and dsh's
 * `terminal_send`-style transports send later input without another hook
 * call, so the start of the session is the last point Guardian sees.
 */
function startsSession(segment: string): boolean {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let wrapped = false;
  while (words.length > 0) {
    const w = words[0]!;
    if (
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) ||
      WRAPPERS.has(w) ||
      (wrapped && w.startsWith("-"))
    ) {
      wrapped ||= WRAPPERS.has(w);
      words.shift();
      continue;
    }
    break;
  }
  if (words.length === 0) return false;
  const base = (words[0]!.split(/[\\/]/).pop() ?? "")
    .replace(/^['"]+|['"]+$/g, "")
    .toLowerCase()
    .replace(/\.exe$/, "");
  const args = words.slice(1);
  if (args.some((a) => /^(--version|-V|--help)$/.test(a))) {
    return false;
  }
  if (base === "sudo" || base === "doas" || base === "busybox") {
    if (base !== "busybox" && args.some((a) => /^-[a-zA-Z]*[is]$/.test(a))) {
      return true;
    }
    const rest = positionals(args, SUDO_VALUE_OPTS);
    if (rest.length === 0) return false;
    return startsSession(args.slice(args.indexOf(rest[0]!)).join(" "));
  }
  if (base === "ssh" || base === "mosh") {
    if (args.some((a) => /^-[a-zA-Z]*t/.test(a))) return true;
    return positionals(args, SSH_VALUE_OPTS).length <= 1;
  }
  if (["docker", "podman", "nerdctl", "kubectl", "oc"].includes(base)) {
    if (!args.some((a) => ["exec", "run", "attach", "debug"].includes(a))) {
      return false;
    }
    return (
      args.includes("attach") ||
      args.some((a) =>
        /^(-[a-zA-Z]*i[a-zA-Z]*|--interactive|--stdin)(=true)?$/.test(a),
      )
    );
  }
  if (DB_CLIENTS.has(base)) {
    return !args.some((a) => DB_INLINE.test(a)) && !segment.includes("<");
  }
  if (base === "sqlite3") {
    return positionals(args, new Set(["-cmd"])).length <= 1;
  }
  if (base === "redis-cli") {
    return positionals(args, REDIS_VALUE_OPTS).length === 0;
  }
  if (NET_PIPES.has(base)) {
    return base === "openssl"
      ? args[0] === "s_client"
      : !args.some((a) => /^-[a-zA-Z]*z/.test(a));
  }
  if (!INTERPRETERS.has(base) && !/^python[0-9.]+$/.test(base)) return false;
  if ((base === "deno" || base === "bun") && args[0] === "repl") return true;
  // `bash -c 'bash'`: look inside the code a shell is given.
  const code = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
  if (code >= 0 && /sh$/.test(base)) {
    const inner = args
      .slice(code + 1)
      .join(" ")
      .replace(/['"]/g, " ");
    if (startsInteractiveSession(inner)) return true;
  }
  if (args.some((a) => /^(-[a-zA-Z]*[is][a-zA-Z]*|--interactive|-)$/.test(a))) {
    return true;
  }
  // Only options (no script, no -c / -e code): it reads commands from stdin.
  return args.every((a) => a.startsWith("-") && !/^-[a-zA-Z]*[ce]/.test(a));
}

/** Any simple command in the line (split on ; && || | & newlines, $( ) and backticks). */
export function startsInteractiveSession(command: string): boolean {
  // A loop that runs each line it reads: `while read l; do eval "$l"; done`.
  if (/\bwhile\s+(?:IFS=\S*\s+)?read\b/.test(command)) return true;
  return command
    .split(/&&|\|\||[;&|\n()]|\$\(|`/)
    .some((segment) => startsSession(segment));
}

export function classifyCommand(command: string): HookToolName {
  if (DESTRUCTIVE.some((re) => re.test(command))) return "shell_destructive";
  if (DEPLOY.some((re) => re.test(command))) return "shell_deploy";
  if (GIT_PUSH.test(command)) return "git_push";
  if (startsInteractiveSession(command)) return "shell_session";
  return "shell";
}

/** Guardian tool names: /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, ≤ 64 chars. */
export function mcpToolName(server: string, tool: string): HookToolName {
  const part = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "x$1") || "x";
  return `mcp.${part(server)}.${part(tool)}`
    .slice(0, 64)
    .replace(/[._-]+$/, "") as HookToolName;
}

function bounded(text: string, max = MAX_COMMAND): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Agent-neutral view of one tool call. `tool` is the name the agent's hook
 * reports: Claude Code's (Bash, Write, Edit, MultiEdit, NotebookEdit,
 * WebFetch, mcp__server__tool), Codex's (Bash, apply_patch, mcp__…) or
 * DeepSeek Harness's (bash, pwsh, write, edit, apply_patch,
 * str_replace_editor, terminal_send, web_fetch, mcp__…). All are recognised whichever agent
 * runs the hook; a name none of them uses is left to the agent.
 */
export type ToolCall = Readonly<{
  tool: string;
  input: Record<string, unknown>;
  cwd?: string;
}>;

/** Shell tools: the input field that carries the command. */
const SHELL_TOOLS: Readonly<Record<string, string>> = {
  Bash: "command", // Claude Code; Codex shell and unified exec
  shell: "command",
  bash: "command", // DeepSeek Harness (plain and persistent)
  pwsh: "command", // DeepSeek Harness on Windows
  terminal_send: "text", // DeepSeek Harness PTY: typed input runs as a command
};

/** File tools whose input is {file_path, content | new_string | …}. */
const FILE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "write", // DeepSeek Harness
  "edit", // DeepSeek Harness
]);

/** A command may arrive as a string or as argv (some exec tools). */
function commandText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.join(" ");
  }
  return "";
}

const MAX_PATHS = 50;

/**
 * The files a Codex `apply_patch` touches, read from its patch headers
 * (`*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`).
 * Only paths and operations are returned; the patch body is digested by the
 * caller, never sent.
 */
export function patchTargets(
  patch: string,
): { op: "add" | "update" | "delete" | "move"; path: string }[] {
  const targets: { op: "add" | "update" | "delete" | "move"; path: string }[] =
    [];
  const re =
    /^[ \t]*\*\*\* (Add File|Update File|Delete File|Move to): (.+?)[ \t\r]*$/gm;
  for (const m of patch.matchAll(re)) {
    const kind = m[1]!;
    const op =
      kind === "Add File"
        ? "add"
        : kind === "Update File"
          ? "update"
          : kind === "Delete File"
            ? "delete"
            : "move";
    targets.push({ op, path: m[2]! });
  }
  return targets;
}

function fileWrite(
  operation: string,
  path: string,
  content: string,
  cwd: { cwd?: string },
  summaryVerb: string,
): GovernedCall {
  return {
    toolName: "file_write",
    arguments: {
      operation,
      path,
      contentBytes: Buffer.byteLength(content),
      contentDigest: digest(content),
      ...cwd,
    },
    summary: `${summaryVerb} ${path}`,
  };
}

/** `null` = not governed (read-only tools are left to the agent). */
export function governedCall(call: ToolCall): GovernedCall | null {
  const { tool, input } = call;
  const cwd = call.cwd ? { cwd: call.cwd } : {};
  const shellField = Object.hasOwn(SHELL_TOOLS, tool)
    ? SHELL_TOOLS[tool]
    : undefined;
  if (shellField) {
    const command = commandText(input[shellField]);
    const toolName = classifyCommand(command);
    return {
      toolName,
      arguments: {
        command: bounded(command),
        ...(tool === "Bash" || tool === "shell" ? {} : { agentTool: tool }),
        ...cwd,
      },
      summary: `Run: ${bounded(command, 160)}`,
    };
  }
  if (FILE_TOOLS.has(tool)) {
    const path = str(input.file_path) || str(input.notebook_path);
    const content =
      str(input.content) ||
      str(input.new_string) ||
      str(input.new_source) ||
      (Array.isArray(input.edits) ? JSON.stringify(input.edits) : "");
    return fileWrite(
      tool,
      path,
      content,
      cwd,
      tool === "Write" || tool === "write" ? "Write" : "Edit",
    );
  }
  if (tool === "str_replace_editor") {
    // DeepSeek Harness: {command: view|create|str_replace|insert, path, …}.
    // Only `view` is read-only; anything else, known or not, is governed.
    if (input.command === "view") return null;
    const sub = str(input.command) || "unknown";
    const content = str(input.file_text) || str(input.new_str);
    return fileWrite(
      `str_replace_editor.${sub}`,
      str(input.path),
      content,
      cwd,
      sub === "create" ? "Write" : "Edit",
    );
  }
  if (tool === "apply_patch") {
    // Codex: the whole patch arrives in tool_input.command; dsh: in .input.
    const patch =
      commandText(input.command) || str(input.patch) || str(input.input);
    const targets = patchTargets(patch);
    const paths = [...new Set(targets.map((t) => t.path))];
    const shown = paths.slice(0, MAX_PATHS).map((p) => bounded(p, 500));
    return {
      toolName: "file_write",
      arguments: {
        operation: "apply_patch",
        path: shown[0] ?? "",
        paths: shown,
        ...(paths.length > MAX_PATHS
          ? { morePaths: paths.length - MAX_PATHS }
          : {}),
        operations: targets
          .slice(0, MAX_PATHS)
          .map((t) => `${t.op} ${bounded(t.path, 500)}`),
        contentBytes: Buffer.byteLength(patch),
        contentDigest: digest(patch),
        ...cwd,
      },
      summary:
        paths.length === 0
          ? "Apply a patch (no file headers found)"
          : paths.length === 1
            ? `Patch ${bounded(paths[0]!, 160)}`
            : `Patch ${paths.length} files: ${bounded(paths.join(", "), 160)}`,
    };
  }
  if (tool === "WebFetch" || tool === "web_fetch") {
    const url = str(input.url);
    return {
      toolName: "web_fetch",
      arguments: { url: bounded(url, 500) },
      summary: `Fetch ${bounded(url, 160)}`,
    };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) {
    const [, server, name] = mcp as unknown as [string, string, string];
    const json = JSON.stringify(input);
    return {
      toolName: mcpToolName(server, name),
      arguments:
        json.length <= MAX_COMMAND
          ? { server, tool: name, input }
          : {
              server,
              tool: name,
              inputBytes: json.length,
              inputDigest: digest(json),
            },
      summary: `MCP ${server} → ${name}`,
    };
  }
  return null;
}

/**
 * Guardian permissions are per connection (one mode per grant), not per
 * tool. So the hook sends the two risk tiers to two connections: Allow-tier
 * tools to one, Ask-tier tools (deploys, destructive, pushes, MCP) to the
 * other, and the human sets one mode on each.
 */
export function tierOf(toolName: HookToolName): "allow" | "ask" {
  const known = HOOK_TOOLS.find((t) => t.name === toolName);
  return known ? known.suggestedMode : "ask";
}
