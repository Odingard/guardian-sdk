import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  OPENSHELL_PLACEHOLDER_RE,
  PLACEHOLDER_KEPT_MESSAGE,
  register,
  takeCredential,
  type OpenClawPluginApiLike,
} from "../src/index.js";

/**
 * Credential-shaped strings are assembled at runtime so secret scanners do
 * not flag this file.
 */
const KEY = ["GUARDIAN", "AGENT", "CREDENTIAL"].join("_");
const PREFIX = ["openshell", "resolve", "env", ""].join(":");
const revision = (n: string) => `${PREFIX}v${n}_${KEY}`;
const DIGEST = "0123456789abcdef".repeat(4);
const REVISION_PLACEHOLDER = revision("12");
const DIGEST_PLACEHOLDER = `${PREFIX}s${DIGEST}_${KEY}`;
const RAW = ["gak", "test", "not", "a", "real", "value"].join("_");

/** A Gateway working directory with no .env (nothing is ignored). */
const CLEAN_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-cred-"));
/** A Gateway working directory whose .env names the credential. */
const DOTENV_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-cred-"));
fs.writeFileSync(path.join(DOTENV_CWD, ".env"), `${KEY}=from-dotenv\n`);
afterAll(() => {
  fs.rmSync(CLEAN_CWD, { recursive: true, force: true });
  fs.rmSync(DOTENV_CWD, { recursive: true, force: true });
});

const CONFIG = { connectionId: "pcn_everyday", askConnectionId: "pcn_ask" };

function fakeApi() {
  const info = vi.fn<(msg: string) => void>();
  const warn = vi.fn<(msg: string) => void>();
  const on = vi.fn();
  const api: OpenClawPluginApiLike = {
    id: "guardian",
    config: {},
    pluginConfig: CONFIG,
    logger: { info, warn },
    on,
  };
  const logs = () => [...info.mock.calls, ...warn.mock.calls].map((c) => c[0]);
  const notConfigured = () =>
    warn.mock.calls.some((c) => c[0].includes("is not configured"));
  return { api, info, warn, on, logs, notConfigured };
}

describe("OpenShell credential placeholder", () => {
  it("keeps a revision placeholder in the environment", () => {
    const env: Record<string, string | undefined> = {
      [KEY]: REVISION_PLACEHOLDER,
      PATH: "/bin",
    };
    const slot: Record<symbol, unknown> = {};
    expect(takeCredential(env, slot)).toBe(REVISION_PLACEHOLDER);
    expect(env).toEqual({ [KEY]: REVISION_PLACEHOLDER, PATH: "/bin" });
  });

  it("keeps a digest placeholder in the environment", () => {
    const env: Record<string, string | undefined> = { [KEY]: DIGEST_PLACEHOLDER };
    expect(takeCredential(env, {})).toBe(DIGEST_PLACEHOLDER);
    expect(env[KEY]).toBe(DIGEST_PLACEHOLDER);
  });

  it("keeps a padded placeholder, trimmed", () => {
    const env: Record<string, string | undefined> = {
      [KEY]: ` ${REVISION_PLACEHOLDER}\n`,
    };
    expect(takeCredential(env, {})).toBe(REVISION_PLACEHOLDER);
    expect(env[KEY]).toBe(REVISION_PLACEHOLDER);
  });

  it("still removes a raw credential (0.1.0 behaviour)", () => {
    const env: Record<string, string | undefined> = { [KEY]: RAW, PATH: "/bin" };
    const slot: Record<symbol, unknown> = {};
    expect(takeCredential(env, slot)).toBe(RAW);
    expect(env).toEqual({ PATH: "/bin" });
    expect(takeCredential(env, slot)).toBe(RAW);
  });

  it.each([
    ["canonical, no revision", `${PREFIX}${KEY}`],
    ["another key's placeholder", `${PREFIX}v12_OTHER_SECRET`],
    ["trailing text", `${REVISION_PLACEHOLDER}x`],
    ["trailing text after a space", `${REVISION_PLACEHOLDER} ${RAW}`],
    ["leading text", `x${REVISION_PLACEHOLDER}`],
    ["a newline inside", `${REVISION_PLACEHOLDER}\n${RAW}`],
    ["a short digest", `${PREFIX}s${DIGEST.slice(1)}_${KEY}`],
    ["an upper-case digest", `${PREFIX}s${DIGEST.toUpperCase()}_${KEY}`],
    ["an over-long revision", revision("1".repeat(21))],
    ["an empty revision", revision("")],
  ])("treats %s as raw and removes it", (_label, value) => {
    expect(OPENSHELL_PLACEHOLDER_RE.test(value.trim())).toBe(false);
    const env: Record<string, string | undefined> = { [KEY]: value };
    takeCredential(env, {});
    expect(env).not.toHaveProperty(KEY);
  });

  it("removes and does not keep a placeholder that may come from <cwd>/.env", () => {
    const env: Record<string, string | undefined> = { [KEY]: REVISION_PLACEHOLDER };
    expect(takeCredential(env, {}, true)).toBeUndefined();
    expect(env).not.toHaveProperty(KEY);
  });

  it("logs once that a placeholder was kept, without the value", () => {
    const { api, info, logs } = fakeApi();
    const env: Record<string, string | undefined> = { [KEY]: REVISION_PLACEHOLDER };
    register(api, { cwd: CLEAN_CWD, env, slot: {} });
    const kept = info.mock.calls.filter((c) => c[0] === PLACEHOLDER_KEPT_MESSAGE);
    expect(kept).toHaveLength(1);
    expect(PLACEHOLDER_KEPT_MESSAGE).toContain("an OpenShell placeholder");
    for (const line of logs()) {
      expect(line).not.toContain(REVISION_PLACEHOLDER);
      expect(line).not.toContain(PREFIX);
    }
  });

  it("does not log the placeholder message for a raw value or a .env key", () => {
    const raw = fakeApi();
    register(raw.api, { cwd: CLEAN_CWD, env: { [KEY]: RAW }, slot: {} });
    expect(raw.logs()).not.toContain(PLACEHOLDER_KEPT_MESSAGE);
    for (const line of raw.logs()) expect(line).not.toContain(RAW);

    const dotenv = fakeApi();
    const env: Record<string, string | undefined> = { [KEY]: REVISION_PLACEHOLDER };
    register(dotenv.api, { cwd: DOTENV_CWD, env, slot: {} });
    expect(env).not.toHaveProperty(KEY);
    expect(dotenv.logs()).not.toContain(PLACEHOLDER_KEPT_MESSAGE);
    expect(dotenv.notConfigured()).toBe(true);
  });
});

describe("execve-style in-place Gateway restart", () => {
  /**
   * NemoClaw replaces the Gateway with
   * `process.execve(execPath, argv, { ...process.env, ...opts.env })`: a new
   * module load, a fresh globalThis (no credential slot) and a copy of the
   * environment as the old process left it.
   */
  async function restart(initial: string) {
    const first = fakeApi();
    const env: Record<string, string | undefined> = { [KEY]: initial, PATH: "/bin" };
    register(first.api, { cwd: CLEAN_CWD, env, slot: {} });
    expect(first.notConfigured()).toBe(false);

    vi.resetModules();
    const fresh = (await import("../src/index.js")) as typeof import("../src/index.js");
    const second = fakeApi();
    const copied = { ...env };
    fresh.register(second.api, { cwd: CLEAN_CWD, env: copied, slot: {} });
    expect(second.on).toHaveBeenCalledOnce();
    return { second, copied };
  }

  it("stays configured with an OpenShell placeholder", async () => {
    const { second, copied } = await restart(REVISION_PLACEHOLDER);
    expect(second.notConfigured()).toBe(false);
    expect(copied[KEY]).toBe(REVISION_PLACEHOLDER);
  });

  it("is not configured with a raw value (fails closed, as in 0.1.0)", async () => {
    const { second, copied } = await restart(RAW);
    expect(second.notConfigured()).toBe(true);
    expect(copied).not.toHaveProperty(KEY);
  });
});
