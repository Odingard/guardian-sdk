// Generated file — do not edit.
import { z } from "zod";

import {
  apiEndpointWithinAllowlist,
  canonicalizeApiRequestUrl,
} from "./api.js";
import { ConnectionIdSchema } from "./identifiers.js";

export const LOCAL_EXEC_PARAMETERS_SCHEMA_ID =
  "odingard.guardian.local.exec.v1";
export const LOCAL_EGRESS_PARAMETERS_SCHEMA_ID =
  "odingard.guardian.local.egress.v1";
export const LOCAL_BROWSE_PARAMETERS_SCHEMA_ID =
  "odingard.guardian.local.browse.v1";

export const LocalExecParametersV1Schema = z
  .object({
    schema: z.literal(LOCAL_EXEC_PARAMETERS_SCHEMA_ID),
    connectionId: ConnectionIdSchema,
    command: z.string().min(1).max(8_192),
    cwd: z.string().min(1).max(4_096).optional(),
  })
  .strict();
export type LocalExecParametersV1 = z.infer<typeof LocalExecParametersV1Schema>;

export const LocalEgressParametersV1Schema = z
  .object({
    schema: z.literal(LOCAL_EGRESS_PARAMETERS_SCHEMA_ID),
    connectionId: ConnectionIdSchema,
    url: z.string().min(1).max(4_096),
    method: z
      .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
      .default("GET"),
  })
  .strict();
export type LocalEgressParametersV1 = z.infer<
  typeof LocalEgressParametersV1Schema
>;

export const LocalBrowseParametersV1Schema = z
  .object({
    schema: z.literal(LOCAL_BROWSE_PARAMETERS_SCHEMA_ID),
    connectionId: ConnectionIdSchema,
    url: z.string().min(1).max(4_096),
  })
  .strict();
export type LocalBrowseParametersV1 = z.infer<
  typeof LocalBrowseParametersV1Schema
>;

export const LocalCommandClassSchema = z.enum([
  "routine",
  "publish",
  "destructive",
]);
export type LocalCommandClass = z.infer<typeof LocalCommandClassSchema>;

const CLASS_RANK: Record<LocalCommandClass, number> = {
  routine: 0,
  publish: 1,
  destructive: 2,
};

const maxClass = (
  a: LocalCommandClass,
  b: LocalCommandClass,
): LocalCommandClass => (CLASS_RANK[a] >= CLASS_RANK[b] ? a : b);

/**
 * Deterministic shell command classifier for local.exec mediation.
 *
 * The mediator routes each intercepted command to the class-scoped action
 * (local.exec / local.exec.publish / local.exec.destroy); the definition's
 * validateBinding re-derives the class from the same function, so an agent
 * cannot smuggle a destructive command through a lower-class action.
 *
 * Semantics (kept deliberately small and auditable):
 *  - The command is split on `&&`, `||`, `;`, `|`, and newlines; the result is
 *    the MOST restrictive class of any segment.
 *  - Leading `NAME=value` assignments and `sudo`/`doas`/`env`/`nice`/`ionice`/
 *    `nohup`/`timeout`/`time` wrappers (plus their flag arguments) are stripped
 *    so `sudo rm -rf /` still classifies on `rm`.
 *  - Anything the classifier cannot fully inspect fails conservative:
 *    a nested shell (`bash`, `sh -c`, `zsh`), `eval`, `exec`, `source`, inline
 *    interpreters (`python -c`, `node -e`, …) and `xargs` are destructive;
 *    command substitution `$(...)` / backticks and output redirections raise
 *    the floor to publish; unknown programs are publish.
 *  - `destructive` programs (rm, dd, mkfs, shred, kill*, shutdown, iptables,
 *    `terraform destroy|apply`, `kubectl delete`, `docker rm|prune`, …) and
 *    destructive git forms (`git reset`, `git clean`, `git push --force`,
 *    `git branch -D`) are destructive.
 *  - `publish` programs are outbound mutations: network tools (curl, wget,
 *    ssh, scp, rsync, gh, browsers), package installs (`npm install`), and
 *    git subcommands that mutate or reach a remote (push, commit, merge, …).
 *  - `routine` is a closed list of dev-toolchain and read-only utilities
 *    (build/test/lint commands, ls/cat/grep/find/ps, `npm test`, read-only
 *    git subcommands like status/log/diff).
 */
export function classifyLocalCommand(command: string): LocalCommandClass {
  let result: LocalCommandClass = "routine";
  if (command.includes("$(") || command.includes("`")) {
    result = "publish";
  }
  // Output redirection outside of quotes means a file is written.
  if (/(^|[^<>&|0-9])(>>?|&>)/u.test(command)) {
    result = maxClass(result, "publish");
  }
  const segments = command.split(/&&|\|\||[;|\n]+/u);
  for (const segment of segments) {
    result = maxClass(result, classifySegment(segment));
    if (result === "destructive") {
      return result;
    }
  }
  return result;
}

function classifySegment(segment: string): LocalCommandClass {
  const tokens = tokenize(segment);
  if (tokens.length === 0) {
    return "routine";
  }
  let index = 0;
  // Strip leading environment assignments (NAME=value).
  while (
    index < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]!)
  ) {
    index += 1;
  }
  // Strip privilege/environment wrappers and their flag arguments.
  const WRAPPERS = new Set([
    "sudo",
    "doas",
    "env",
    "nice",
    "ionice",
    "nohup",
    "timeout",
    "time",
  ]);
  while (index < tokens.length) {
    const word = basename(tokens[index]!);
    if (WRAPPERS.has(word)) {
      index += 1;
      // Wrapper operands: flags (`-u`), env assignments (`CI=1`, for `env`),
      // and numeric values (`timeout 5`, `nice -n 5`, `ionice -c 2`).
      while (
        index < tokens.length &&
        (tokens[index]!.startsWith("-") ||
          /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]!) ||
          /^\d+(\.\d+)?[smhd]?$/u.test(tokens[index]!))
      ) {
        index += 1;
      }
      continue;
    }
    break;
  }
  if (index >= tokens.length) {
    return "routine";
  }
  const program = basename(tokens[index]!);
  const args = tokens.slice(index + 1);
  const first = args.find((arg) => !arg.startsWith("-")) ?? "";
  const rest = new Set(args);
  const hasFlag = (...flags: readonly string[]) =>
    flags.some((flag) => rest.has(flag));

  // Uninspectable execution → most restrictive.
  if (
    new Set([
      "bash",
      "sh",
      "zsh",
      "fish",
      "dash",
      "ksh",
      "csh",
      "tcsh",
      "eval",
      "exec",
      "source",
      ".",
      "xargs",
      "busybox",
    ]).has(program)
  ) {
    return "destructive";
  }
  if (
    (program === "python" ||
      program === "python3" ||
      program === "node" ||
      program === "deno" ||
      program === "ruby" ||
      program === "perl" ||
      program === "php" ||
      program === "osascript") &&
    (hasFlag("-c", "-e", "-r", "-p") || program === "osascript")
  ) {
    return "destructive";
  }

  const DESTRUCTIVE = new Set([
    "rm",
    "rmdir",
    "dd",
    "mkfs",
    "shred",
    "wipe",
    "srm",
    "kill",
    "killall",
    "pkill",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "iptables",
    "nft",
    "fdisk",
    "parted",
    "userdel",
    "deluser",
    "groupdel",
    "umount",
    "diskutil",
    "format",
    "chattr",
    "crontab",
  ]);
  if (DESTRUCTIVE.has(program)) {
    if (program === "crontab" && !hasFlag("-r")) {
      return "publish";
    }
    return "destructive";
  }
  if (program === "systemctl") {
    return ["stop", "restart", "disable", "mask", "kill", "revert"].includes(
      first,
    )
      ? "destructive"
      : "publish";
  }
  if (program === "terraform" || program === "tofu") {
    if (["destroy", "apply"].includes(first)) {
      return "destructive";
    }
    return [
      "plan",
      "init",
      "validate",
      "fmt",
      "show",
      "output",
      "state",
    ].includes(first)
      ? "routine"
      : "publish";
  }
  if (program === "kubectl" || program === "helm") {
    return ["delete", "drain", "uninstall", "replace", "apply"].includes(first)
      ? "destructive"
      : "publish";
  }
  if (program === "docker" || program === "podman") {
    if (
      ["rm", "rmi", "prune", "kill"].includes(first) ||
      (first === "system" && hasFlag("prune"))
    ) {
      return "destructive";
    }
    return "publish";
  }
  if (["aws", "gcloud", "az"].includes(program)) {
    return args.some(
      (arg) =>
        /^(rm|remove|purge|terminate|uninstall)$/u.test(arg) ||
        arg.includes("delete") ||
        arg.includes("destroy"),
    )
      ? "destructive"
      : "publish";
  }

  // Read-only / dev-toolchain programs.
  const ROUTINE = new Set([
    "ls",
    "cat",
    "head",
    "tail",
    "grep",
    "rg",
    "find",
    "echo",
    "printf",
    "wc",
    "sort",
    "uniq",
    "tr",
    "cut",
    "date",
    "pwd",
    "whoami",
    "hostname",
    "uname",
    "which",
    "file",
    "stat",
    "du",
    "df",
    "ps",
    "top",
    "htop",
    "tree",
    "less",
    "more",
    "cd",
    "export",
    "set",
    "alias",
    "history",
    "jobs",
    "fg",
    "bg",
    "wait",
    "umask",
    "test",
    "[",
    "true",
    "false",
    ":",
    "tsc",
    "eslint",
    "prettier",
    "vitest",
    "jest",
    "pytest",
    "ruff",
    "mypy",
    "cargo",
    "rustc",
    "go",
    "javac",
    "mvn",
    "gradle",
    "dotnet",
    "make",
    "cmake",
    "gcc",
    "g++",
    "clang",
    "cc",
    "c++",
    "git",
    "diff",
    "patch",
  ]);
  if (program === "git") {
    const READ_ONLY = new Set([
      "status",
      "log",
      "diff",
      "show",
      "rev-parse",
      "ls-files",
      "ls-tree",
      "cat-file",
      "blame",
      "annotate",
      "shortlog",
      "describe",
      "grep",
      "reflog",
      "stash",
      "branch",
      "remote",
      "config",
      "tag",
    ]);
    if (READ_ONLY.has(first)) {
      if (first === "branch" && hasFlag("-d", "-D")) {
        return "destructive";
      }
      if (first === "stash" && args.includes("drop")) {
        return "publish";
      }
      if (
        (first === "branch" ||
          first === "remote" ||
          first === "config" ||
          first === "tag") &&
        args.some((arg) => !arg.startsWith("-") && arg !== first)
      ) {
        // `git branch foo`/`git remote add`/`git tag v1` mutate local state.
        return "publish";
      }
      return "routine";
    }
    if (
      ["reset", "clean", "filter-branch", "filter-repo", "update-ref"].includes(
        first,
      )
    ) {
      return "destructive";
    }
    if (
      first === "push" &&
      hasFlag("-f", "--force", "--force-with-lease", "--delete")
    ) {
      return "destructive";
    }
    return "publish";
  }
  if (ROUTINE.has(program)) {
    return "routine";
  }
  const PACKAGE_MANAGERS = new Set([
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "bun",
    "bunx",
  ]);
  if (PACKAGE_MANAGERS.has(program)) {
    if (
      [
        "test",
        "run",
        "run-script",
        "build",
        "lint",
        "format",
        "typecheck",
        "check",
        "exec",
      ].includes(first)
    ) {
      return first === "exec" ? "publish" : "routine";
    }
    if (
      [
        "ls",
        "list",
        "outdated",
        "view",
        "info",
        "audit",
        "why",
        "doctor",
        "cache",
      ].includes(first)
    ) {
      return "routine";
    }
    return "publish";
  }
  const INTERPRETERS = new Set([
    "python",
    "python3",
    "node",
    "deno",
    "ruby",
    "perl",
    "php",
  ]);
  if (INTERPRETERS.has(program)) {
    return "routine";
  }
  const NETWORK = new Set([
    "curl",
    "wget",
    "ssh",
    "scp",
    "sftp",
    "rsync",
    "ftp",
    "telnet",
    "nc",
    "ncat",
    "socat",
    "gh",
    "http",
    "https",
    "aria2c",
    "xdg-open",
    "open",
    "chmod",
    "chown",
    "chgrp",
    "mkdir",
    "touch",
    "cp",
    "mv",
    "ln",
    "tar",
    "zip",
    "unzip",
    "gzip",
    "gunzip",
    "sed",
    "awk",
    "tee",
    "install",
    "mount",
  ]);
  if (NETWORK.has(program)) {
    return "publish";
  }
  // Unknown programs are never silently routine.
  return "publish";
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (const ch of segment) {
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function basename(token: string): string {
  const normalized = token.replace(/\\/gu, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

type BindingResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reasonCode: string }>;

type LocalConnectionFacts = Readonly<{
  provider: string;
  endpointAllowlist?: readonly string[];
}>;

/**
 * The class-scoped binding for local.exec*: the classified command must equal
 * the action's declared class. Re-derived here so a misrouted action id (e.g.
 * a destructive command proposed as `local.exec`) fails closed.
 */
export function localExecBinding(expected: LocalCommandClass) {
  return (input: {
    params: LocalExecParametersV1;
    connection: LocalConnectionFacts;
  }): BindingResult => {
    if (input.connection.provider !== "local") {
      return { ok: false, reasonCode: "PROVIDER_MISMATCH" };
    }
    const actual = classifyLocalCommand(input.params.command);
    if (actual !== expected) {
      return { ok: false, reasonCode: "COMMAND_CLASS_MISMATCH" };
    }
    return { ok: true };
  };
}

export function localEndpointBinding(input: {
  params: { url: string };
  connection: LocalConnectionFacts;
}): BindingResult {
  if (input.connection.provider !== "local") {
    return { ok: false, reasonCode: "PROVIDER_MISMATCH" };
  }
  const canonical = canonicalizeApiRequestUrl(input.params.url);
  if (canonical === null) {
    return { ok: false, reasonCode: "URL_INVALID" };
  }
  const allowlist = input.connection.endpointAllowlist ?? [];
  if (!apiEndpointWithinAllowlist(canonical, allowlist)) {
    return { ok: false, reasonCode: "ENDPOINT_NOT_ALLOWED" };
  }
  return { ok: true };
}

export function localExecVerificationProjection(
  input: LocalExecParametersV1,
): unknown {
  const params = LocalExecParametersV1Schema.parse(input);
  return {
    command: params.command,
    cwd: params.cwd ?? null,
    commandClass: classifyLocalCommand(params.command),
  };
}

export function localExecEnvelopeProjection(
  input: LocalExecParametersV1,
): unknown {
  return localExecVerificationProjection(input);
}

export function localEgressVerificationProjection(
  input: LocalEgressParametersV1,
): unknown {
  const params = LocalEgressParametersV1Schema.parse(input);
  return { url: params.url, method: params.method };
}

export function localEgressEnvelopeProjection(
  input: LocalEgressParametersV1,
): unknown {
  return localEgressVerificationProjection(input);
}

export function localBrowseVerificationProjection(
  input: LocalBrowseParametersV1,
): unknown {
  const params = LocalBrowseParametersV1Schema.parse(input);
  return { url: params.url };
}

export function localBrowseEnvelopeProjection(
  input: LocalBrowseParametersV1,
): unknown {
  return localBrowseVerificationProjection(input);
}
