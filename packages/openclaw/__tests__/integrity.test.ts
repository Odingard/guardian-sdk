import {
  chmodSync,
  chownSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecideOptions } from "../../hook/src/decide.js";
import {
  ALLOW_WRITABLE_INSTALL_ENV,
  checkInstallIntegrity,
  createGuardianToolHandler,
  findPluginDir,
  openclawConfigCandidates,
  openclawDotEnvFiles,
  register,
} from "../src/index.js";
import {
  OTHER_UID,
  protectedInstall,
  type Fixture,
} from "./install-fixture.js";

/** Tamper-resistance of the install is a precondition, enforced. */
type Client = DecideOptions["client"];

function fakeGuardian(decision: "ALLOW" | "DENY" = "ALLOW") {
  const seen: string[] = [];
  const client: Client = {
    async request(invocation) {
      seen.push("toolName" in invocation ? invocation.toolName : "");
      return decision === "ALLOW"
        ? { ok: true, requestId: "req_1", decision, capabilityToken: "cap" }
        : {
            ok: true,
            requestId: "req_1",
            decision,
            reasonCode: "NOT_AUTHORIZED",
          };
    },
    async claim() {
      return { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "req_1" };
    },
    async execute() {
      return {
        ok: true,
        receipt: { receiptReference: "r", status: "succeeded" } as never,
      };
    },
  };
  return { client, seen };
}

const CONFIG = { connectionId: "pcn_everyday", askConnectionId: "pcn_ask" };
const exec = (command: string) => ({ toolName: "exec", params: { command } });
const isRoot = process.getuid?.() === 0;

let fx: Fixture;
afterEach(() => fx?.cleanup());

function handlerFor(
  f: Fixture,
  extra: Partial<Parameters<typeof createGuardianToolHandler>[0]> = {},
) {
  const g = fakeGuardian();
  let t = 1_000_000;
  const warn = vi.fn();
  const handler = createGuardianToolHandler({
    config: CONFIG,
    client: g.client,
    install: f.install,
    now: () => t,
    wait: async (ms) => {
      t += ms;
    },
    logger: { warn },
    ...extra,
  });
  return { handler, g, warn, advance: (ms: number) => (t += ms) };
}

async function expectBlocked(
  h: ReturnType<typeof handlerFor>,
  mentions: string | RegExp,
) {
  for (const event of [
    exec("ls"),
    { toolName: "read", params: { path: "README.md" } },
    { toolName: "write", params: { path: "a.md", content: "x" } },
  ]) {
    const out = await h.handler(event);
    expect(out?.block, event.toolName).toBe(true);
    expect(out?.blockReason).toMatch(mentions);
    expect(out?.blockReason).toMatch(/Required: protect the install/);
  }
  expect(h.g.seen).toEqual([]); // Guardian is never asked
}

describe("install integrity: a writable install blocks every tool call", () => {
  it("a protected install passes, and the normal flow runs", async () => {
    fx = protectedInstall();
    expect(checkInstallIntegrity(fx.install)).toEqual({ ok: true });
    const h = handlerFor(fx);
    expect(await h.handler(exec("ls"))).toEqual({ params: { command: "ls" } });
    expect(
      await h.handler({ toolName: "read", params: { path: "x" } }),
    ).toBeUndefined();
    expect(h.g.seen).toEqual(["shell"]);
    expect(h.warn).not.toHaveBeenCalled();

    const deny = fakeGuardian("DENY");
    const denied = createGuardianToolHandler({
      config: CONFIG,
      client: deny.client,
      install: fx.install,
    });
    expect((await denied(exec("rm -rf /")))?.block).toBe(true);
    expect(deny.seen).toEqual(["shell_destructive"]);
  });

  it("a writable plugin directory blocks and never calls Guardian", async () => {
    fx = protectedInstall();
    chmodSync(fx.pluginDir, 0o777);
    const h = handlerFor(fx);
    await expectBlocked(h, fx.pluginDir);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("not protected"),
    );
  });

  it("a writable file inside the plugin blocks", async () => {
    fx = protectedInstall();
    chmodSync(join(fx.pluginDir, "dist", "index.js"), 0o666);
    await expectBlocked(handlerFor(fx), /dist\/index\.js/);
  });

  it("a group-writable file blocks only for a member of that group", () => {
    fx = protectedInstall();
    const file = join(fx.pluginDir, "dist", "index.js");
    chmodSync(file, 0o664);
    // The file's own group (a setgid tmp dir may give it one other than ours).
    const gid = statSync(file).gid;
    expect(checkInstallIntegrity({ ...fx.install, gids: [gid] }).ok).toBe(
      false,
    );
    expect(checkInstallIntegrity({ ...fx.install, gids: [gid + 1] }).ok).toBe(
      true,
    );
  });

  it("a writable OpenClaw config blocks", async () => {
    fx = protectedInstall();
    chmodSync(fx.config, 0o666);
    await expectBlocked(handlerFor(fx), fx.config);
  });

  it("OPENCLAW_CONFIG_PATH is the config that is checked", async () => {
    fx = protectedInstall();
    const elsewhere = join(fx.root, "conf.json5");
    writeFileSync(elsewhere, "{}");
    chmodSync(elsewhere, 0o666);
    fx.install = {
      ...fx.install,
      env: { ...fx.install.env, OPENCLAW_CONFIG_PATH: elsewhere },
    };
    await expectBlocked(handlerFor(fx), elsewhere);
  });

  it("a writable extensions/ directory blocks (a new plugin could be added)", async () => {
    fx = protectedInstall();
    chmodSync(fx.extensions, 0o777);
    await expectBlocked(handlerFor(fx), fx.extensions);
  });

  it("a writable parent blocks: the plugin or config could be renamed away", async () => {
    fx = protectedInstall();
    chmodSync(fx.root, 0o777);
    await expectBlocked(handlerFor(fx), `${fx.root} (can rename`);
  });

  it("a sticky writable parent is fine while the entries belong to someone else", async () => {
    fx = protectedInstall();
    chmodSync(fx.root, 0o1777);
    chmodSync(fx.stateDir, 0o1777); // the Gateway may still create state files
    expect(checkInstallIntegrity(fx.install)).toEqual({ ok: true });
  });

  it("a config the agent could create ahead of the real one blocks", async () => {
    fx = protectedInstall();
    rmSync(fx.config);
    chmodSync(fx.stateDir, 0o777);
    await expectBlocked(handlerFor(fx), /can create the OpenClaw config/);
  });

  it("the start-up dotenv files are config too: writable, or creatable, blocks", async () => {
    fx = protectedInstall();
    chmodSync(fx.dotenv, 0o666);
    await expectBlocked(handlerFor(fx), fx.dotenv);
    fx.cleanup();
    fx = protectedInstall();
    rmSync(fx.dotenv);
    chmodSync(fx.stateDir, 0o1777); // sticky: entries are safe, creation is not
    await expectBlocked(
      handlerFor(fx),
      /can create the Gateway's start-up env/,
    );
    expect(openclawDotEnvFiles({ HOME: "/h" }, "/w")).toEqual([
      "/w/.env",
      "/h/.openclaw/.env",
      "/h/.config/openclaw/gateway.env",
    ]);
    expect(
      openclawDotEnvFiles({ HOME: "/h", OPENCLAW_STATE_DIR: "/s" }, "/w"),
    ).toEqual(["/w/.env", "/s/.env"]);
  });

  it("only the config candidates OpenClaw would read first are checked", () => {
    const c = openclawConfigCandidates({
      HOME: "/h",
      OPENCLAW_STATE_DIR: "/s",
    });
    expect(c).toEqual([
      "/s/openclaw.json",
      "/s/clawdbot.json",
      "/h/.openclaw/openclaw.json",
      "/h/.openclaw/clawdbot.json",
      "/h/.clawdbot/openclaw.json",
      "/h/.clawdbot/clawdbot.json",
    ]);
    expect(
      openclawConfigCandidates({
        OPENCLAW_CONFIG_PATH: "~/c.json5",
        HOME: "/h",
      }),
    ).toEqual(["/h/c.json5"]);
  });

  it("a symlink in the plugin to a writable file blocks", async () => {
    fx = protectedInstall();
    const outside = join(fx.root, "outside.js");
    writeFileSync(outside, "");
    chmodSync(outside, 0o666);
    chmodSync(fx.pluginDir, 0o755);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, join(fx.pluginDir, "dist", "linked.js"));
    await expectBlocked(handlerFor(fx), outside);
  });

  it("checks are cached for at most 5 s, then re-run", async () => {
    fx = protectedInstall();
    const h = handlerFor(fx);
    expect((await h.handler(exec("ls")))?.block).toBeUndefined();
    chmodSync(fx.config, 0o666);
    h.advance(4_000);
    expect((await h.handler(exec("ls")))?.block).toBeUndefined();
    h.advance(1_000);
    expect((await h.handler(exec("ls")))?.block).toBe(true);
  });

  it("a crash inside the check counts as writable", () => {
    fx = protectedInstall();
    const out = checkInstallIntegrity({
      ...fx.install,
      pluginDir: join(fx.root, "missing"),
    });
    expect(out.ok).toBe(false);
  });

  it("finds its own plugin directory from its module path", () => {
    expect(findPluginDir()).toMatch(/packages\/openclaw$/);
  });
});

describe("the root rule", () => {
  it("a Gateway running as uid 0 always fails, even on a read-only install", async () => {
    fx = protectedInstall();
    fx.install = { ...fx.install, uid: 0, gids: [0] };
    expect(checkInstallIntegrity(fx.install)).toMatchObject({
      ok: false,
      uid: 0,
    });
    await expectBlocked(handlerFor(fx), /runs as root/);
  });

  it.skipIf(!isRoot)(
    "the real check, run as root here, fails without any override",
    () => {
      expect(checkInstallIntegrity({}).ok).toBe(false);
    },
  );

  it.skipIf(!isRoot)(
    "an entry the Gateway user owns is writable even at mode 0444 (it can chmod)",
    () => {
      fx = protectedInstall();
      const file = join(fx.pluginDir, "dist", "index.js");
      chmodSync(file, 0o444);
      chownSync(file, OTHER_UID, OTHER_UID);
      expect(checkInstallIntegrity(fx.install)).toMatchObject({ ok: false });
    },
  );
});

describe(`${ALLOW_WRITABLE_INSTALL_ENV} (opt-out)`, () => {
  it("is read once, when the handler is created", async () => {
    fx = protectedInstall();
    chmodSync(fx.config, 0o666);
    const env: Record<string, string | undefined> = {};
    const h = handlerFor(fx, { env });
    expect((await h.handler(exec("ls")))?.block).toBe(true);
    // Set later (by the agent, or by anything else): ignored.
    env[ALLOW_WRITABLE_INSTALL_ENV] = "1";
    process.env[ALLOW_WRITABLE_INSTALL_ENV] = "1";
    try {
      h.advance(10_000);
      expect((await h.handler(exec("ls")))?.block).toBe(true);
    } finally {
      delete process.env[ALLOW_WRITABLE_INSTALL_ENV];
    }
    expect(h.g.seen).toEqual([]);
  });

  it("set at load, it keeps the pattern-based behaviour and warns once", async () => {
    fx = protectedInstall();
    chmodSync(fx.config, 0o666);
    const env: Record<string, string | undefined> = {
      [ALLOW_WRITABLE_INSTALL_ENV]: "1",
    };
    const h = handlerFor(fx, { env });
    expect(h.warn).toHaveBeenCalledOnce();
    expect(h.warn.mock.calls[0]![0]).toMatch(/tamper-proof/);
    delete env[ALLOW_WRITABLE_INSTALL_ENV];
    expect(await h.handler(exec("ls"))).toEqual({ params: { command: "ls" } });
    expect(h.g.seen).toEqual(["shell"]);
    // The pattern backstop still applies.
    expect((await h.handler(exec("mv ../extensions/guardian x")))?.block).toBe(
      undefined,
    );
    expect(h.g.seen).toEqual(["shell", "shell_destructive"]);
  });

  it("register() takes it from the Gateway environment at load only", async () => {
    const run = async (atLoad: boolean) => {
      const on = vi.fn();
      const warn = vi.fn();
      if (atLoad) process.env[ALLOW_WRITABLE_INSTALL_ENV] = "1";
      try {
        register({
          id: "guardian",
          pluginConfig: CONFIG,
          logger: { warn },
          on,
        });
      } finally {
        delete process.env[ALLOW_WRITABLE_INSTALL_ENV];
      }
      if (!atLoad) process.env[ALLOW_WRITABLE_INSTALL_ENV] = "1";
      try {
        const handler = on.mock.calls[0]![1];
        return { out: await handler(exec("ls")), warn };
      } finally {
        delete process.env[ALLOW_WRITABLE_INSTALL_ENV];
      }
    };
    // Set after load: the install check still applies. (This checkout is
    // writable by its owner, and root fails the check, so it blocks.)
    const late = await run(false);
    expect(late.out?.blockReason).toMatch(/install is not protected/);
    // Set at load: no install check; blocked only for missing credentials.
    const early = await run(true);
    expect(early.out?.blockReason).not.toMatch(/install is not protected/);
    expect(early.warn.mock.calls.flat().join("\n")).toMatch(
      new RegExp(ALLOW_WRITABLE_INSTALL_ENV),
    );
  });
});

describe("fixture sanity", () => {
  it("a directory created by the tests is not writable by OTHER_UID", () => {
    fx = protectedInstall();
    mkdirSync(join(fx.pluginDir, "extra"), { mode: 0o755 });
    chmodSync(join(fx.pluginDir, "extra"), 0o755);
    expect(checkInstallIntegrity(fx.install)).toEqual({ ok: true });
  });
});
