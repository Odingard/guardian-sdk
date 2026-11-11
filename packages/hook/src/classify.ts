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

import { parseShell, type Parsed, type Word } from "./shell.js";

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
      "Destructive commands: rm -rf (also through xargs or find -exec), git reset --hard, git clean, force pushes and remote branch deletes, dropping databases, disk formatting, piping a download into a shell. Also changes to the agent's own MCP servers, hooks or permissions (claude mcp add, writes to .mcp.json or .claude/settings.json), and commands the hook cannot parse.",
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
  /\bdd\b.*\bof=/,
  /\brsync\b.*\s--(delete\S*|remove-source-files)\b/,
  /\btruncate\b.*(\s-s\s*0\b|\s--size[= ]0\b)/,
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

// ---------------------------------------------------------------------------
// Parsed routing. The command is read with `parseShell` (quotes, escapes,
// `;`/`&&`/`||`/`|`, subshells, substitutions, here-documents), wrappers are
// unwrapped (sudo, env, xargs, nice, nohup, time, timeout, `sh -c`, `eval`,
// `find -exec`, git global options and aliases), and the riskiest inner
// command decides. Text the parser cannot follow, and a command whose name
// is only known at run time (`$CMD`, `$(…)`), go to the Ask tier.

const RANK: Readonly<Record<string, number>> = {
  shell: 0,
  shell_session: 1,
  git_push: 2,
  shell_deploy: 3,
  shell_destructive: 4,
};
const BY_RANK = [
  "shell",
  "shell_session",
  "git_push",
  "shell_deploy",
  "shell_destructive",
] as const;
const ASK = RANK.shell_destructive!;
const MAX_DEPTH = 12;

/**
 * Files that set the agent's own MCP servers, hooks, permissions or
 * plugins (Claude Code, Codex, Cursor, Gemini CLI, DeepSeek Harness).
 */
const EDGE = String.raw`(?:^|[\s/\\'"=:,(~])`;
export const AGENT_CONFIG_PATH = new RegExp(
  [
    EDGE +
      String.raw`(?:\.?mcp\.json|\.claude\.json|settings\.local\.json|managed-settings\.json|managed-mcp\.json|claude_desktop_config\.json|guardian-hooks\.json|cordis\.patch\.ya?ml)(?![\w-])`,
    EDGE +
      String.raw`\.claude(?:[/\\](?:settings[^/\\\s'"]*\.json|hooks|agents|commands|skills|plugins|output-styles)(?![\w-])|[/\\]?(?=$|[\s'"]))`,
    EDGE + String.raw`\.(?:codex|cursor|gemini|dsh)(?=$|[/\\\s'"])`,
  ].join("|"),
  "i",
);

/** Commands that only read the paths they are given (writes are redirects). */
const READERS = new Set(
  (
    "cat tac less more head tail grep egrep fgrep zgrep rg ag ack ls dir " +
    "stat file wc diff cmp comm jq bat batcat md5sum sha1sum sha256sum " +
    "sha512sum shasum b2sum cksum echo printf test [ [[ find fd realpath " +
    "readlink dirname basename du tree type which"
  ).split(" "),
);
const GIT_READS = new Set(
  (
    "status log show diff blame ls-files grep add commit check-ignore " +
    "cat-file rev-parse ls-tree shortlog describe"
  ).split(" "),
);

const RESERVED = new Set(
  "if then else elif fi do done while until for in case esac ! { } select function".split(
    " ",
  ),
);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

const SHELLS = new Set(
  "sh bash zsh dash ksh mksh ash yash posh fish busybox".split(" "),
);
const FETCHERS = new Set(
  "curl wget fetch http https xh aria2c iwr irm invoke-webrequest invoke-restmethod".split(
    " ",
  ),
);
/** Deleting every file a `find` or `xargs` produces asks, with or without -r. */
const BULK_DELETE = new Set(["rm", "unlink", "shred"]);
const EVALUATORS = new Set(["eval", "source", ".", "iex", "invoke-expression"]);

type Spec = Readonly<{ value?: readonly string[]; positional?: number }>;

/** Wrappers that run the rest of their arguments as a command. */
const WRAPPER_SPECS: Readonly<Record<string, Spec>> = {
  nohup: {},
  command: {},
  builtin: {},
  chronic: {},
  unbuffer: {},
  busybox: {},
  time: { value: ["-f", "-o", "--format", "--output"] },
  nice: { value: ["-n", "--adjustment"] },
  ionice: { value: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"] },
  stdbuf: { value: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  timeout: { value: ["-s", "-k", "--signal", "--kill-after"], positional: 1 },
  exec: { value: ["-a"] },
  sudo: {
    value: [
      ...SUDO_VALUE_OPTS,
      "--user",
      "--group",
      "--host",
      "--prompt",
      "--chdir",
      "--role",
      "--type",
      "--close-from",
      "--other-user",
      "--command-timeout",
    ],
  },
  doas: { value: ["-u", "-C"] },
  xargs: {
    value: [
      "-a",
      "--arg-file",
      "-d",
      "--delimiter",
      "-E",
      "-I",
      "-L",
      "-n",
      "--max-args",
      "-P",
      "--max-procs",
      "-s",
      "--max-chars",
      "--process-slot-var",
      "--max-lines",
    ],
  },
  chroot: { value: ["--userspec", "--groups"], positional: 1 },
  taskset: { positional: 1 },
  flock: {
    value: ["-w", "-E", "--timeout", "--conflict-exit-code"],
    positional: 1,
  },
  setsid: {},
  caffeinate: { value: ["-t", "-w"] },
};

type Leaf = { rank: number; base: string; args: readonly string[] };

const leaf = (rank: number, base = "", args: readonly string[] = []): Leaf => ({
  rank,
  base,
  args,
});

function baseName(value: string): string {
  return (value.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
}

const literal = (value: string): Word => ({ value, dynamic: false, subs: [] });

/**
 * Skips a wrapper's options. Returns where its command starts and whether an
 * option it does not know was seen (its value might be the next word).
 */
function skipOptions(
  args: readonly Word[],
  spec: Spec,
): { start: number; unknown: boolean } {
  const value = new Set(spec.value ?? []);
  let i = 0;
  let unknown = false;
  while (i < args.length) {
    const a = args[i]!.value;
    if (a === "--") {
      i++;
      break;
    }
    if (a.startsWith("--")) {
      if (a.includes("=")) i++;
      else if (value.has(a)) i += 2;
      else {
        unknown = true;
        i++;
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      let takes = false;
      for (let k = 1; k < a.length; k++) {
        if (value.has(`-${a[k]}`)) {
          takes = k === a.length - 1; // otherwise the value is joined
          break;
        }
      }
      i += takes ? 2 : 1;
      continue;
    }
    break;
  }
  let positional = spec.positional ?? 0;
  while (positional-- > 0 && i < args.length) i++;
  return { start: i, unknown };
}

/** Rank of a command line given as text (a `sh -c` string, `eval` input). */
function rankText(text: string, depth: number): number {
  if (depth > MAX_DEPTH) return ASK;
  return rankParsed(parseShell(text), depth + 1);
}

function rankParsed(parsed: Parsed, depth: number): number {
  if (depth > MAX_DEPTH) return ASK;
  let rank = parsed.ambiguous ? ASK : 0;
  const stages = new Map<number, Leaf[]>();
  for (const cmd of parsed.commands) {
    const l = rankArgv(cmd.words, depth);
    rank = Math.max(rank, l.rank);
    // `> .mcp.json`, `>> .claude/settings.json`.
    if (cmd.writes.some((w) => AGENT_CONFIG_PATH.test(w.value))) rank = ASK;
    const subs = [
      ...cmd.subs,
      ...cmd.words.flatMap((w) => w.subs),
      ...cmd.writes.flatMap((w) => w.subs),
    ];
    for (const sub of subs) rank = Math.max(rank, rankParsed(sub, depth + 1));
    // `bash <(curl …)`, `sh -c "$(curl …)"`, `eval "$(curl …)"`.
    if (
      runsCode(l) &&
      cmd.words.some((w) => w.subs.some((s) => fetches(s, depth + 1)))
    ) {
      rank = ASK;
    }
    if (cmd.pipeline >= 0) {
      const list = stages.get(cmd.pipeline) ?? [];
      list.push(l);
      stages.set(cmd.pipeline, list);
    }
  }
  // `curl … | sh`: downloaded code run by a later stage of the pipeline.
  for (const list of stages.values()) {
    const first = list.findIndex((l) => FETCHERS.has(l.base));
    if (
      first >= 0 &&
      list.slice(first + 1).some((l) => readsCodeFromStdin(l))
    ) {
      rank = ASK;
    }
  }
  return rank;
}

function fetches(parsed: Parsed, depth: number): boolean {
  return parsed.commands.some(
    (c) =>
      FETCHERS.has(rankArgv(c.words, depth).base) ||
      [...c.subs, ...c.words.flatMap((w) => w.subs)].some((s) =>
        fetches(s, depth + 1),
      ),
  );
}

const isInterpreter = (base: string) =>
  INTERPRETERS.has(base) || /^python[0-9.]*$/.test(base);

function runsCode(l: Leaf): boolean {
  return EVALUATORS.has(l.base) || isInterpreter(l.base);
}

function readsCodeFromStdin(l: Leaf): boolean {
  if (EVALUATORS.has(l.base)) return true;
  if (!isInterpreter(l.base)) return false;
  const options: string[] = [];
  let script = false;
  for (const a of l.args) {
    if (a === "--") break;
    if (a === "-") return true;
    if (a.startsWith("-") || a.startsWith("+")) options.push(a);
    else {
      script = true;
      break;
    }
  }
  if (options.some((a) => /^-[a-zA-Z]*s[a-zA-Z]*$/.test(a))) return true;
  if (options.some((a) => /^-[a-zA-Z]*[cem][a-zA-Z]*$/.test(a))) return false;
  return !script;
}

/** One simple command after unwrapping. */
function rankArgv(words: readonly Word[], depth: number): Leaf {
  if (depth > MAX_DEPTH) return leaf(ASK);
  let i = 0;
  while (
    i < words.length &&
    (ASSIGNMENT.test(words[i]!.value) || RESERVED.has(words[i]!.value))
  ) {
    i++;
  }
  if (i >= words.length) return leaf(0);
  const head = words[i]!;
  const argWords = words.slice(i + 1);
  // The command name is only known at run time.
  if (head.dynamic) return leaf(ASK);
  const base = baseName(head.value);
  const args = argWords.map((w) => w.value);
  const joined = [base, ...args].join(" ");
  // Text patterns on the unquoted words (catches `"rm" -rf`, `r\m -rf`).
  let rank = 0;
  if (DESTRUCTIVE.some((re) => re.test(joined))) rank = ASK;
  else if (DEPLOY.some((re) => re.test(joined))) rank = RANK.shell_deploy!;
  const done = (r: number, b = base, a: readonly string[] = args) =>
    leaf(Math.max(rank, r), b, a);
  const inner = (from: readonly Word[]) => rankArgv(from, depth + 1);
  const pathCheck = (values: readonly string[]) =>
    values.some((v) => AGENT_CONFIG_PATH.test(v)) ? ASK : 0;

  if (base === "env") return done(rankEnv(argWords, depth));
  if (base === "sudoedit") return done(pathCheck(args));
  if (Object.hasOwn(WRAPPER_SPECS, base)) {
    if (base === "sudo" && args.some((a) => /^-[a-zA-Z]*e[a-zA-Z]*$/.test(a))) {
      return done(pathCheck(args)); // sudo -e: edit files
    }
    if (base === "command" && args.some((a) => /^-[a-zA-Z]*[vV]/.test(a))) {
      return done(0); // lookup only
    }
    if (base === "flock") {
      const c = args.findIndex((a) => a === "-c" || a === "--command");
      if (c >= 0) return done(rankText(args[c + 1] ?? "", depth));
    }
    const { start, unknown } = skipOptions(argWords, WRAPPER_SPECS[base]!);
    let rest = argWords.slice(start);
    if (base === "xargs" && rest.length === 0) rest = [literal("echo")];
    const l = inner(rest);
    // xargs feeds it operands nobody sees: deleting them in bulk asks.
    if (base === "xargs" && BULK_DELETE.has(l.base)) l.rank = ASK;
    const alt = unknown ? inner(argWords.slice(start + 1)).rank : 0;
    return leaf(Math.max(rank, l.rank, alt), l.base, l.args);
  }
  if (base === "watch") {
    const { start } = skipOptions(argWords, {
      value: ["-n", "--interval", "-d", "-q", "--equexit"],
    });
    return done(rankText(args.slice(start).join(" "), depth));
  }
  if (SHELLS.has(base)) {
    return done(rankShell(base, argWords, depth));
  }
  if (base === "su") {
    const c = args.findIndex((a) => /^(-c|--command)$/.test(a));
    const eq = args.find((a) => a.startsWith("--command="));
    if (c >= 0) return done(rankText(args[c + 1] ?? "", depth));
    if (eq) return done(rankText(eq.slice("--command=".length), depth));
    return done(0);
  }
  if (base === "eval" || base === "iex" || base === "invoke-expression") {
    return done(rankText(args.join(" "), depth));
  }
  if (base === "find") return done(rankFind(argWords, depth));
  if (["npx", "bunx", "pnpx", "npm", "pnpm", "yarn"].includes(base)) {
    const l = rankRunner(base, argWords, depth);
    if (l) return leaf(Math.max(rank, l.rank), l.base, l.args);
    return done(0);
  }
  if (base === "rm") {
    const recursive = argsBeforeDashDash(args).some(
      (a) => a === "--recursive" || /^-[a-zA-Z]*[rR]/.test(a),
    );
    return done(Math.max(recursive ? ASK : 0, pathCheck(args)));
  }
  if (base === "chmod") return done(Math.max(rankChmod(args), pathCheck(args)));
  if (base === "git") return done(rankGit(argWords, depth));
  if (base === "claude" || base === "codex" || base === "gemini") {
    return done(rankAgentCli(base, args));
  }
  if (READERS.has(base)) return done(0);
  return done(pathCheck(args));
}

function argsBeforeDashDash(args: readonly string[]): readonly string[] {
  const end = args.indexOf("--");
  return end < 0 ? args : args.slice(0, end);
}

function rankEnv(argWords: readonly Word[], depth: number): number {
  let i = 0;
  while (i < argWords.length) {
    const a = argWords[i]!.value;
    if (a === "--") {
      i++;
      break;
    }
    if (a === "-S" || a === "--split-string") {
      const text = [a, ...argWords.slice(i + 1).map((w) => w.value)]
        .slice(1)
        .join(" ");
      return rankText(text, depth);
    }
    if (a.startsWith("--split-string=") || /^-S./.test(a)) {
      const first = a.startsWith("--") ? a.slice(15) : a.slice(2);
      return rankText(
        [first, ...argWords.slice(i + 1).map((w) => w.value)].join(" "),
        depth,
      );
    }
    if (/^(-u|-C|-P|--unset|--chdir)$/.test(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      i++;
      continue;
    }
    break;
  }
  // rankArgv skips the NAME=value words that follow.
  return rankArgv(argWords.slice(i), depth + 1).rank;
}

function rankShell(
  base: string,
  argWords: readonly Word[],
  depth: number,
): number {
  let code = false;
  for (let i = 0; i < argWords.length; i++) {
    const a = argWords[i]!.value;
    if (a === "--") break;
    if (/^(--rcfile|--init-file|-o|\+o|-O|\+O)$/.test(a)) {
      i++;
      continue;
    }
    if (a === "--command" || (base === "fish" && a === "-c")) {
      return rankText(argWords[i + 1]?.value ?? "", depth);
    }
    if (/^[-+][a-zA-Z]+$/.test(a)) {
      if (/^-[a-zA-Z]*c/.test(a)) code = true;
      continue;
    }
    if (a.startsWith("-")) continue;
    // First operand: the code with -c, otherwise a script file.
    if (code) {
      if (base === "busybox")
        return rankArgv(argWords.slice(i), depth + 1).rank;
      return rankText(a, depth);
    }
    if (base === "busybox") return rankArgv(argWords.slice(i), depth + 1).rank;
    return 0;
  }
  return 0;
}

function rankFind(argWords: readonly Word[], depth: number): number {
  let rank = 0;
  for (let i = 0; i < argWords.length; i++) {
    const a = argWords[i]!.value;
    if (a === "-delete") rank = ASK;
    if (/^-(exec|execdir|ok|okdir)$/.test(a)) {
      let end = i + 1;
      while (
        end < argWords.length &&
        argWords[end]!.value !== ";" &&
        argWords[end]!.value !== "+"
      ) {
        end++;
      }
      const l = rankArgv(argWords.slice(i + 1, end), depth + 1);
      rank = Math.max(rank, BULK_DELETE.has(l.base) ? ASK : l.rank);
      i = end;
    }
    if (/^-f(print|print0|printf|ls)$/.test(a)) {
      if (AGENT_CONFIG_PATH.test(argWords[i + 1]?.value ?? "")) rank = ASK;
    }
  }
  return rank;
}

/** npx / bunx / npm exec / pnpm dlx / yarn dlx: route the package's command. */
function rankRunner(
  base: string,
  argWords: readonly Word[],
  depth: number,
): Leaf | null {
  let rest = argWords;
  if (base === "npm" || base === "pnpm" || base === "yarn") {
    const sub = rest[0]?.value;
    if (!["exec", "x", "dlx"].includes(sub ?? "")) return null;
    rest = rest.slice(1);
  }
  let i = 0;
  while (i < rest.length) {
    const a = rest[i]!.value;
    if (a === "--") {
      i++;
      break;
    }
    if (a === "-c" || a === "--call")
      return leaf(rankText(rest[i + 1]?.value ?? "", depth));
    if (a.startsWith("--call=")) return leaf(rankText(a.slice(7), depth));
    if (a === "-p" || a === "--package") {
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  const pkg = rest[i];
  if (!pkg) return null;
  if (pkg.dynamic) return leaf(ASK);
  const name =
    /^(?:@[^/]+\/)?([^@]+)(?:@.*)?$/.exec(pkg.value)?.[1] ?? pkg.value;
  const bin = name === "claude-code" ? "claude" : name;
  return rankArgv([literal(bin), ...rest.slice(i + 1)], depth + 1);
}

function rankChmod(args: readonly string[]): number {
  const opts = argsBeforeDashDash(args);
  const recursive = opts.some(
    (a) => a === "--recursive" || /^-[a-zA-Z]*R/.test(a),
  );
  if (!recursive) return 0;
  const modes = args.filter(
    (a) => !a.startsWith("-") || /^-[rwxXst]+$/.test(a),
  );
  const worldWritable = modes.some(
    (m) =>
      (/^0*[0-7]?[0-7]?[0-7]?[2367]$/.test(m) && m.length >= 3) ||
      /(^|,)[ugo]*[ao][ugo]*[+=][rwxXst]*w/.test(m),
  );
  return worldWritable ? ASK : 0;
}

const GIT_VALUE_OPTS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
  "--list-cmds",
  "--attr-source",
]);
/** Config keys whose value git runs as a command. */
const GIT_EXEC_KEY =
  /^(core\.(pager|editor|sshcommand|askpass|gitproxy)|pager\..+|sequence\.editor|.+\.(textconv|command|cmd|helper|program|clean|smudge|process|driver|tool)|credential\..*|uploadpack\.packobjectshook|gpg\..*program|.*\.(receivepack|uploadpack))$/i;

function rankGit(argWords: readonly Word[], depth: number): number {
  const args = argWords.map((w) => w.value);
  let rank = 0;
  const aliases = new Map<string, string>();
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (!a.startsWith("-")) break;
    let opt = a;
    let val: string | undefined;
    if (a.startsWith("--") && a.includes("=")) {
      opt = a.slice(0, a.indexOf("="));
      val = a.slice(a.indexOf("=") + 1);
      i++;
    } else if (GIT_VALUE_OPTS.has(a)) {
      val = args[i + 1] ?? "";
      if (argWords[i + 1]?.dynamic && (a === "-c" || a === "--config-env")) {
        rank = ASK;
      }
      i += 2;
    } else {
      i++;
    }
    if (opt === "-c" && val !== undefined) {
      const eq = val.indexOf("=");
      const key = (eq < 0 ? val : val.slice(0, eq)).toLowerCase();
      const value = eq < 0 ? "" : val.slice(eq + 1);
      if (key.startsWith("alias.")) aliases.set(key.slice(6), value);
      else if (key === "core.hookspath" || key === "core.fsmonitor") {
        if (!/^(false|0|no|off|)$/i.test(value)) rank = ASK;
      } else if (GIT_EXEC_KEY.test(key)) {
        rank = Math.max(rank, rankText(value, depth));
      }
    }
    if (opt === "--config-env" && val !== undefined) {
      const key = val.split("=")[0]!.toLowerCase();
      if (
        key.startsWith("alias.") ||
        GIT_EXEC_KEY.test(key) ||
        /hookspath|fsmonitor/.test(key)
      ) {
        rank = ASK; // value comes from the environment
      }
    }
  }
  if (i >= args.length) return rank;
  if (argWords[i]!.dynamic) return ASK;
  const sub = args[i]!;
  const rest = args.slice(i + 1);
  const alias = aliases.get(sub.toLowerCase());
  if (alias !== undefined) {
    if (alias.startsWith("!")) {
      return Math.max(
        rank,
        rankText(`${alias.slice(1)} ${rest.join(" ")}`, depth),
      );
    }
    const expanded = parseShell(alias);
    const aliasWords = expanded.commands[0]?.words ?? [];
    return Math.max(
      rank,
      expanded.ambiguous ? ASK : 0,
      rankGit([...aliasWords, ...argWords.slice(i + 1)], depth + 1),
    );
  }
  const opts = argsBeforeDashDash(rest);
  const has = (...names: string[]) =>
    opts.some((a) => names.includes(a.split("=")[0]!));
  const short = (letter: string) =>
    opts.some((a) => new RegExp(`^-[a-zA-Z]*${letter}`).test(a));
  let sr = 0;
  switch (sub) {
    case "push": {
      const forced =
        has(
          "--force",
          "--force-with-lease",
          "--force-if-includes",
          "--mirror",
          "--delete",
          "--prune",
        ) ||
        opts.some(
          (a) => /^-[a-zA-Z]+$/.test(a) && /[fd]/.test(a.replace(/o.*$/, "")),
        ) ||
        rest.some((a) => /^[+:]/.test(a));
      sr = forced ? ASK : RANK.git_push!;
      break;
    }
    case "reset":
      sr = has("--hard", "--merge") ? ASK : 0;
      break;
    case "clean":
      sr = has("--force") || short("f") ? ASK : 0;
      break;
    case "branch":
      sr =
        short("D") ||
        ((has("--delete") || short("d")) && (has("--force") || short("f")))
          ? ASK
          : 0;
      break;
    case "checkout":
      sr = rest.includes("--") || has("--force") || short("f") ? ASK : 0;
      break;
    case "switch":
      sr = has("--discard-changes", "--force") || short("f") ? ASK : 0;
      break;
    case "restore":
      sr = has("--source") || short("s") ? ASK : 0;
      break;
    case "stash":
      sr = ["drop", "clear"].includes(rest[0] ?? "") ? ASK : 0;
      break;
    case "update-ref":
      sr = short("d") ? ASK : 0;
      break;
    case "reflog":
      sr = ["expire", "delete"].includes(rest[0] ?? "") ? ASK : 0;
      break;
    case "filter-branch":
    case "filter-repo":
      sr = ASK;
      break;
  }
  if (!GIT_READS.has(sub) && rest.some((a) => AGENT_CONFIG_PATH.test(a)))
    sr = ASK;
  return Math.max(rank, sr);
}

const AGENT_CONFIG_SUBCOMMANDS = new Set([
  "mcp",
  "plugin",
  "plugins",
  "config",
]);
const AGENT_READ_ACTIONS = new Set([
  "list",
  "ls",
  "get",
  "show",
  "serve",
  "help",
  "--help",
  "-h",
]);
/** Options that hand a nested agent more tools or permissions. */
const AGENT_WIDENING_OPTS =
  /^(--mcp-config|--settings|--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--allowed-tools|--allowedtools|--add-dir|--plugin-dir|--dangerously-bypass-approvals-and-sandbox|--yolo|--config)(=|$)/i;

function rankAgentCli(base: string, args: readonly string[]): number {
  if (args.some((a) => AGENT_WIDENING_OPTS.test(a))) return ASK;
  if (base === "codex" && args.includes("-c")) return ASK;
  const mode = args.findIndex((a) => a === "--permission-mode");
  const modeValue =
    mode >= 0
      ? args[mode + 1]
      : args.find((a) => a.startsWith("--permission-mode="))?.slice(18);
  if (modeValue !== undefined && !/^(default|plan)$/i.test(modeValue))
    return ASK;
  const positionals = args.filter((a) => !a.startsWith("-"));
  const sub = positionals.findIndex((p) => AGENT_CONFIG_SUBCOMMANDS.has(p));
  if (sub < 0) return 0;
  const action = positionals[sub + 1];
  if (action === undefined || AGENT_READ_ACTIONS.has(action)) return 0;
  return ASK;
}

export function classifyCommand(command: string): HookToolName {
  let rank = 0;
  if (DESTRUCTIVE.some((re) => re.test(command))) rank = ASK;
  else if (DEPLOY.some((re) => re.test(command))) rank = RANK.shell_deploy!;
  else if (GIT_PUSH.test(command)) rank = RANK.git_push!;
  else if (startsInteractiveSession(command)) rank = RANK.shell_session!;
  if (rank < ASK) rank = Math.max(rank, rankText(command, 0));
  return BY_RANK[rank]!;
}

/** True when a file path is agent MCP, hook, permission or plugin config. */
export function isAgentConfigPath(path: string): boolean {
  return AGENT_CONFIG_PATH.test(path);
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

const AGENT_CONFIG_NOTE = "(agent MCP, hook, permission or plugin config)";

function fileWrite(
  operation: string,
  path: string,
  content: string,
  cwd: { cwd?: string },
  summaryVerb: string,
): GovernedCall {
  // Editing the agent's own MCP servers, hooks or permissions changes what
  // it may do next, so it goes to the Ask tier like other consequential calls.
  const config = isAgentConfigPath(path);
  return {
    toolName: config ? "shell_destructive" : "file_write",
    arguments: {
      operation,
      path,
      contentBytes: Buffer.byteLength(content),
      contentDigest: digest(content),
      ...(config ? { touches: "agent-config" } : {}),
      ...cwd,
    },
    summary: `${summaryVerb} ${path}${config ? ` ${AGENT_CONFIG_NOTE}` : ""}`,
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
    const config = paths.some((p) => isAgentConfigPath(p));
    return {
      toolName: config ? "shell_destructive" : "file_write",
      arguments: {
        operation: "apply_patch",
        ...(config ? { touches: "agent-config" } : {}),
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
        (paths.length === 0
          ? "Apply a patch (no file headers found)"
          : paths.length === 1
            ? `Patch ${bounded(paths[0]!, 160)}`
            : `Patch ${paths.length} files: ${bounded(paths.join(", "), 160)}`) +
        (config ? ` ${AGENT_CONFIG_NOTE}` : ""),
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
