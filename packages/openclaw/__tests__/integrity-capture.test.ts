import {
  chmodSync,
  chownSync,
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { register } from "../src/index.js";

import {
  captureDifference,
  checkInstallIntegrity,
  isPluginCapture,
  openclawPluginCapturesDir,
} from "../src/integrity.js";
import {
  chmodTree,
  OTHER_UID,
  protectedInstall,
  type Fixture,
} from "./install-fixture.js";

/**
 * OpenClaw 2026.11.x loads plugins from a copy it makes at start-up under
 * `<state dir>/tmp/plugin-captures/<uuid>/captures/…/openclaw-plugin-build-…`
 * (or `<os tmp>/openclaw-plugin-captures-<hash>-…`), owned by the Gateway user.
 */
let fx: Fixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

const problems = (f: Fixture, extra: object = {}) => {
  const r = checkInstallIntegrity({ ...f.install, ...extra });
  return r.ok ? [] : r.problems;
};

/** Copy `source` the way OpenClaw 2026.11.6 does; point the check at the copy. */
function capture(f: Fixture, source: string, base?: string): string {
  const root =
    base ??
    join(
      openclawPluginCapturesDir({ OPENCLAW_STATE_DIR: f.stateDir }),
      "c991adc0-f13e-498f-a12c-cc8ff4eea785",
      "captures",
      "plugin-preparation-B7N4A1",
    );
  const dir = join(
    root,
    "openclaw-plugin-build-uZfb7o",
    "package-0",
    "node_modules",
    "@odingard",
    "guardian-openclaw",
  );
  mkdirSync(dir, { recursive: true });
  cpSync(source, dir, { recursive: true });
  // The copy belongs to the Gateway user (when the tests can say so).
  if (process.getuid?.() === 0) {
    for (const p of [dir, join(dir, "dist"), join(dir, "dist", "index.js")]) {
      chownSync(p, OTHER_UID, OTHER_UID);
    }
  }
  chmodSync(join(dir, "dist", "index.js"), 0o600);
  (f.install as { pluginDir?: string }).pluginDir = dir;
  return dir;
}

/** A Gateway-writable copy of the install (as a `--link` target might be). */
function writableCopy(f: Fixture): string {
  const dir = join(f.root, "linked", "guardian-openclaw");
  mkdirSync(dir, { recursive: true });
  cpSync(f.pluginDir, dir, { recursive: true });
  chmodTree(join(f.root, "linked"));
  chmodSync(join(dir, "dist", "index.js"), 0o666);
  return dir;
}

describe("plugin copies (OpenClaw 2026.11.x)", () => {
  it("recognises the copy layouts, not an ordinary install", () => {
    fx = protectedInstall({ npm: true });
    const env = { OPENCLAW_STATE_DIR: fx.stateDir };
    const dir = capture(fx, fx.pluginDir);
    expect(isPluginCapture(dir, env)).toBe(true);
    expect(isPluginCapture(fx.pluginDir, env)).toBe(false);
    const tmp = join(fx.root, "ostmp");
    expect(
      isPluginCapture(join(tmp, "openclaw-plugin-captures-ab12-XYZ"), env, tmp),
    ).toBe(true);
    expect(isPluginCapture(join(tmp, "other"), env, tmp)).toBe(false);
  });

  it("passes when the copy matches a protected npm install", () => {
    fx = protectedInstall({ npm: true });
    const source = fx.pluginDir;
    capture(fx, source);
    expect(problems(fx)).toEqual([]);
  });

  it("passes when the copy matches a protected extensions/ install", () => {
    fx = protectedInstall();
    const ext = join(fx.extensions, "guardian");
    cpSync(fx.pluginDir, ext, { recursive: true });
    chmodTree(fx.root);
    capture(fx, ext);
    expect(problems(fx)).toEqual([]);
  });

  it("passes for OpenClaw's temp-directory fallback", () => {
    fx = protectedInstall({ npm: true });
    const tmp = join(fx.root, "ostmp");
    capture(
      fx,
      fx.pluginDir,
      join(tmp, "openclaw-plugin-captures-ab12-Q1w2E3"),
    );
    expect(problems(fx, { tmpDir: tmp })).toEqual([]);
  });

  it("blocks when the copy was changed", () => {
    fx = protectedInstall({ npm: true });
    const dir = capture(fx, fx.pluginDir);
    writeFileSync(join(dir, "dist", "index.js"), "export default {};");
    const p = problems(fx);
    expect(p.join("\n")).toMatch(/does not match a protected install/);
    expect(p.join("\n")).toMatch(/dist\/index\.js \(differs from/);
  });

  it("blocks when the copy has a file the install does not", () => {
    fx = protectedInstall({ npm: true });
    const dir = capture(fx, fx.pluginDir);
    writeFileSync(join(dir, "dist", "extra.js"), "");
    expect(problems(fx).join("\n")).toMatch(/extra\.js \(not in /);
  });

  it("blocks when no install of the plugin exists to compare with", () => {
    fx = protectedInstall();
    capture(fx, fx.pluginDir); // the source is outside npm/ and extensions/
    expect(problems(fx).join("\n")).toMatch(/no install of the plugin found/);
  });

  it("checks OpenClaw's source (a --link install) and only if it matches", () => {
    fx = protectedInstall();
    const source = fx.pluginDir;
    const dir = capture(fx, source);
    expect(problems(fx, { sourceDir: source })).toEqual([]);
    writeFileSync(join(dir, "README.md"), "changed");
    expect(problems(fx, { sourceDir: source }).join("\n")).toMatch(
      /does not match it/,
    );
  });

  it("passes when OpenClaw's source is the protected install", () => {
    fx = protectedInstall({ npm: true });
    capture(fx, fx.pluginDir);
    expect(problems(fx, { sourceDir: fx.pluginDir })).toEqual([]);
  });

  it("blocks a writable --link source even if a protected install is identical", () => {
    fx = protectedInstall({ npm: true });
    const linked = writableCopy(fx);
    capture(fx, fx.pluginDir);
    const p = problems(fx, { sourceDir: linked });
    expect(p.length).toBeGreaterThan(0);
    expect(p.join("\n")).toContain(linked);
  });

  it("blocks a named source whose path looks like a copy, with no fallback search", () => {
    fx = protectedInstall({ npm: true });
    const dir = join(
      fx.root,
      "openclaw-plugin-build-guardian",
      "guardian-openclaw",
    );
    mkdirSync(dir, { recursive: true });
    cpSync(fx.pluginDir, dir, { recursive: true });
    chmodSync(join(dir, "dist", "index.js"), 0o666);
    capture(fx, fx.pluginDir);
    const p = problems(fx, { sourceDir: dir });
    expect(p.join("\n")).toMatch(/looks like a start-up copy/);
  });

  it("blocks when two installs match and OpenClaw names no source", () => {
    fx = protectedInstall({ npm: true });
    const ext = join(fx.extensions, "guardian");
    cpSync(fx.pluginDir, ext, { recursive: true });
    chmodTree(fx.root);
    capture(fx, fx.pluginDir);
    expect(problems(fx).join("\n")).toMatch(/more than one install matches/);
  });

  it("blocks when the install the copy was made from is writable", () => {
    fx = protectedInstall({ npm: true });
    const source = fx.pluginDir;
    capture(fx, source);
    chmodSync(join(source, "dist", "index.js"), 0o666);
    expect(problems(fx)).toContain(join(source, "dist", "index.js"));
  });

  it("blocks when the install's parent directory lets the user replace it", () => {
    fx = protectedInstall({ npm: true });
    capture(fx, fx.pluginDir);
    chmodSync(fx.npmDir, 0o777);
    expect(problems(fx).join("\n")).toMatch(/can rename the Guardian plugin/);
  });

  it("blocks a non-builtin import: Node.js would resolve it from the writable copy", () => {
    fx = protectedInstall({ npm: true });
    const source = fx.pluginDir;
    const index = join(source, "dist", "index.js");
    chmodSync(index, 0o644);
    writeFileSync(index, 'import z from "zod";\nexport default {};');
    chmodTree(fx.root);
    capture(fx, source);
    expect(problems(fx).join("\n")).toMatch(
      /zod \(imported by the Guardian plugin, resolved from OpenClaw's Gateway-writable copy/,
    );
  });

  it("other config checks still apply (writable openclaw.json)", () => {
    fx = protectedInstall({ npm: true });
    capture(fx, fx.pluginDir);
    chmodSync(fx.config, 0o666);
    expect(problems(fx)).toContain(fx.config);
  });

  it("captureDifference compares bytes, not just sizes", () => {
    fx = protectedInstall({ npm: true });
    const dir = capture(fx, fx.pluginDir);
    expect(captureDifference(dir, fx.pluginDir)).toBeUndefined();
    const f = join(dir, "openclaw.plugin.json");
    const body = readFileSync(f, "utf8");
    writeFileSync(f, body.replace("guardian", "guardiax"));
    expect(captureDifference(dir, fx.pluginDir)).toMatch(/differs from/);
  });

  it("an ordinary (2026.7.1) npm install is still checked in place", () => {
    fx = protectedInstall({ npm: true });
    expect(problems(fx)).toEqual([]);
    chmodSync(join(fx.pluginDir, "dist", "index.js"), 0o666);
    expect(problems(fx)).toContain(join(fx.pluginDir, "dist", "index.js"));
  });
});

describe("register() on OpenClaw 2026.11.x", () => {
  const run = async (f: Fixture, rootDir: string) => {
    const on = vi.fn();
    const warn = vi.fn();
    register(
      { id: "guardian", config: {}, rootDir, logger: { warn }, on },
      {
        cwd: f.cwd,
        env: { ...f.install.env, GUARDIAN_AGENT_CREDENTIAL: "" },
        slot: {},
        install: f.install,
      },
    );
    const handler = on.mock.calls[0]![1] as (
      e: unknown,
      c: unknown,
    ) => Promise<{ block?: boolean; blockReason?: string } | undefined>;
    return handler({ toolName: "exec", params: { command: "ls" } }, {});
  };

  it("does not block the first call on the install check when rootDir is the protected install", async () => {
    fx = protectedInstall({ npm: true });
    capture(fx, fx.pluginDir);
    const r = await run(fx, fx.pluginDir);
    // Not configured, so it blocks, but not because of the install.
    expect(r?.blockReason).toMatch(/not configured|credential/i);
    expect(r?.blockReason ?? "").not.toMatch(/install is not protected/);
  });

  it("blocks the first call when rootDir is a writable copy", async () => {
    fx = protectedInstall({ npm: true });
    const linked = writableCopy(fx);
    capture(fx, fx.pluginDir);
    const r = await run(fx, linked);
    expect(r?.block).toBe(true);
    expect(r?.blockReason).toMatch(/install is not protected/);
    expect(r?.blockReason).toContain(linked);
  });
});
