/**
 * Sensitive files: secrets, keys and cloud credentials.
 *
 * A deterministic list of path patterns, checked on the machine that runs
 * the hook. A read (Read, Grep, Glob, LS, a shell command naming the file)
 * of a path that matches is routed to the Ask tier, so the owner's
 * needs-approval connection decides and Guardian records it; with
 * GUARDIAN_HOOK_SENSITIVE_MODE=deny the hook refuses it without asking.
 * Ordinary paths are not sent anywhere.
 *
 * Patterns:
 *   - a pattern without `/` matches the last part of the path, the file
 *     name (`.env*`); `name/**` also covers everything in a folder;
 *   - a pattern with `/` matches the end of the path (`.aws/credentials`);
 *   - `*` and `?` match within one name, `[abc]` one character, `**` any
 *     number of folders (also none);
 *   - matching ignores case;
 *   - `!pattern` exempts what it matches; the last matching pattern wins.
 *
 * The owner's patterns (GUARDIAN_HOOK_SENSITIVE_PATHS, comma separated)
 * come after the defaults, so they can add, exempt (`!.env.test`) or
 * replace them (a list that starts with `!*` drops every default).
 *
 * Any error here throws; the caller denies the call (fail closed). A path
 * the hook cannot resolve (other than one that does not exist) counts as
 * sensitive.
 */
import { lstatSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";

import { parseShell, type Parsed, type Word } from "./shell.js";

export const DEFAULT_SENSITIVE_PATHS: readonly string[] = [
  ".env*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".ssh/**",
  ".aws/credentials",
  ".aws/sso/cache/**",
  ".config/gcloud/**",
  ".azure/**",
  ".kube/config",
  ".docker/config.json",
  ".config/gh/hosts.yml",
  "*secret*",
  "secrets/**",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  "proc/*/environ",
];

export type SensitiveMode = "ask" | "deny";

type Segment = RegExp | "**";
type Rule = Readonly<{
  pattern: string;
  negate: boolean;
  segments: readonly Segment[];
}>;

export type SensitiveConfig = Readonly<{
  rules: readonly Rule[];
  mode: SensitiveMode;
}>;

/** One sensitive path found in a call: what was named and why. */
export type SensitiveHit = Readonly<{ path: string; pattern: string }>;

/** The owner's settings are invalid; the hook denies every call. */
export class SensitiveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SensitiveConfigError";
  }
}

export const UNRESOLVED = "(could not be resolved)";

const MAX_PATTERNS = 256;
const MAX_PATTERN_LENGTH = 256;

function segmentRegex(segment: string, pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = segment.indexOf("]", i + 2);
      if (end < 0) {
        throw new SensitiveConfigError(
          `sensitive path pattern ${JSON.stringify(pattern)} has an unclosed [`,
        );
      }
      let body = segment.slice(i + 1, end);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      re += `[${negated ? "^" : ""}${body.replace(/[\\\]^[]/g, "\\$&")}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is");
}

function compileRule(raw: string): Rule | null {
  let text = raw.trim();
  if (text === "") return null;
  if (text.length > MAX_PATTERN_LENGTH) {
    throw new SensitiveConfigError(
      `a sensitive path pattern is longer than ${MAX_PATTERN_LENGTH} characters`,
    );
  }
  if ([...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch === "\x7f")) {
    throw new SensitiveConfigError(
      "a sensitive path pattern contains a control character",
    );
  }
  const negate = text.startsWith("!");
  if (negate) text = text.slice(1);
  const parts = text
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (parts.length === 0) {
    throw new SensitiveConfigError(
      `sensitive path pattern ${JSON.stringify(raw.trim())} names no file`,
    );
  }
  return {
    pattern: raw.trim(),
    negate,
    segments: parts.map((p) => (p === "**" ? "**" : segmentRegex(p, raw))),
  };
}

/** Compile a pattern list (the defaults, then the owner's). Throws on an invalid one. */
export function compileSensitive(
  patterns: readonly string[],
  mode: SensitiveMode = "ask",
): SensitiveConfig {
  if (patterns.length > MAX_PATTERNS) {
    throw new SensitiveConfigError(
      `more than ${MAX_PATTERNS} sensitive path patterns`,
    );
  }
  const rules = patterns.map(compileRule).filter((r): r is Rule => r !== null);
  return { rules, mode };
}

export const DEFAULT_SENSITIVE: SensitiveConfig = compileSensitive(
  DEFAULT_SENSITIVE_PATHS,
);

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The owner's settings:
 *   GUARDIAN_HOOK_SENSITIVE_PATHS  extra patterns, comma or newline separated
 *   GUARDIAN_HOOK_SENSITIVE_MODE   ask (default) | deny
 * Throws SensitiveConfigError on an invalid value (the hook then denies).
 */
export function sensitiveConfigFromEnv(env: Env): SensitiveConfig {
  const modeText = env.GUARDIAN_HOOK_SENSITIVE_MODE?.trim().toLowerCase();
  if (modeText && modeText !== "ask" && modeText !== "deny") {
    throw new SensitiveConfigError(
      "GUARDIAN_HOOK_SENSITIVE_MODE must be ask or deny",
    );
  }
  const extra = (env.GUARDIAN_HOOK_SENSITIVE_PATHS ?? "")
    .split(/[,\n]/)
    .filter((p) => p.trim() !== "");
  if (extra.length === 0 && !modeText) return DEFAULT_SENSITIVE;
  return compileSensitive(
    [...DEFAULT_SENSITIVE_PATHS, ...extra],
    modeText === "deny" ? "deny" : "ask",
  );
}

function segmentsOf(text: string): string[] {
  return text
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
}

function testSegment(re: RegExp, segment: string): boolean {
  if (re.test(segment)) return true;
  // Windows ignores trailing dots and spaces and reads `name:stream`.
  if (segment === "..") return false;
  const trimmed = segment.replace(/:.*$/s, "").replace(/[. ]+$/, "");
  return trimmed !== "" && trimmed !== segment && re.test(trimmed);
}

function matchFrom(
  ps: readonly Segment[],
  i: number,
  ss: readonly string[],
  j: number,
): boolean {
  if (i === ps.length) return j === ss.length;
  const p = ps[i]!;
  if (p === "**") {
    return (
      matchFrom(ps, i + 1, ss, j) ||
      (j < ss.length && matchFrom(ps, i, ss, j + 1))
    );
  }
  return (
    j < ss.length && testSegment(p, ss[j]!) && matchFrom(ps, i + 1, ss, j + 1)
  );
}

/** The pattern ends the path: try every start. */
function ruleMatches(rule: Rule, segments: readonly string[]): boolean {
  for (let start = segments.length - 1; start >= 0; start--) {
    if (matchFrom(rule.segments, 0, segments, start)) return true;
  }
  return false;
}

/** The deciding (last matching) pattern when `text`, read as a path, is sensitive. */
export function matchSensitive(
  text: string,
  config: SensitiveConfig = DEFAULT_SENSITIVE,
): string | undefined {
  const segments = segmentsOf(text);
  if (segments.length === 0) return undefined;
  let decided: string | undefined;
  for (const rule of config.rules) {
    if (ruleMatches(rule, segments)) {
      decided = rule.negate ? undefined : rule.pattern;
    }
  }
  return decided;
}

const MISSING = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG", "EINVAL"]);

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && MISSING.has(code);
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return homedir() + path.slice(1);
  }
  return path;
}

type PathOptions = Readonly<{
  cwd?: string;
  /** Skip the absolute path when nothing exists there (shell words). */
  onlyIfExists?: boolean;
}>;

/**
 * Checks one path as written, as an absolute path (`..` and `~` resolved
 * against `cwd`) and, when it exists, its real path (symlinks followed).
 */
export function checkPath(
  path: string,
  config: SensitiveConfig = DEFAULT_SENSITIVE,
  options: PathOptions = {},
): SensitiveHit | undefined {
  const asWritten = matchSensitive(path, config);
  // A shell word that names no existing file reads nothing (`jq .key`).
  if (asWritten && !options.onlyIfExists) return { path, pattern: asWritten };
  if (path === "" || path.includes("\0")) return undefined;
  const expanded = expandTilde(path);
  const absolute = isAbsolute(expanded)
    ? normalize(expanded)
    : resolve(options.cwd ?? process.cwd(), expanded);
  // As the operating system reads it: `..` applies after a symlink before
  // it is followed (`normalize` would drop the symlink).
  const asOpened = isAbsolute(expanded)
    ? expanded
    : `${options.cwd ?? process.cwd()}/${expanded}`;
  if (options.onlyIfExists) {
    try {
      lstatSync(asOpened);
    } catch (err) {
      if (isMissing(err)) return undefined;
      return { path, pattern: UNRESOLVED };
    }
    if (asWritten) return { path, pattern: asWritten };
  }
  const resolved = matchSensitive(absolute, config);
  if (resolved) return { path, pattern: resolved };
  let real: string;
  try {
    real = realpathSync.native(asOpened);
  } catch (err) {
    if (isMissing(err)) return undefined;
    return { path, pattern: UNRESOLVED };
  }
  const followed = matchSensitive(real, config);
  return followed ? { path, pattern: followed } : undefined;
}

// ---------------------------------------------------------------------------
// Brace and glob expansion, as the shell would do before the command runs.

const MAX_BRACES = 64;

/** `a{b,c}d` → abd acd; `{1..3}`, `{a..c}`. Bounded; throws past the bound. */
export function expandBraces(text: string): string[] {
  const out: string[] = [];
  const pending = [text];
  while (pending.length > 0) {
    const s = pending.pop()!;
    const alts = firstBrace(s);
    if (!alts) {
      out.push(s);
    } else {
      pending.push(...alts);
    }
    if (out.length + pending.length > MAX_BRACES) {
      throw new BraceOverflow();
    }
  }
  return out;
}

class BraceOverflow extends Error {}

function firstBrace(s: string): string[] | null {
  for (let open = s.indexOf("{"); open >= 0; open = s.indexOf("{", open + 1)) {
    let depth = 0;
    const commas: number[] = [];
    for (let k = open; k < s.length; k++) {
      const c = s[k];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const pre = s.slice(0, open);
          const post = s.slice(k + 1);
          const body = s.slice(open + 1, k);
          if (commas.length > 0) {
            const parts: string[] = [];
            let from = open + 1;
            for (const comma of commas) {
              parts.push(s.slice(from, comma));
              from = comma + 1;
            }
            parts.push(s.slice(from, k));
            return parts.map((p) => pre + p + post);
          }
          const seq = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])$/.exec(body);
          if (seq) return sequence(seq[1]!, seq[2]!).map((p) => pre + p + post);
          break;
        }
      } else if (c === "," && depth === 1) commas.push(k);
    }
  }
  return null;
}

function sequence(a: string, b: string): string[] {
  const numeric = /\d/.test(a) && /\d/.test(b);
  const from = numeric ? Number(a) : a.charCodeAt(0);
  const to = numeric ? Number(b) : b.charCodeAt(0);
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    Math.abs(to - from) >= MAX_BRACES
  ) {
    throw new BraceOverflow();
  }
  const step = from <= to ? 1 : -1;
  const out: string[] = [];
  for (let v = from; v !== to + step; v += step) {
    out.push(numeric ? String(v) : String.fromCharCode(v));
  }
  return out;
}

const GLOB_CHARS = /[*?[]/;
const MAX_GLOB_ENTRIES = 5_000;
const MAX_GLOB_DIRS = 500;

class GlobOverflow extends Error {}

/**
 * The paths a shell glob would expand to, relative to `cwd`. A name that
 * starts with `.` is matched by a part that starts with `.`, and by others when
 * `dots` (dotglob and similar). Extended-glob parts (with `(`) match every
 * name. Throws GlobOverflow past the bounds.
 */
function expandGlob(word: string, cwd: string, dots: boolean): string[] {
  const expanded = expandTilde(word);
  const absolute = isAbsolute(expanded);
  const parts = expanded.replace(/\\/g, "/").split("/");
  let bases = [absolute ? (parts[0] === "" ? "/" : parts[0]! + "/") : ""];
  const start = absolute ? 1 : 0;
  let entries = 0;
  let dirs = 0;
  const list = (dir: string): Dirent[] => {
    if (++dirs > MAX_GLOB_DIRS) throw new GlobOverflow();
    try {
      const found = readdirSync(resolve(cwd, dir || "."), {
        withFileTypes: true,
      });
      entries += found.length;
      if (entries > MAX_GLOB_ENTRIES) throw new GlobOverflow();
      return found;
    } catch (err) {
      if (err instanceof GlobOverflow) throw err;
      return []; // the shell cannot list it either
    }
  };
  const join = (base: string, name: string) =>
    base === "" ? name : base.endsWith("/") ? base + name : `${base}/${name}`;
  for (let i = start; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "") continue;
    if (part === "**") {
      // The folder itself and everything below it, files included (a
      // later part applied to a file matches nothing).
      const all: string[] = [];
      const walk = (base: string, depth: number) => {
        all.push(base);
        if (depth > 16) throw new GlobOverflow();
        for (const e of list(base)) {
          if (!dots && e.name.startsWith(".")) continue;
          if (e.isDirectory()) walk(join(base, e.name), depth + 1);
          else all.push(join(base, e.name));
        }
      };
      for (const base of bases) walk(base, 0);
      bases = all;
      continue;
    }
    if (!GLOB_CHARS.test(part) && !part.includes("(")) {
      bases = bases.map((b) => join(b, part));
      continue;
    }
    let re: RegExp;
    try {
      re = part.includes("(") ? /^.*$/s : segmentRegex(part, part);
    } catch {
      re = /^.*$/s; // an unclosed [ : match every name (over-approximate)
    }
    const dotsHere = dots || part.startsWith(".") || part.includes("(");
    const next: string[] = [];
    for (const base of bases) {
      for (const e of list(base)) {
        if (!dotsHere && e.name.startsWith(".")) continue;
        if (re.test(e.name)) next.push(join(base, e.name));
      }
    }
    bases = next;
  }
  return bases.filter((b) => b !== "");
}

// ---------------------------------------------------------------------------
// Shell commands.

const MAX_HITS = 10;
const MAX_RESOLVED = 2_000;
const MAX_NESTED_DEPTH = 4;
/** Characters that end a path inside a word (`--file=.env`, `open('.env')`, `@.env`). */
const TOKEN_SPLIT = /[\s'"`=:,;()<>{}|&@]+/;
const DOTGLOB = /dotglob|globdots|glob_dots|globignore|\(D/i;
/**
 * Commands that may read files from another folder or machine (`cd`,
 * `ssh`, `docker exec`), and search and archive tools that take a bare
 * name as a filter for files in other folders (`find ~ -name id_rsa`,
 * `grep -r --include=.env`), and `xargs` / `parallel`, which join a name
 * to a folder at run time (`xargs -I{} cat ~/{}`): with one of them, a
 * bare name counts whether
 * or not it exists here.
 */
const ELSEWHERE = new Set(
  (
    "cd pushd chdir ssh scp sftp rsync docker podman nerdctl kubectl oc " +
    "find fd fdfind locate mlocate plocate grep egrep fgrep zgrep rg ag ack " +
    "tar zip 7z cpio xargs parallel"
  ).split(" "),
);
/** Options that run a command in another folder (`git -C`, `make -C`). */
const CHDIR_OPTION =
  /^(?:-C|--chdir|--directory|--cwd|--git-dir|--work-tree)(?:=|$)/;
/**
 * Git subcommands that read a file by name from history, not from the
 * working tree (`git show HEAD~1:.env`, `git log -p -- .env`).
 */
const GIT_HISTORY = new Set(
  (
    "show cat-file log diff archive blame grep checkout restore ls-tree " +
    "whatchanged format-patch stash cherry-pick bundle"
  ).split(" "),
);
/** Shells and evaluators: their code arguments are commands too. */
const CODE_RUNNERS = new Set(
  "sh bash zsh dash ksh mksh ash fish busybox eval su runuser pwsh powershell".split(
    " ",
  ),
);
const INTERPRETER_NAME =
  /^(?:sh|bash|zsh|dash|ksh|mksh|ash|fish|busybox|pwsh|powershell|python[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|lua|osascript)$/;
/**
 * A login switch runs in another user's home folder: `su -`, `su -l`,
 * `runuser --login`, `sudo -i`, `sudo --login`, `doas -i`.
 */
function switchesHome(bases: readonly string[], words: readonly string[]) {
  return bases.some((b, i) => {
    const rest = words.slice(i + 1);
    if (b === "su" || b === "runuser") {
      return rest.some(
        (w) => w === "-" || w === "--login" || /^-[a-z]*l/.test(w),
      );
    }
    if (b === "sudo" || b === "doas") {
      return rest.some((w) => w === "--login" || /^-[a-zA-Z]*i/.test(w));
    }
    return false;
  });
}
const baseOf = (word: string) =>
  (word.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");

/**
 * True when a command of the line may read files elsewhere: one of its
 * words is such a command, a folder option or, after `git`, a subcommand
 * that reads history. Quoted text such as a
 * commit message is not a command. A here-document fed to a shell or
 * interpreter cannot be read here, so then the raw text decides.
 */
function runsElsewhere(command: string): {
  elsewhere: boolean;
  interpreter: boolean;
} {
  const parsed = parseShell(command);
  let interpreter = false;
  const visit = (p: Parsed, depth: number): boolean => {
    for (const cmd of p.commands) {
      const words = cmd.words.map((w) => w.value);
      // Each word is checked whole: a quoted message is one word, so the
      // `log` in "fix the log output" is not a command.
      const bases = words.map(baseOf);
      if (bases.some((b) => ELSEWHERE.has(b))) return true;
      if (switchesHome(bases, words)) return true;
      if (words.some((w) => CHDIR_OPTION.test(w))) return true;
      if (bases.some((b) => INTERPRETER_NAME.test(b))) interpreter = true;
      const git = bases.indexOf("git");
      if (git >= 0 && words.slice(git + 1).some((w) => GIT_HISTORY.has(w))) {
        return true;
      }
      // `sh -c '…'`, `eval '…'`: the code is commands too.
      const runner = bases.findIndex((b) => CODE_RUNNERS.has(b));
      if (runner >= 0 && depth < MAX_NESTED_DEPTH) {
        for (const w of words.slice(runner + 1)) {
          if (/[\s;&|]/.test(w) && visit(parseShell(w), depth + 1)) {
            return true;
          }
        }
      }
      const subs = [...cmd.subs, ...cmd.words.flatMap((w) => w.subs)];
      if (subs.some((sub) => visit(sub, depth))) return true;
    }
    return false;
  };
  if (visit(parsed, 0)) return { elsewhere: true, interpreter };
  return {
    elsewhere:
      interpreter &&
      // `bash <<EOF … EOF`: the body is code the parser does not read.
      ((command.includes("<<") && RAW_ELSEWHERE.test(command)) ||
        // Inline code that changes folder (`os.chdir`, `process.chdir`).
        CODE_CHDIR.test(command)),
    interpreter,
  };
}

const CODE_CHDIR =
  /\bchdir\b|\bSet-Location\b|\bPush-Location\b|(?:^|[\s;'"(])cd\s/i;

const RAW_ELSEWHERE =
  /(?:^|[\s;&|(`/])(?:cd|pushd|chdir|ssh|scp|sftp|rsync|docker|podman|nerdctl|kubectl|oc|find|fd|fdfind|locate|grep|egrep|fgrep|rg|ag|ack|tar|zip|7z|cpio|git)(?=$|[\s;&|)`])/;
const MAX_BARE_CHECKS = 512;

/**
 * The sensitive paths a shell command names: in its raw text (also inside
 * here-documents and code given to interpreters), in each word after
 * quotes and escapes are removed, after brace and glob expansion, and
 * through symlinks. A bare name (`.env`) counts when that file exists in
 * the working directory or the command may run elsewhere (see
 * runsElsewhere). A command that builds a path at run time (`$(…)`, `$VAR`)
 * is not seen.
 */
export function sensitiveInCommand(
  command: string,
  config: SensitiveConfig = DEFAULT_SENSITIVE,
  cwd: string = process.cwd(),
  /**
   * The shell's folder is not known (text typed into a terminal that keeps
   * its folder between calls): every bare name counts.
   */
  folderUnknown = false,
): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  const seen = new Set<string>();
  let resolved = 0;
  const dots = DOTGLOB.test(command);
  const found = runsElsewhere(command);
  const elsewhere = folderUnknown || found.elsewhere;
  const { interpreter } = found;
  let bareChecks = 0;
  /**
   * A bare name (no `/`, no glob) counts when it names a file: `jq .key`
   * and a commit message that says "secret" read nothing. It counts when it
   * exists in the working directory, or when the command may run elsewhere.
   */
  const counts = (token: string): boolean => {
    if (elsewhere || /[/\\]/.test(token) || GLOB_CHARS.test(token)) return true;
    // Interpreter code can build the folder (`path.join(home, ".npmrc")`):
    // a dot-file name counts there (`obj.key` does not).
    if (interpreter && token.startsWith(".")) return true;
    if (++bareChecks > MAX_BARE_CHECKS) return true;
    try {
      lstatSync(resolve(cwd, token));
      return true;
    } catch (err) {
      return !isMissing(err); // cannot tell: count it (fail closed)
    }
  };
  const add = (hit: SensitiveHit | undefined) => {
    if (hit && !seen.has(hit.path) && hits.length < MAX_HITS) {
      seen.add(hit.path);
      hits.push(hit);
    }
  };
  const literal = (text: string, whole: boolean) => {
    const tokens = text.split(TOKEN_SPLIT);
    for (const token of whole ? [text, ...tokens] : tokens) {
      if (token === "") continue;
      const pattern = matchSensitive(token, config);
      if (pattern && counts(token)) add({ path: token, pattern });
    }
  };
  // 1. The raw text, token by token.
  literal(command, false);

  // 2. Each word as the shell would see it.
  const word = (value: string, depth: number) => {
    let variants: string[];
    try {
      variants = expandBraces(value);
    } catch {
      add({ path: value.slice(0, 200), pattern: UNRESOLVED });
      return;
    }
    for (const v of variants) {
      literal(v, true);
      if (GLOB_CHARS.test(v)) {
        let matches: string[];
        try {
          matches = expandGlob(v, cwd, dots);
        } catch {
          add({ path: v.slice(0, 200), pattern: UNRESOLVED });
          continue;
        }
        for (const m of matches) file(m);
      } else {
        file(v);
      }
      // Code handed to a shell or interpreter: read it as a command too.
      if (depth < MAX_NESTED_DEPTH && /[\s'"\\]/.test(v)) {
        walk(parseShell(v), depth + 1);
      }
    }
  };
  const file = (path: string) => {
    if (
      path === "" ||
      path.startsWith("-") ||
      path.length > 4_096 ||
      /[\n\0]/.test(path)
    ) {
      return;
    }
    // Past the bound the rest cannot be checked: fail closed.
    if (++resolved > MAX_RESOLVED) {
      add({ path: "(more paths than the hook checks)", pattern: UNRESOLVED });
      return;
    }
    add(checkPath(path, config, { cwd, onlyIfExists: true }));
  };
  const walk = (parsed: Parsed, depth: number) => {
    for (const cmd of parsed.commands) {
      const words: Word[] = [...cmd.words, ...cmd.writes];
      for (const w of words) {
        word(w.value, depth);
        for (const sub of w.subs) walk(sub, depth);
      }
      for (const sub of cmd.subs) walk(sub, depth);
    }
  };
  walk(parseShell(command), 0);
  return hits;
}

/**
 * A search or listing filter (Grep `glob`, Glob `pattern`) as written,
 * after brace expansion. It is not expanded against the disk.
 */
export function sensitiveInFilter(
  filter: string,
  config: SensitiveConfig = DEFAULT_SENSITIVE,
): SensitiveHit | undefined {
  let variants: string[];
  try {
    variants = expandBraces(filter);
  } catch {
    return { path: filter.slice(0, 200), pattern: UNRESOLVED };
  }
  for (const v of variants) {
    const pattern = matchSensitive(v, config);
    if (pattern) return { path: filter, pattern };
  }
  return undefined;
}

const SEARCH_SKIP = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const MAX_SEARCH_DIRS = 2_000;
const MAX_SEARCH_ENTRIES = 50_000;

/**
 * A search filter (Grep `glob`, dsh grep `include`; `*` for a search with
 * no filter), with or without wildcards, matched
 * like ripgrep's `--glob` against the files under `root`: a filter without
 * `/` matches a file name at any depth. Each file it selects is checked.
 * Folders named in SEARCH_SKIP are not walked. Too many folders or
 * entries to check counts as unresolved (fail closed).
 */
export function sensitiveInSearch(
  filter: string,
  root: string,
  config: SensitiveConfig = DEFAULT_SENSITIVE,
): SensitiveHit | undefined {
  let variants: string[];
  try {
    variants = expandBraces(filter);
  } catch {
    return { path: filter.slice(0, 200), pattern: UNRESOLVED };
  }
  // `!pattern` excludes files: the search reads all the others.
  if (variants.some((v) => v.startsWith("!"))) variants = ["*"];
  const compiled = variants.map((v) => {
    const parts = segmentsOf(v);
    const segments = parts.map((part): Segment => {
      if (part === "**") return "**";
      try {
        return segmentRegex(part, part);
      } catch {
        return /^.*$/s; // an unclosed [ : every name (over-approximate)
      }
    });
    // No `/`: the name at any depth.
    return v.includes("/") ? segments : (["**", ...segments] as Segment[]);
  });
  let start: string;
  try {
    start = realpathSync.native(root);
  } catch (err) {
    if (isMissing(err)) return undefined;
    return { path: root, pattern: UNRESOLVED };
  }
  let dirs = 0;
  let entries = 0;
  const pending: string[][] = [[]];
  while (pending.length > 0) {
    const rel = pending.pop()!;
    if (++dirs > MAX_SEARCH_DIRS) {
      return { path: `${root} (${filter})`, pattern: UNRESOLVED };
    }
    let found: Dirent[];
    try {
      found = readdirSync([start, ...rel].join("/"), { withFileTypes: true });
    } catch (err) {
      if (rel.length === 0 && !isMissing(err)) {
        return { path: root, pattern: UNRESOLVED };
      }
      continue; // the search cannot read it either
    }
    entries += found.length;
    if (entries > MAX_SEARCH_ENTRIES) {
      return { path: `${root} (${filter})`, pattern: UNRESOLVED };
    }
    for (const e of found) {
      const path = [...rel, e.name];
      if (e.isDirectory()) {
        if (!SEARCH_SKIP.has(e.name)) pending.push(path);
        continue;
      }
      if (!compiled.some((segments) => matchFrom(segments, 0, path, 0))) {
        continue;
      }
      const hit = checkPath([start, ...path].join("/"), config);
      if (hit) return { path: path.join("/"), pattern: hit.pattern };
    }
  }
  return undefined;
}

/**
 * The pieces of a search filter, as Claude Code's Grep passes them to
 * ripgrep: split on whitespace, and on commas outside braces.
 */
export function filterPieces(filter: string): string[] {
  return filter
    .split(/\s+/)
    .flatMap((piece) => (piece.includes("{") ? [piece] : piece.split(",")))
    .filter((piece) => piece !== "");
}
