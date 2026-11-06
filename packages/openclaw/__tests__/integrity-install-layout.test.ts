import { execSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecideOptions } from "../../hook/src/decide.js";
import {
  ALLOW_WRITABLE_INSTALL_ENV,
  checkInstallIntegrity,
  createGuardianToolHandler,
  externalSpecifiers,
  guardianStartupEnv,
  importSpecifiers,
  nodeModulesLookup,
  openclawConfigDir,
  register,
  workspaceDotEnvGuardianKeys,
} from "../src/index.js";
import {
  chmodTree,
  protectedInstall,
  type Fixture,
} from "./install-fixture.js";

/** Install integrity: bundled deps, npm layout, cwd .env, hooks. */
const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

let fx: Fixture | undefined;
let scratch: string | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

const problems = (f: Fixture) => {
  const r = checkInstallIntegrity(f.install);
  return r.ok ? [] : r.problems;
};

describe("B1: the plugin is self-contained", () => {
  it("the build bundles every runtime dependency: dist imports only Node.js builtins", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    expect(pkg.scripts.build).not.toMatch(/--external/);
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
    // Build exactly as `npm run build` does, into a scratch file.
    scratch = mkdtempSync(join(tmpdir(), "guardian-build-"));
    const out = join(scratch, "index.js");
    const cmd = String(pkg.scripts.build).replace(
      "--outfile=dist/index.js",
      `--outfile=${out} --log-level=error`,
    );
    expect(cmd).toContain(out);
    execSync(`npx ${cmd}`, { cwd: PKG, stdio: "pipe" });
    const source = readFileSync(out, "utf8");
    const specs = importSpecifiers(source);
    expect(specs.length).toBeGreaterThan(0); // the scanner sees node: imports
    expect(specs.every((s) => s.startsWith("node:"))).toBe(true);
    expect(externalSpecifiers(source)).toEqual([]);
  }, 60_000);

  it("the import scanner finds static, side-effect, dynamic and require imports", () => {
    const src = [
      'import { a } from "@odingard/guardian-sdk";',
      "import {\n  b,\n  c as d\n} from 'zod';",
      'import "side-effect";',
      'export * from "re-export/sub";',
      'const m = await import("dyn");',
      'const r = __require("cjs");',
      'import * as fs from "node:fs";',
      'import path from "path";',
      'import x from "./local.js";',
    ].join("\n");
    expect(externalSpecifiers(src).sort()).toEqual(
      [
        "@odingard/guardian-sdk",
        "cjs",
        "dyn",
        "re-export/sub",
        "side-effect",
        "zod",
      ].sort(),
    );
  });

  it("an external import resolved outside the plugin tree is checked (npm sibling)", () => {
    fx = protectedInstall({ npm: true });
    const entry = join(fx.pluginDir, "dist", "index.js");
    writeFileSync(entry, 'import { x } from "@odingard/guardian-sdk";\n');
    chmodSync(entry, 0o644);
    // Not installed anywhere: fails closed.
    expect(problems(fx).join("\n")).toMatch(
      /@odingard\/guardian-sdk \(imported by the Guardian plugin, not found\)/,
    );
    // Installed as the npm sibling, read-only: passes.
    const sdk = join(dirname(fx.pluginDir), "guardian-sdk");
    mkdirSync(join(sdk, "dist"), { recursive: true });
    writeFileSync(join(sdk, "package.json"), "{}");
    writeFileSync(join(sdk, "dist", "index.js"), "export const x = 1;");
    chmodTree(fx.root);
    expect(checkInstallIntegrity(fx.install)).toEqual({ ok: true });
    // A writable file in it: blocks (the agent could rewrite the SDK).
    chmodSync(join(sdk, "dist", "index.js"), 0o666);
    expect(problems(fx)).toContain(join(sdk, "dist", "index.js"));
  });

  it("a declared dependency is checked even if the entry does not import it", () => {
    fx = protectedInstall();
    const pkgFile = join(fx.pluginDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    writeFileSync(
      pkgFile,
      JSON.stringify({ ...pkg, dependencies: { zod: "^4" } }),
    );
    chmodSync(pkgFile, 0o644);
    expect(problems(fx).join("\n")).toMatch(/zod .*not found/);
  });

  it("a nearer node_modules where a shadowing copy could be created blocks", () => {
    // A local-path install at <root>/plugin that imports "dep", which
    // Node.js finds in <root>/node_modules (not an ancestor of the plugin).
    fx = protectedInstall();
    const entry = join(fx.pluginDir, "dist", "index.js");
    writeFileSync(entry, 'import "dep";\n');
    const nm = join(fx.root, "node_modules");
    mkdirSync(join(nm, "dep"), { recursive: true });
    writeFileSync(join(nm, "dep", "index.js"), "");
    chmodTree(fx.root);
    expect(checkInstallIntegrity(fx.install)).toEqual({ ok: true });
    // dep gone, and its node_modules writable: a copy could be planted there.
    rmSync(join(nm, "dep"), { recursive: true });
    chmodSync(nm, 0o777); // not an ancestor of the plugin: only lookup sees it
    const found = problems(fx).join("\n");
    expect(found).toContain(
      `${nm} (can create dep (imported by the Guardian plugin) ${join(nm, "dep")})`,
    );
    expect(found).toMatch(/dep \(imported by the Guardian plugin, not found\)/);
  });

  it("ESM lookup walks node_modules up from the plugin, no global folders", () => {
    expect(nodeModulesLookup("/s/npm/p/node_modules/@o/g")).toEqual([
      "/s/npm/p/node_modules/@o/g/node_modules",
      "/s/npm/p/node_modules/@o/node_modules",
      "/s/npm/p/node_modules",
      "/s/npm/node_modules",
      "/s/node_modules",
      "/node_modules",
    ]);
  });
});

describe("B2: the managed npm install location is covered", () => {
  it("a protected npm-layout install passes", () => {
    fx = protectedInstall({ npm: true });
    expect(checkInstallIntegrity(fx.install)).toEqual({ ok: true });
  });

  it("a writable file anywhere under <state>/npm blocks (the project package.json too)", () => {
    fx = protectedInstall({ npm: true });
    const projectPkg = join(
      dirname(dirname(dirname(fx.pluginDir))),
      "package.json",
    );
    chmodSync(projectPkg, 0o666);
    expect(problems(fx)).toContain(projectPkg);
  });

  it("a writable <state>/npm/projects blocks (the plugin could be renamed away)", () => {
    fx = protectedInstall({ npm: true });
    const projects = join(fx.npmDir, "projects");
    chmodSync(projects, 0o777);
    expect(problems(fx)).toContain(projects);
  });

  it("a missing <state>/npm that could be created blocks", () => {
    fx = protectedInstall();
    rmSync(fx.npmDir, { recursive: true });
    chmodSync(fx.stateDir, 0o1777);
    expect(problems(fx).join("\n")).toMatch(
      /can create the managed npm plugins .*\/npm/,
    );
  });

  it("the config dir follows OpenClaw's resolveConfigDir", () => {
    expect(openclawConfigDir({ HOME: "/h" })).toBe("/h/.openclaw");
    expect(openclawConfigDir({ HOME: "/h", OPENCLAW_STATE_DIR: "/s" })).toBe(
      "/s",
    );
    expect(
      openclawConfigDir({ HOME: "/h", OPENCLAW_CONFIG_PATH: "/c/x.json" }),
    ).toBe("/c");
  });
});

describe("N2: managed hooks are code the Gateway loads", () => {
  it("a writable <state>/hooks, or a file in it, blocks", () => {
    fx = protectedInstall();
    chmodSync(fx.hooksDir, 0o777);
    expect(problems(fx)).toContain(fx.hooksDir);
    chmodSync(fx.hooksDir, 0o755);
    mkdirSync(join(fx.hooksDir, "session-memory"));
    writeFileSync(join(fx.hooksDir, "session-memory", "handler.js"), "");
    chmodSync(join(fx.hooksDir, "session-memory"), 0o755);
    chmodSync(join(fx.hooksDir, "session-memory", "handler.js"), 0o666);
    expect(problems(fx)).toContain(
      join(fx.hooksDir, "session-memory", "handler.js"),
    );
  });

  it("a missing <state>/hooks that could be created blocks", () => {
    fx = protectedInstall();
    rmSync(fx.hooksDir, { recursive: true });
    chmodSync(fx.stateDir, 0o1777);
    expect(problems(fx).join("\n")).toMatch(/can create the managed hooks/);
  });
});

describe("N1: the Gateway working directory's .env", () => {
  it("is checked: writable, or creatable, blocks", () => {
    fx = protectedInstall();
    chmodSync(fx.cwd, 0o777);
    expect(problems(fx).join("\n")).toContain(
      `${fx.cwd} (can create the Gateway's start-up env file ${join(fx.cwd, ".env")})`,
    );
    chmodSync(fx.cwd, 0o755);
    writeFileSync(join(fx.cwd, ".env"), "");
    chmodSync(join(fx.cwd, ".env"), 0o666);
    expect(problems(fx)).toContain(join(fx.cwd, ".env"));
    chmodSync(join(fx.cwd, ".env"), 0o644);
    expect(checkInstallIntegrity(fx.install)).toEqual({ ok: true });
  });

  it("GUARDIAN_* keys named in it are ignored, whatever their value", () => {
    scratch = mkdtempSync(join(tmpdir(), "guardian-cwd-"));
    writeFileSync(
      join(scratch, ".env"),
      [
        "# comment",
        `${ALLOW_WRITABLE_INSTALL_ENV}=1`,
        "export GUARDIAN_CONNECTION_ID=pcn_agent",
        "guardian_hook_ask_connection_id: pcn_agent2",
        "OTHER=1",
      ].join("\n"),
    );
    expect([...workspaceDotEnvGuardianKeys(scratch)].sort()).toEqual(
      [
        ALLOW_WRITABLE_INSTALL_ENV,
        "GUARDIAN_CONNECTION_ID",
        "GUARDIAN_HOOK_ASK_CONNECTION_ID",
      ].sort(),
    );
    const { env, ignored } = guardianStartupEnv(
      {
        [ALLOW_WRITABLE_INSTALL_ENV]: "1",
        GUARDIAN_CONNECTION_ID: "pcn_agent",
        GUARDIAN_HOOK_ASK_CONNECTION_ID: "pcn_real",
        GUARDIAN_HOOK_AGENT_NAME: "real",
        OTHER: "1",
      },
      scratch,
    );
    expect(ignored.sort()).toEqual(
      [
        ALLOW_WRITABLE_INSTALL_ENV,
        "GUARDIAN_CONNECTION_ID",
        "GUARDIAN_HOOK_ASK_CONNECTION_ID",
      ].sort(),
    );
    expect(env).toEqual({ GUARDIAN_HOOK_AGENT_NAME: "real", OTHER: "1" });
  });

  it("an opt-out or connection id from <cwd>/.env does not reach the handler", async () => {
    fx = protectedInstall();
    chmodSync(fx.config, 0o666); // writable install: only the opt-out lets calls run
    writeFileSync(
      join(fx.cwd, ".env"),
      `${ALLOW_WRITABLE_INSTALL_ENV}=1\nGUARDIAN_CONNECTION_ID=pcn_agent\n`,
    );
    const seen: string[] = [];
    const client: DecideOptions["client"] = {
      async request(i) {
        seen.push(`${i.connectionId}`);
        return {
          ok: true,
          requestId: "r",
          decision: "ALLOW",
          capabilityToken: "c",
        };
      },
      async claim() {
        return { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "r" };
      },
      async execute() {
        return { ok: true, receipt: { receiptReference: "r" } as never };
      },
    };
    const warn = vi.fn();
    const handler = createGuardianToolHandler({
      client,
      config: {},
      env: {
        [ALLOW_WRITABLE_INSTALL_ENV]: "1",
        GUARDIAN_CONNECTION_ID: "pcn_agent",
      },
      install: fx.install,
      logger: { warn },
    });
    const out = await handler({ toolName: "exec", params: { command: "ls" } });
    expect(out?.blockReason).toMatch(/install is not protected/);
    expect(seen).toEqual([]);
    expect(warn.mock.calls.flat().join("\n")).toMatch(
      new RegExp(
        `ignoring ${ALLOW_WRITABLE_INSTALL_ENV}, GUARDIAN_CONNECTION_ID`,
      ),
    );
  });

  it("register(): a credential named in <cwd>/.env is removed and not used", async () => {
    scratch = mkdtempSync(join(tmpdir(), "guardian-cwd-"));
    writeFileSync(
      join(scratch, ".env"),
      `GUARDIAN_AGENT_CREDENTIAL=gac1.agent\n${ALLOW_WRITABLE_INSTALL_ENV}=1\n`,
    );
    const env: Record<string, string | undefined> = {
      GUARDIAN_AGENT_CREDENTIAL: "gac1.agent",
      [ALLOW_WRITABLE_INSTALL_ENV]: "1",
      GUARDIAN_CONNECTION_ID: "pcn_e",
    };
    const on = vi.fn();
    const warn = vi.fn();
    const slot = Symbol.for("odingard.guardian-openclaw.credential");
    const g = globalThis as Record<symbol, unknown>;
    const before = g[slot];
    delete g[slot];
    try {
      register(
        { id: "guardian", pluginConfig: {}, logger: { warn }, on },
        { cwd: scratch, env },
      );
      expect(env.GUARDIAN_AGENT_CREDENTIAL).toBeUndefined(); // scrubbed
      expect(g[slot]).toBeUndefined(); // not kept
      const handler = on.mock.calls[0]![1];
      const out = await handler({
        toolName: "exec",
        params: { command: "ls" },
      });
      // The opt-out was ignored, so the (writable) checkout is checked.
      expect(out?.blockReason).toMatch(/install is not protected/);
      expect(warn.mock.calls.flat().join("\n")).toMatch(
        /ignoring .*GUARDIAN_AGENT_CREDENTIAL/,
      );
    } finally {
      if (before === undefined) delete g[slot];
      else g[slot] = before;
    }
  });
});
