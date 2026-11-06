import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InstallCheckOptions } from "../src/integrity.js";

/**
 * A uid that is not this process's, so the check judges the fixture by its
 * inode alone (owner, mode bits) even when the tests run as root, where
 * access(W_OK) always succeeds.
 */
export const OTHER_UID = process.getuid?.() === 4242 ? 4243 : 4242;

export type Fixture = {
  root: string;
  pluginDir: string;
  stateDir: string;
  config: string;
  extensions: string;
  dotenv: string;
  npmDir: string;
  hooksDir: string;
  mpmDir: string;
  pluginsDir: string;
  home: string;
  npmrc: string;
  cwd: string;
  install: InstallCheckOptions;
  cleanup: () => void;
};

/**
 * A protected install: plugin directory, state directory with openclaw.json,
 * openclaw.json.bak, .env, extensions/, npm/, hooks/, mpm/ and plugins/, and the Gateway's working directory
 * (no .env) and HOME with an empty .npmrc, all owned by this process (not OTHER_UID), directories 0755
 * and files 0644. With `npm`, the plugin sits where OpenClaw 2026.7.1's
 * `npm:` / `npm-pack:` install puts it:
 * `<state>/npm/projects/<name>/node_modules/@odingard/guardian-openclaw`.
 */
export function protectedInstall(opts: { npm?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "guardian-install-"));
  chmodSync(root, 0o755);
  const stateDir = join(root, "state");
  const npmDir = join(stateDir, "npm");
  const project = join(
    npmDir,
    "projects",
    "odingard-guardian-openclaw-5825bd791f",
  );
  const pluginDir = opts.npm
    ? join(project, "node_modules", "@odingard", "guardian-openclaw")
    : join(root, "plugin");
  mkdirSync(join(pluginDir, "dist"), { recursive: true, mode: 0o755 });
  writeFileSync(join(pluginDir, "openclaw.plugin.json"), '{"id":"guardian"}');
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@odingard/guardian-openclaw",
      type: "module",
      main: "dist/index.js",
      openclaw: { extensions: ["./dist/index.js"] },
    }),
  );
  writeFileSync(
    join(pluginDir, "dist", "index.js"),
    'import * as fs from "node:fs";\nexport default {};',
  );
  const extensions = join(stateDir, "extensions");
  const hooksDir = join(stateDir, "hooks");
  const mpmDir = join(stateDir, "mpm");
  const pluginsDir = join(stateDir, "plugins");
  for (const d of [extensions, npmDir, hooksDir, mpmDir, pluginsDir]) {
    mkdirSync(d, { recursive: true, mode: 0o755 });
  }
  if (opts.npm) {
    writeFileSync(join(project, "package.json"), "{}");
  }
  const cwd = join(root, "cwd");
  mkdirSync(cwd, { mode: 0o755 });
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o755 });
  const npmrc = join(home, ".npmrc");
  writeFileSync(npmrc, "");
  const config = join(stateDir, "openclaw.json");
  writeFileSync(config, "{}");
  writeFileSync(`${config}.bak`, "");
  const dotenv = join(stateDir, ".env");
  writeFileSync(dotenv, "");
  chmodTree(root);
  return {
    root,
    pluginDir,
    stateDir,
    config,
    extensions,
    dotenv,
    npmDir,
    hooksDir,
    mpmDir,
    pluginsDir,
    home,
    npmrc,
    cwd,
    install: {
      pluginDir,
      uid: OTHER_UID,
      gids: [OTHER_UID],
      cwd,
      env: { HOME: home, OPENCLAW_STATE_DIR: stateDir },
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Directories 0755, files 0644, everything under `dir`. */
export function chmodTree(dir: string): void {
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const p = join(dir, name);
    chmodSync(p, statSync(p).isDirectory() ? 0o755 : 0o644);
  }
  chmodSync(dir, 0o755);
}
