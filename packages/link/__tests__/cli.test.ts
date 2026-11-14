// The Link CLI adapter, against a fake `link-cli` (no process, no network,
// no Link account). Checks the exact commands it runs.
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLinkGuard, linkCliAdapter, type LinkCliRunner } from "../src/index.js";
import { cliFixture, CONNECTION, fakeGuardian, TEST_CARD_NUMBER, TEST_CVC, terms, testStore } from "./helpers.js";

/** The CLI by absolute path: node and a script (never run: the runner is a fake). */
/** The CLI by absolute path: fixture files in a private folder (never run: the runner is a fake). */
let COMMAND: string[];
let fixture: ReturnType<typeof cliFixture>;

let dir: string;
let auth: string;
let cardDir: string;

beforeEach(() => {
  fixture = cliFixture();
  COMMAND = fixture.command;
  dir = mkdtempSync(join(tmpdir(), "glink-test-"));
  auth = join(dir, "link-auth.json");
  writeFileSync(auth, "{}", { mode: 0o600 });
  cardDir = mkdtempSync(join(tmpdir(), "glink-cards-"));
});
afterEach(() => {
  fixture.cleanup();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cardDir, { recursive: true, force: true });
});

const VALUE_FLAGS = new Set([
  "--credential-type",
  "--merchant-name",
  "--merchant-url",
  "--context",
  "--amount",
  "--currency",
  "--line-item",
  "--total",
  "--idempotency-key",
  "--format",
  "--auth",
  "--include",
  "--output-file",
]);

type FakeCliOptions = {
  policy?: "none-404" | "other-404" | "empty" | "rules" | "auth-error";
  /** Extra fields Link returns on every spend request. */
  extra?: Record<string, unknown>;
};

/** A fake link-cli: parses the flags the adapter sends and keeps requests in memory. */
function fakeCli(opts: FakeCliOptions = {}) {
  const runs: { file: string; args: string[]; env: Record<string, string | undefined>; cwd: string }[] = [];
  const reqs = new Map<string, Record<string, unknown>>();
  let n = 0;
  const run: LinkCliRunner = async (file, argv, o) => {
    runs.push({ file, args: [...argv], env: { ...o.env }, cwd: o.cwd });
    const args = argv[0] === COMMAND[1] ? argv.slice(1) : [...argv];
    const flags: Record<string, string[]> = {};
    const pos: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i]!;
      if (VALUE_FLAGS.has(a)) {
        (flags[a] ??= []).push(args[i + 1]!);
        i += 1;
      } else if (a.startsWith("--")) {
        (flags[a] ??= []).push("true");
      } else pos.push(a);
    }
    const ok = (v: unknown) => ({ exitCode: 0, stdout: JSON.stringify([v]), stderr: "" });
    const kv = (s: string) =>
      Object.fromEntries(s.split(",").map((p) => [p.slice(0, p.indexOf(":")), p.slice(p.indexOf(":") + 1)]));
    const [group, cmd, id] = pos;
    if (group === "approval-policy") {
      if (opts.policy === "rules") return ok({ rules: [{ action: "create", limits: {} }] });
      if (opts.policy === "empty") return ok({ rules: [] });
      if (opts.policy === "auth-error") return { exitCode: 1, stdout: "", stderr: "Failed to retrieve approval policy (401): unauthorized" };
      if (opts.policy === "other-404") {
        return { exitCode: 1, stdout: JSON.stringify({ message: "Failed to retrieve approval policy (404): Not found" }), stderr: "" };
      }
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          code: "UNKNOWN",
          message: "Failed to retrieve approval policy (404): No approval policy has been configured",
        }),
        stderr: "",
      };
    }
    if (group === "spend-request" && cmd === "create") {
      n += 1;
      const rid = `lsrq_cli_${n}`;
      const r = {
        id: rid,
        status: "created",
        merchant_name: flags["--merchant-name"]![0],
        merchant_url: flags["--merchant-url"]![0],
        context: flags["--context"]![0],
        amount: Number(flags["--amount"]![0]),
        currency: flags["--currency"]![0],
        credential_type: flags["--credential-type"]![0],
        line_items: (flags["--line-item"] ?? []).map((s) => {
          const o = kv(s);
          return { name: o.name, unit_amount: Number(o.unit_amount), quantity: Number(o.quantity) };
        }),
        totals: (flags["--total"] ?? []).map((s) => {
          const o = kv(s);
          return { type: o.type, display_text: o.display_text, amount: Number(o.amount) };
        }),
        payment_details: "csmrpd_test_1",
        created_at: "2026-11-14T10:00:00Z",
        updated_at: "2026-11-14T10:00:00Z",
        expires_at: "2026-11-21T10:00:00Z",
        recurring: null,
        ...opts.extra,
      };
      reqs.set(rid, r);
      return ok(r);
    }
    const r = id ? reqs.get(id) : undefined;
    if (!r) return { exitCode: 1, stdout: "", stderr: "not found" };
    if (cmd === "request-approval") {
      r.status = "approved"; // the person approves at once in this fake
      return ok({ id, approval_url: "https://app.link.com/x" });
    }
    if (cmd === "cancel") {
      r.status = "canceled";
      return ok(r);
    }
    if (cmd === "retrieve") {
      if (flags["--include"]?.[0] === "card") {
        const card = { id: "card_1", brand: "visa", number: TEST_CARD_NUMBER, cvc: TEST_CVC, exp_month: 12, exp_year: 2030 };
        writeFileSync(flags["--output-file"]![0]!, JSON.stringify({ spend_request_id: id, card }), { mode: 0o600, flag: "wx" });
        return ok({ ...r, card_output_file: flags["--output-file"]![0] });
      }
      return ok(r);
    }
    return { exitCode: 2, stdout: "", stderr: "unknown command" };
  };
  return { run, runs, reqs };
}

describe("linkCliAdapter", () => {
  it("runs the guarded flow end to end with exactly the expected commands", async () => {
    const cli = fakeCli();
    const prev = process.env.LINK_ACCESS_TOKEN;
    process.env.LINK_ACCESS_TOKEN = "agent-token-must-not-be-used";
    const planted = {
      NODE_OPTIONS: "--require=/tmp/agent-preload.js",
      NODE_PATH: "/tmp/agent-modules",
      NODE_EXTRA_CA_CERTS: "/tmp/agent-ca.pem",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      HTTPS_PROXY: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
    } as const;
    const prevPlanted = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    try {
      const link = linkCliAdapter({ authPath: auth, command: COMMAND, run: cli.run, tmpDir: cardDir });
      const guard = createLinkGuard({
        guardian: fakeGuardian(),
        connectionId: CONNECTION,
        link,
        store: testStore(),
        limits: [{ currency: "usd", askAbove: 5_000, max: 20_000 }],
      });
      const { spendRequestId } = await guard.spend(terms());
      await guard.waitForLinkApproval(spendRequestId, { timeoutMs: 1_000 });
      const last4 = await guard.withCard(spendRequestId, (c) => c.number.slice(-4));
      expect(last4).toBe(TEST_CARD_NUMBER.slice(-4));

      for (const r of cli.runs) {
        expect(r.file).toBe(COMMAND[0]);
        expect(r.args[0]).toBe(COMMAND[1]);
        expect(r.cwd.startsWith(join(cardDir, "guardian-link-"))).toBe(true);
        expect(r.args.slice(-4)).toEqual(["--format", "json", "--auth", auth]);
        expect(r.args).not.toContain("--approve");
        expect(r.args).not.toContain("--use-approval-policy");
        expect(r.args).not.toContain("--approval-detail");
        expect(r.env.LINK_ACCESS_TOKEN).toBeUndefined();
        expect(r.env.NO_UPDATE_NOTIFIER).toBe("1");
        for (const k of Object.keys(planted)) expect(r.env[k]).toBeUndefined();
        expect(r.env.PATH).toBe(process.env.PATH);
        expect(Object.keys(r.env).every((k) => /^(PATH|HOME|LANG|LC_ALL|LC_CTYPE|TZ|TMPDIR|SYSTEMROOT|NO_UPDATE_NOTIFIER)$/.test(k))).toBe(true);
      }
      const create = cli.runs.find((r) => r.args[2] === "create")!.args;
      expect(create).toEqual(
        expect.arrayContaining(["--test", "--no-request-approval", "--credential-type", "card", "--idempotency-key"]),
      );
      expect(create[create.indexOf("--line-item") + 1]).toBe("name:Working in Public,unit_amount:3500,quantity:1");
      expect(create[create.indexOf("--total") + 1]).toBe("type:total,display_text:Total,amount:3500");
      const creates = cli.runs.filter((r) => r.args[2] === "create");
      expect(creates).toHaveLength(1);
      const cardRuns = cli.runs.filter((r) => r.args.includes("--include"));
      expect(cardRuns).toHaveLength(1);
      expect(cardRuns[0]!.args).toContain("--output-file");
      // The private card file and its folder are gone.
      expect(readdirSync(cardDir)).toEqual([]);
      expect(JSON.stringify(guard.records())).not.toContain(TEST_CARD_NUMBER);
    } finally {
      if (prev === undefined) delete process.env.LINK_ACCESS_TOKEN;
      else process.env.LINK_ACCESS_TOKEN = prev;
      for (const [k, v] of Object.entries(prevPlanted)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("reads the approval policy: 404 or no rules is none, rules is present, anything else unknown", async () => {
    const states: string[] = [];
    for (const policy of ["none-404", "other-404", "empty", "rules", "auth-error"] as const) {
      const link = linkCliAdapter({ authPath: auth, command: COMMAND, run: fakeCli({ policy }).run });
      states.push((await link.approvalPolicy()).state);
    }
    // A 404 without Link's documented "No approval policy has been configured" is unknown.
    expect(states).toEqual(["none", "unknown", "none", "present", "unknown"]);
  });

  it("refuses a login file anyone else can read, a relative path or a missing file", () => {
    chmodSync(auth, 0o644);
    expect(() => linkCliAdapter({ authPath: auth, command: COMMAND, run: fakeCli().run })).toThrow(/owner only/);
    expect(() => linkCliAdapter({ authPath: "link-auth.json", command: COMMAND, run: fakeCli().run })).toThrow(/absolute/);
    expect(() => linkCliAdapter({ authPath: join(dir, "missing.json"), command: COMMAND, run: fakeCli().run })).toThrow(/does not exist/);
  });

  it("creates test-mode card requests only", async () => {
    const link = linkCliAdapter({ authPath: auth, command: COMMAND, run: fakeCli().run });
    const base = {
      credentialType: "card",
      merchantName: "M",
      merchantUrl: "https://m.example",
      context: "x".repeat(100),
      amount: 1,
      currency: "usd",
      lineItems: [],
      totals: [],
      idempotencyKey: "k",
      requestApproval: false,
    };
    await expect(link.createSpendRequest({ ...base, test: false } as never)).rejects.toThrow(/test-mode/);
    await expect(link.createSpendRequest({ ...base, test: true, requestApproval: true } as never)).rejects.toThrow(/test-mode/);
  });

  it("errors never carry the CLI's output", async () => {
    const leaky: LinkCliRunner = async () => ({
      exitCode: 1,
      stdout: `{"card":{"number":"${TEST_CARD_NUMBER}"}}`,
      stderr: `cvc ${TEST_CVC}`,
    });
    const link = linkCliAdapter({ authPath: auth, command: COMMAND, run: leaky, tmpDir: cardDir });
    const err = await link.readCard("lsrq_cli_1").then(() => new Error("no refusal"), (e: unknown) => e as Error);
    expect(err.message).not.toContain(TEST_CARD_NUMBER);
    expect(err.message).not.toContain(TEST_CVC);
    expect(readdirSync(cardDir)).toEqual([]);
  });

  it("refuses ids that are not Link spend request ids", async () => {
    const cli = fakeCli();
    const link = linkCliAdapter({ authPath: auth, command: COMMAND, run: cli.run });
    await expect(link.retrieveSpendRequest("--include")).rejects.toThrow(/spend request id/);
    await expect(link.readCard("lsrq_1;rm -rf")).rejects.toThrow(/spend request id/);
    expect(cli.runs).toHaveLength(0);
  });

  it("a card file for another spend request is refused, and removed", async () => {
    const run: LinkCliRunner = async (_f, args) => {
      const out = args[args.indexOf("--output-file") + 1]!;
      writeFileSync(out, JSON.stringify({ spend_request_id: "lsrq_other", card: { number: TEST_CARD_NUMBER } }));
      return { exitCode: 0, stdout: JSON.stringify([{ id: "lsrq_cli_1", status: "approved" }]), stderr: "" };
    };
    const link = linkCliAdapter({ authPath: auth, command: COMMAND, run, tmpDir: cardDir });
    await expect(link.readCard("lsrq_cli_1")).rejects.toThrow(/card file/);
    expect(readdirSync(cardDir)).toEqual([]);
    expect(existsSync(join(cardDir, "card.json"))).toBe(false);
  });
});
