/**
 * Install integrity: Guardian only governs an OpenClaw agent that cannot
 * switch it off. The agent's default workspace (`~/.openclaw/workspace`) sits
 * inside OpenClaw's state directory, next to `openclaw.json` (hot-reloaded)
 * and `extensions/guardian` (this plugin), so if the OpenClaw process user
 * can change those, one everyday command can remove Guardian. Pattern checks
 * on commands cannot close that, so the plugin checks the files themselves
 * and refuses every tool call while any of them is writable.
 *
 * What is checked, as the OpenClaw process user (uid / groups):
 *   - the plugin's own directory, every file and directory in it, and the
 *     config directory's `extensions/guardian` if it exists;
 *   - every package the plugin's entry files import that is not a Node.js
 *     builtin (there should be none: dist is bundled), resolved from the
 *     plugin's real path as Node.js would, plus each nearer `node_modules`
 *     where a shadowing copy could be created;
 *   - the config directory's `npm/` (OpenClaw 2026.7.1 installs `npm:` and
 *     `npm-pack:` plugins under `<config dir>/npm/projects/<name>/node_modules`)
 *     and `hooks/` (managed hooks, loaded into the Gateway): each whole tree
 *     if it exists, else it must be impossible to create;
 *   - the OpenClaw config file OpenClaw would load (`OPENCLAW_CONFIG_PATH`,
 *     else the first existing candidate in OpenClaw's order:
 *     `<state>/openclaw.json`, `<state>/clawdbot.json`, the same under
 *     `~/.openclaw` and `~/.clawdbot`), plus `openclaw.json5` beside it, and
 *     every candidate before it that the agent could create;
 *   - the config directory's `extensions/` directory;
 *   - the dotenv files OpenClaw loads into the Gateway's environment at
 *     start-up (`<process cwd>/.env`, `<config dir>/.env`,
 *     `~/.config/openclaw/gateway.env`), which must exist read-only or be
 *     impossible to create;
 *   - the npm config files npm would read for the Gateway's environment
 *     (the user config, `$HOME/.npmrc` by default, and the global config,
 *     `<node prefix>/etc/npmrc` by default): an operator who runs
 *     `openclaw plugins install` with that HOME would run npm with them;
 *   - the config directory's `mpm/` and `plugins/` (OpenClaw reads plugin
 *     catalogs from `mpm/plugins.json`, `mpm/catalog.json` and
 *     `plugins/catalog.json`; `plugins/installs.json` is a legacy install
 *     record it migrates), each tree if it exists, else not creatable;
 *   - the active config file's backups (`<config>.bak`, which OpenClaw
 *     restores from when the config reads as damaged, and `<config>.bak.*`);
 *   - every ancestor of those paths, lexical and real: a directory the user
 *     can write lets it rename (and so replace) what is inside it, unless the
 *     directory is sticky and the entry belongs to someone else.
 *
 * "Writable" is decided from the inode, not just `access(2)`: an entry the
 * user owns is writable even with mode 0444 (it can `chmod`), unless it is
 * immutable (`chattr +i`, EPERM) or on a read-only mount (EROFS); otherwise
 * group / other write bits or a successful `access(W_OK)` (ACLs) make it
 * writable. Root can change anything, so a Gateway running as uid 0 always
 * fails the check. Any error while checking counts as writable (fail closed).
 */
import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import { homedir as osHomedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Env = Readonly<Record<string, string | undefined>>;

/** How long a passing (or failing) check is reused before it runs again. */
export const INSTALL_CHECK_CACHE_MS = 5_000;
/** The checked trees have a few hundred files; more than this fails closed. */
const MAX_ENTRIES = 50_000;
/** Entry files larger than this are not scanned for imports (fails closed). */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_LISTED = 4;

export const ALLOW_WRITABLE_INSTALL_ENV =
  "GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL";

export type InstallCheckOptions = Readonly<{
  /** The plugin's root directory. Default: found from this module's URL. */
  pluginDir?: string;
  /** OpenClaw's environment (OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH, ...). */
  env?: Env;
  /** The OpenClaw process user. Default: this process's uid and groups. */
  uid?: number;
  gids?: readonly number[];
  /** The Gateway's working directory (its `.env` is loaded). Default: process.cwd(). */
  cwd?: string;
  /** npm's default prefix (global config `<prefix>/etc/npmrc`). Default: from process.execPath. */
  nodePrefix?: string;
}>;

export type InstallCheckResult =
  | { ok: true }
  | { ok: false; uid: number; problems: string[] };

/** The plugin root: the nearest directory up from `from` with openclaw.plugin.json. */
export function findPluginDir(
  from: string = fileURLToPath(import.meta.url),
): string | undefined {
  let dir = path.dirname(from);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "openclaw.plugin.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function homeDir(env: Env): string {
  const home = env.HOME?.trim() || osHomedir();
  const explicit = env.OPENCLAW_HOME?.trim();
  if (explicit) return path.resolve(explicit.replace(/^~(?=$|[\\/])/, home));
  return path.resolve(home);
}

function userPath(input: string, env: Env): string {
  const t = input.trim();
  return path.resolve(
    t.startsWith("~") ? t.replace(/^~(?=$|[\\/])/, homeDir(env)) : t,
  );
}

/** OpenClaw 2026.7.1's `resolveStateDir`. */
export function openclawStateDir(env: Env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) return userPath(override, env);
  const home = homeDir(env);
  const next = path.join(home, ".openclaw");
  if (fs.existsSync(next)) return next;
  const legacy = path.join(home, ".clawdbot");
  return fs.existsSync(legacy) ? legacy : next;
}

/**
 * OpenClaw 2026.7.1's `resolveConfigDir`: where it keeps `extensions/`,
 * `npm/` (managed npm installs), `hooks/` (managed hooks) and `.env`.
 */
export function openclawConfigDir(env: Env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) return userPath(override, env);
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) return path.dirname(userPath(configPath, env));
  return path.join(homeDir(env), ".openclaw");
}

/** OpenClaw 2026.7.1's `resolveDefaultConfigCandidates`, in its order. */
export function openclawConfigCandidates(env: Env): string[] {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return [userPath(explicit, env)];
  const dirs: string[] = [];
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) dirs.push(userPath(override, env));
  const home = homeDir(env);
  dirs.push(path.join(home, ".openclaw"), path.join(home, ".clawdbot"));
  return dirs.flatMap((d) => [
    path.join(d, "openclaw.json"),
    path.join(d, "clawdbot.json"),
  ]);
}

/**
 * The dotenv files OpenClaw 2026.7.1 loads into the Gateway's environment
 * at start-up (`loadDotEnv`): `<process cwd>/.env` (the "workspace" dotenv:
 * OpenClaw filters some keys, but not `GUARDIAN_*`), `<config dir>/.env`
 * and, unless an explicit non-default state directory is set,
 * `~/.config/openclaw/gateway.env`. A line written there
 * (`GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1`, `OPENCLAW_CONFIG_PATH=...`)
 * would take effect at the next restart, so they are config too.
 */
export function openclawDotEnvFiles(
  env: Env,
  cwd: string = process.cwd(),
): string[] {
  const home = homeDir(env);
  const override = env.OPENCLAW_STATE_DIR?.trim();
  const stateEnv = path.join(openclawConfigDir(env), ".env");
  const out = [path.join(path.resolve(cwd), ".env"), stateEnv];
  const explicitOther =
    override !== undefined &&
    path.resolve(stateEnv) !== path.join(home, ".openclaw", ".env");
  if (!explicitOther) {
    out.push(path.join(home, ".config", "openclaw", "gateway.env"));
  }
  return out;
}

/** An npm config key from the environment (npm reads `npm_config_*` in any case). */
function npmEnv(env: Env, key: string): string | undefined {
  const want = `npm_config_${key}`;
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === want && v?.trim()) return v.trim();
  }
  return undefined;
}

/**
 * The npm config files npm 10 reads for this environment, besides the
 * project `.npmrc` (inside `<config dir>/npm`, checked with that tree) and
 * npm's own builtin `npmrc` (part of the Node.js install): the user config
 * (`npm_config_userconfig`, default `$HOME/.npmrc`) and the global config
 * (`npm_config_globalconfig`, default `<prefix>/etc/npmrc`, where the prefix
 * is `npm_config_prefix` or the Node.js install prefix). OpenClaw 2026.7.1
 * runs npm with the caller's environment and no `--userconfig`, so whoever
 * can write these chooses the registry (and more) for an install run with
 * this HOME, root's included. `/dev/null` is not a file anyone can plant.
 */
export function npmConfigFiles(
  env: Env,
  nodePrefix: string = path.dirname(path.dirname(process.execPath)),
): string[] {
  const home = env.HOME?.trim() || osHomedir();
  const resolve = (p: string) => path.resolve(p.replace(/^~(?=$|[\\/])/, home));
  const user = npmEnv(env, "userconfig");
  const global = npmEnv(env, "globalconfig");
  const prefix = npmEnv(env, "prefix");
  const out = [
    user ? resolve(user) : path.join(home, ".npmrc"),
    global
      ? resolve(global)
      : path.join(
          prefix ? resolve(prefix) : path.resolve(nodePrefix),
          "etc",
          "npmrc",
        ),
  ];
  return [...new Set(out)].filter((p) => p !== "/dev/null");
}

const IMPORT_PATTERNS = [
  // Static import / export ... from <spec>, and side-effect import <spec>,
  // at the start of a statement (esbuild puts them at the start of a line).
  /(?:^|[;}])[ \t]*(?:import|export)\b[\w\s{},*$]*?\bfrom[ \t]*["']([^"'\n]+)["']/gm,
  /(?:^|[;}])[ \t]*import[ \t]*["']([^"'\n]+)["']/gm,
  // Dynamic import(<spec>) and require(<spec>) / __require(<spec>), literal.
  /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\b(?:__)?require\(\s*["']([^"'\n]+)["']\s*\)/g,
];

/** The module specifiers a JavaScript file imports (literal ones). */
export function importSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    for (const m of source.matchAll(re)) if (m[1]) out.add(m[1]);
  }
  return [...out];
}

/** Specifiers Node.js would load from outside the file's own directory tree. */
export function externalSpecifiers(source: string): string[] {
  return importSpecifiers(source).filter(
    (s) => !isBuiltin(s) && !s.startsWith("./") && !s.startsWith("../"),
  );
}

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
function packageName(spec: string): string | undefined {
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return name && !name.startsWith(".") && !path.isAbsolute(name)
    ? name
    : undefined;
}

/**
 * The `node_modules` directories ESM resolution searches for a bare
 * specifier imported from `dir`, nearest first (no global folders).
 */
export function nodeModulesLookup(dir: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(dir);
  for (;;) {
    if (path.basename(cur) !== "node_modules") {
      out.push(path.join(cur, "node_modules"));
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

type PluginPackage = { name?: string; entries: string[]; deps: string[] };

function readPluginPackage(pluginDir: string): PluginPackage {
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(
      fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    // No package.json: only the default entry below.
  }
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const oc = (pkg.openclaw ?? {}) as Record<string, unknown>;
  const entries = [
    ...strings(oc.extensions),
    ...(typeof pkg.main === "string" ? [pkg.main] : []),
  ];
  if (!entries.length) entries.push("dist/index.js");
  const deps = new Set<string>();
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const v = pkg[field];
    if (v && typeof v === "object") for (const k of Object.keys(v)) deps.add(k);
  }
  return {
    ...(typeof pkg.name === "string" ? { name: pkg.name } : {}),
    entries: [...new Set(entries)],
    deps: [...deps],
  };
}

type Identity = { uid: number; gids: ReadonlySet<number>; real: boolean };

function identity(opts: InstallCheckOptions): Identity {
  const realUid = typeof process.getuid === "function" ? process.getuid() : -1;
  const uid = opts.uid ?? realUid;
  const gids =
    opts.gids ??
    (uid === realUid && typeof process.getgroups === "function"
      ? [...process.getgroups(), process.getegid?.() ?? -1]
      : []);
  return { uid, gids: new Set(gids), real: uid === realUid };
}

/** access(W_OK) as this process; "ro" for an immutable entry or a read-only mount. */
function accessWrite(p: string): "yes" | "no" | "ro" {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return "yes";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EROFS" || code === "EPERM") return "ro";
    if (code === "EACCES") return "no";
    throw err;
  }
}

/** Can `who` change this entry (its contents, or its mode)? */
function canWrite(p: string, st: fs.Stats, who: Identity): boolean {
  const access = who.real ? accessWrite(p) : undefined;
  if (access === "ro") return false;
  if (st.uid === who.uid) return true; // the owner can chmod it
  if (st.mode & 0o002) return true;
  if (st.mode & 0o020 && who.gids.has(st.gid)) return true;
  return access === "yes";
}

/** Can `who` rename or remove `child` out of the directory `parent`? */
function canReplace(
  parent: string,
  parentSt: fs.Stats,
  child: string,
  childSt: fs.Stats,
  who: Identity,
): boolean {
  if (!canWrite(parent, parentSt, who)) return false;
  // An immutable entry (or a read-only mount point) cannot be renamed.
  if (who.real && !childSt.isSymbolicLink() && accessWrite(child) === "ro") {
    return false;
  }
  if (!(parentSt.mode & 0o1000)) return true;
  return childSt.uid === who.uid || parentSt.uid === who.uid;
}

class Checker {
  readonly problems: string[] = [];
  private readonly seenAncestors = new Set<string>();
  private readonly seenTrees = new Set<string>();
  private entries = 0;

  constructor(private readonly who: Identity) {}

  private add(problem: string) {
    if (!this.problems.includes(problem)) this.problems.push(problem);
  }

  /** Every ancestor of `p` (lexical and real) must not let `who` replace it. */
  ancestors(p: string, label: string) {
    const chains = [path.resolve(p)];
    try {
      chains.push(fs.realpathSync(p));
    } catch {
      // A missing path: its lexical chain is still checked.
    }
    for (const start of chains) {
      let child = start;
      for (;;) {
        const parent = path.dirname(child);
        if (parent === child) break;
        const key = `${parent}\0${child}`;
        if (!this.seenAncestors.has(key)) {
          this.seenAncestors.add(key);
          let childSt: fs.Stats | undefined;
          try {
            childSt = fs.lstatSync(child);
          } catch {
            childSt = undefined; // missing: covered by creatable()
          }
          if (childSt) {
            try {
              const parentSt = fs.statSync(parent);
              if (canReplace(parent, parentSt, child, childSt, this.who)) {
                this.add(`${parent} (can rename ${label})`);
              }
            } catch {
              this.add(`${parent} (could not check)`);
            }
          }
        }
        child = parent;
      }
    }
  }

  /** `p` and everything under it (following links) must be unwritable. */
  tree(p: string, label: string) {
    const queue = [p];
    while (queue.length) {
      const cur = queue.pop()!;
      if (++this.entries > MAX_ENTRIES) {
        this.add(`${p} (too many files to check)`);
        return;
      }
      let real: string;
      let st: fs.Stats;
      try {
        const lst = fs.lstatSync(cur);
        if (lst.isSymbolicLink()) {
          real = fs.realpathSync(cur);
          if (!real.startsWith(`${p}${path.sep}`) && real !== p) {
            this.ancestors(real, label);
          }
        } else {
          real = cur;
        }
        if (this.seenTrees.has(real)) continue;
        this.seenTrees.add(real);
        st = fs.statSync(real);
        if (canWrite(real, st, this.who)) this.add(real);
        if (st.isDirectory()) {
          for (const name of fs.readdirSync(real)) {
            queue.push(path.join(real, name));
          }
        }
      } catch {
        this.add(`${cur} (could not check)`);
      }
    }
  }

  /** A path that must exist as an unwritable entry or directory. */
  entry(p: string, label: string, kind: "file" | "dir") {
    try {
      const st = fs.statSync(p);
      if (canWrite(p, st, this.who)) {
        this.add(
          kind === "dir" ? `${p} (can add or remove ${label} entries)` : p,
        );
      }
    } catch {
      this.add(`${p} (could not check)`);
    }
    this.ancestors(p, label);
  }

  /** A missing path the agent must not be able to create. */
  creatable(p: string, label: string) {
    let dir = path.dirname(path.resolve(p));
    for (;;) {
      try {
        const st = fs.statSync(dir);
        if (canWrite(dir, st, this.who)) {
          this.add(`${dir} (can create ${label} ${p})`);
        }
        break;
      } catch {
        const up = path.dirname(dir);
        if (up === dir) {
          this.add(`${p} (could not check)`);
          break;
        }
        dir = up;
      }
    }
    this.ancestors(path.dirname(path.resolve(p)), label);
  }

  /** A path that must be either an unwritable tree or impossible to create. */
  treeOrAbsent(p: string, label: string) {
    if (exists(p)) {
      this.tree(p, label);
      this.ancestors(p, label);
    } else {
      this.creatable(p, label);
    }
  }

  /**
   * Every package the plugin loads at runtime (bare imports in its entry
   * files, and its declared dependencies), resolved as Node.js would from
   * the plugin's real path: the package found must be an unwritable tree,
   * and no nearer `node_modules` may let a shadowing copy be created.
   */
  runtimeImports(pluginDir: string) {
    const pkg = readPluginPackage(pluginDir);
    const specs = new Set<string>(pkg.deps);
    for (const entry of pkg.entries) {
      const file = path.resolve(pluginDir, entry);
      if (!file.startsWith(`${pluginDir}${path.sep}`)) {
        this.add(`${file} (plugin entry outside the plugin directory)`);
        continue;
      }
      let source: string;
      try {
        if (fs.statSync(file).size > MAX_ENTRY_BYTES) {
          this.add(`${file} (too large to check its imports)`);
          continue;
        }
        source = fs.readFileSync(file, "utf8");
      } catch {
        this.add(`${file} (could not check its imports)`);
        continue;
      }
      for (const spec of externalSpecifiers(source)) specs.add(spec);
    }
    const lookup = nodeModulesLookup(pluginDir);
    for (const spec of specs) {
      if (spec.startsWith("file:") || path.isAbsolute(spec)) {
        let p = spec;
        try {
          p = spec.startsWith("file:") ? fileURLToPath(spec) : spec;
        } catch {
          this.add(`${spec} (could not resolve the plugin's import)`);
          continue;
        }
        this.tree(p, "a module the Guardian plugin imports");
        this.ancestors(p, "a module the Guardian plugin imports");
        continue;
      }
      const name = packageName(spec);
      if (!name) {
        this.add(`${spec} (could not resolve the plugin's import)`);
        continue;
      }
      if (name === pkg.name) continue; // a self-reference: the plugin itself
      let found = false;
      for (const dir of lookup) {
        const candidate = path.join(dir, ...name.split("/"));
        const label = `${name} (imported by the Guardian plugin)`;
        if (exists(candidate)) {
          let real = candidate;
          try {
            real = fs.realpathSync(candidate);
          } catch {
            this.add(`${candidate} (could not check)`);
          }
          this.tree(real, label);
          this.ancestors(candidate, label);
          found = true;
          break;
        }
        // Not here: a copy created here would win, so it must not be creatable.
        this.creatable(candidate, label);
      }
      if (!found)
        this.add(`${spec} (imported by the Guardian plugin, not found)`);
    }
  }
}

const exists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Can the OpenClaw process user change the Guardian plugin, the OpenClaw
 * config or the plugin directory? Never throws: a failure is a problem.
 */
export function checkInstallIntegrity(
  opts: InstallCheckOptions = {},
): InstallCheckResult {
  let who: Identity = { uid: -1, gids: new Set(), real: false };
  try {
    who = identity(opts);
    if (who.uid === 0) {
      return {
        ok: false,
        uid: 0,
        problems: [
          "the OpenClaw Gateway runs as root, which can change every file",
        ],
      };
    }
    const env = opts.env ?? {};
    const c = new Checker(who);

    const pluginDir = opts.pluginDir ?? findPluginDir();
    if (!pluginDir) {
      c.problems.push("the Guardian plugin directory could not be found");
    } else {
      let real = pluginDir;
      try {
        real = fs.realpathSync(pluginDir);
      } catch {
        c.problems.push(`${pluginDir} (could not check)`);
      }
      c.tree(real, "the Guardian plugin");
      c.ancestors(pluginDir, "the Guardian plugin");
      c.runtimeImports(real);
    }

    const configDir = openclawConfigDir(env);
    const installed = path.join(configDir, "extensions", "guardian");
    if (exists(installed)) {
      c.tree(installed, "the Guardian plugin");
      c.ancestors(installed, "the Guardian plugin");
    }
    const extensions = path.join(configDir, "extensions");
    if (exists(extensions)) c.entry(extensions, "plugin", "dir");
    else c.creatable(extensions, "the plugin directory");
    // Managed npm installs (npm:, npm-pack:) and managed hooks (code the
    // Gateway imports at start-up when internal hooks are on).
    c.treeOrAbsent(path.join(configDir, "npm"), "the managed npm plugins");
    c.treeOrAbsent(path.join(configDir, "hooks"), "the managed hooks");

    const candidates = openclawConfigCandidates(env);
    const active = candidates.findIndex(exists);
    const upTo = active === -1 ? candidates : candidates.slice(0, active + 1);
    for (const candidate of upTo) {
      if (exists(candidate)) {
        c.entry(candidate, "the OpenClaw config", "file");
        const json5 = candidate.replace(/\.json$/, ".json5");
        if (json5 !== candidate && exists(json5)) {
          c.entry(json5, "the OpenClaw config", "file");
        }
      } else {
        c.creatable(candidate, "the OpenClaw config");
      }
    }
    // OpenClaw restores the config from `<config>.bak` when it reads as
    // damaged, and rotates older copies as `<config>.bak.<n>`.
    const activeConfig = active === -1 ? undefined : candidates[active];
    if (activeConfig) {
      const bak = `${activeConfig}.bak`;
      if (exists(bak)) c.entry(bak, "the OpenClaw config backup", "file");
      else c.creatable(bak, "the OpenClaw config backup");
      const dir = path.dirname(activeConfig);
      const prefix = `${path.basename(activeConfig)}.bak.`;
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(prefix)) {
          c.entry(path.join(dir, name), "the OpenClaw config backup", "file");
        }
      }
    }
    for (const dotenv of openclawDotEnvFiles(env, opts.cwd ?? process.cwd())) {
      if (exists(dotenv)) c.entry(dotenv, "the Gateway's start-up env", "file");
      else c.creatable(dotenv, "the Gateway's start-up env file");
    }
    for (const npmrc of npmConfigFiles(env, opts.nodePrefix)) {
      if (exists(npmrc)) c.entry(npmrc, "npm's config", "file");
      else c.creatable(npmrc, "an npm config file");
    }
    // Plugin catalogs (and the legacy plugins/installs.json install record).
    c.treeOrAbsent(path.join(configDir, "mpm"), "a plugin catalog");
    c.treeOrAbsent(path.join(configDir, "plugins"), "a plugin catalog");
    return c.problems.length
      ? { ok: false, uid: who.uid, problems: c.problems }
      : { ok: true };
  } catch {
    return {
      ok: false,
      uid: who.uid,
      problems: ["the install could not be checked"],
    };
  }
}

/**
 * The `GUARDIAN_*` keys named in `<cwd>/.env`, upper-cased. OpenClaw
 * 2026.7.1 loads that file into `process.env` at start-up (for keys not
 * already set) and does not filter `GUARDIAN_*`, so a value for one of
 * these keys may have come from a file in the agent's workspace, not from
 * the environment the operator started the Gateway with. Unreadable file:
 * none (the install check separately requires it to be read-only).
 */
export function workspaceDotEnvGuardianKeys(
  cwd: string = process.cwd(),
): Set<string> {
  const keys = new Set<string>();
  let text: string;
  try {
    text = fs.readFileSync(path.join(path.resolve(cwd), ".env"), "utf8");
  } catch {
    return keys;
  }
  // dotenv's own line syntax: optional `export`, then KEY= or KEY:
  for (const m of text.matchAll(
    /^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*(?:=|:)/gm,
  )) {
    const key = m[1]!.toUpperCase();
    if (key.startsWith("GUARDIAN_")) keys.add(key);
  }
  return keys;
}

/**
 * The Gateway environment with every `GUARDIAN_*` setting that may have come
 * from `<cwd>/.env` removed: Guardian honours its settings (the opt-out, the
 * credential, connection ids, base URL, agent name, approval timeout) only
 * from the environment the Gateway was really started with, or from the
 * start-up env files the install check protects.
 */
export function guardianStartupEnv(
  env: Env,
  cwd: string = process.cwd(),
): { env: Record<string, string | undefined>; ignored: string[] } {
  const named = workspaceDotEnvGuardianKeys(cwd);
  const out: Record<string, string | undefined> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (named.has(key.toUpperCase())) ignored.push(key);
    else out[key] = value;
  }
  return { env: out, ignored };
}

/** The block reason the agent (and the operator, in the log) sees. */
export function installProblemMessage(
  result: Extract<InstallCheckResult, { ok: false }>,
): string {
  const listed = result.problems.slice(0, MAX_LISTED).join("; ");
  const more =
    result.problems.length > MAX_LISTED
      ? ` and ${result.problems.length - MAX_LISTED} more`
      : "";
  return (
    `Guardian: the install is not protected, so the agent could switch Guardian off. ` +
    `The OpenClaw process user (uid ${result.uid}) can change: ${listed}${more}. ` +
    `Every tool call is blocked until an operator fixes this: run the Gateway as a non-root user, ` +
    `and as root make the Guardian plugin directory, the OpenClaw config file and its .bak, <state dir>/.env, <state dir>/extensions, ` +
    `<state dir>/npm, hooks, mpm and plugins, and $HOME/.npmrc ` +
    `owned by root and read-only (chown -R root:root <dir>; chmod -R a-w <dir>; chmod 0644 <config>), ` +
    `with root-owned parent directories (or chattr +i). See "Required: protect the install" in the ` +
    `@odingard/guardian-openclaw README. Nothing ran.`
  );
}
