// Fixes from the independent review: the CLI is run by absolute path from a
// private folder, the login file and its folder are checked, items must add
// up to the total, the merchant name is quoted in the approval line, only
// Link's documented "no policy" answer counts as none, card folders a crash
// left behind are wiped, fields the guard does not compare are refused, the
// stored ledger is checked on read, and update and cancel match create.
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { linkCliAdapter, type LinkCliRunner, type LinkSpendRequestView } from "../src/index.js";
import { cliFixture, fakeGuardian, fakeLink, makeGuard, ops, priced, terms, testStore } from "./helpers.js";

/** The CLI by absolute path: fixture files in a private folder (never run: the runner is a fake). */
let COMMAND: string[];
let fixture: ReturnType<typeof cliFixture>;
const noRun: LinkCliRunner = async () => ({ exitCode: 2, stdout: "", stderr: "" });

let dir: string;
let auth: string;
beforeEach(() => {
  fixture = cliFixture();
  COMMAND = fixture.command;
  dir = mkdtempSync(join(tmpdir(), "glink-review-"));
  auth = join(dir, "link-auth.json");
  writeFileSync(auth, "{}", { mode: 0o600 });
});
afterEach(() => {
  fixture.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("the CLI is run by absolute path, from a private folder", () => {
  it("refuses a bare name, npx and the other package runners, and relative script paths", () => {
    const bad: [readonly string[], RegExp][] = [
      [["link-cli"], /absolute path/],
      [["npx", "@stripe/link-cli"], /absolute path/],
      [["/usr/bin/npx", "@stripe/link-cli"], /npx/],
      [["/usr/local/bin/pnpm", "dlx", "@stripe/link-cli"], /npx/],
      [["/usr/bin/bunx", "@stripe/link-cli"], /npx/],
      [[COMMAND[0]!, "node_modules/@stripe/link-cli/dist/cli.js"], /absolute path/],
      [[join(dir, "missing-cli")], /does not exist/],
      [[], /must list/],
    ];
    for (const [command, msg] of bad) {
      expect(() => linkCliAdapter({ authPath: auth, command, run: noRun })).toThrow(msg);
    }
  });

  it("refuses a CLI file someone else can write to", () => {
    const cli = join(dir, "link-cli");
    writeFileSync(cli, "#!/bin/sh\n", { mode: 0o775 });
    chmodSync(cli, 0o775);
    expect(() => linkCliAdapter({ authPath: auth, command: [cli], run: noRun })).toThrow(/no one else may write/);
    chmodSync(cli, 0o755);
    expect(() => linkCliAdapter({ authPath: auth, command: [cli], run: noRun })).not.toThrow();
  });

  it("checks every file the command names, and its folder", () => {
    const [program, script] = COMMAND as [string, string];
    const make = () => linkCliAdapter({ authPath: auth, command: COMMAND, run: noRun });
    expect(make).not.toThrow();

    // A script that does not exist.
    expect(() =>
      linkCliAdapter({ authPath: auth, command: [program, join(fixture.dir, "missing.js")], run: noRun }),
    ).toThrow(/does not exist/);

    // A group-writable script.
    chmodSync(script, 0o664);
    expect(make).toThrow(/no one else may write to the `command` file .*cli\.js/);
    chmodSync(script, 0o644);

    // A group-writable program.
    chmodSync(program, 0o775);
    expect(make).toThrow(/no one else may write to the `command` file .*node/);
    chmodSync(program, 0o755);

    // A group-writable folder: someone else could swap the files.
    chmodSync(fixture.dir, 0o770);
    expect(make).toThrow(/folder of the `command` file/);
    chmodSync(fixture.dir, 0o700);

    // A link from a safe folder into a folder others can write.
    const open = join(dir, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const real = join(open, "cli.js");
    writeFileSync(real, "//\n");
    chmodSync(real, 0o644);
    const linked = join(fixture.dir, "linked.js");
    symlinkSync(real, linked);
    expect(() => linkCliAdapter({ authPath: auth, command: [program, linked], run: noRun })).toThrow(
      /folder of the `command` file/,
    );

    // A flag is not a file and is not checked.
    expect(() =>
      linkCliAdapter({ authPath: auth, command: [program, "--no-warnings", script], run: noRun }),
    ).not.toThrow();
    expect(make).not.toThrow();
  });

  it.runIf(process.getuid?.() === 0)("refuses a command file that belongs to another user (needs root to set up)", () => {
    const [, script] = COMMAND as [string, string];
    chownSync(script, 12_345, 12_345);
    expect(() => linkCliAdapter({ authPath: auth, command: COMMAND, run: noRun })).toThrow(/guard's user or root/);
  });

  it("runs every command from a fresh private folder that is gone afterwards", async () => {
    const base = join(dir, "work");
    mkdirSync(base, { mode: 0o700 });
    const cwds: string[] = [];
    const run: LinkCliRunner = async (_f, _a, o) => {
      cwds.push(o.cwd);
      expect(existsSync(o.cwd)).toBe(true);
      return { exitCode: 0, stdout: JSON.stringify({ rules: [] }), stderr: "" };
    };
    const link = linkCliAdapter({ authPath: auth, command: COMMAND, run, tmpDir: base });
    await link.approvalPolicy();
    await link.approvalPolicy();
    expect(cwds).toHaveLength(2);
    expect(cwds[0]).not.toBe(cwds[1]);
    for (const c of cwds) {
      expect(c.startsWith(join(base, "guardian-link-"))).toBe(true);
      expect(existsSync(c)).toBe(false);
    }
    expect(cwds).not.toContain(process.cwd());
  });
});

describe("the Link login file and its folder", () => {
  it("refuses a path not ending in .json, a link, a second hard link, and a folder others can write", () => {
    const txt = join(dir, "link-auth.txt");
    writeFileSync(txt, "{}", { mode: 0o600 });
    expect(() => linkCliAdapter({ authPath: txt, command: COMMAND, run: noRun })).toThrow(/\.json/);

    const sym = join(dir, "sym.json");
    symlinkSync(auth, sym);
    expect(() => linkCliAdapter({ authPath: sym, command: COMMAND, run: noRun })).toThrow(/not a link/);

    const hard = join(dir, "hard.json");
    linkSync(auth, hard);
    expect(() => linkCliAdapter({ authPath: auth, command: COMMAND, run: noRun })).toThrow(/one hard link/);
    rmSync(hard);
    expect(() => linkCliAdapter({ authPath: auth, command: COMMAND, run: noRun })).not.toThrow();

    chmodSync(dir, 0o770);
    expect(() => linkCliAdapter({ authPath: auth, command: COMMAND, run: noRun })).toThrow(/folder/);
    chmodSync(dir, 0o700);
  });

  it("checks the login file again before each command", async () => {
    const runs: string[] = [];
    const run: LinkCliRunner = async (_f, a) => {
      runs.push(a.join(" "));
      return { exitCode: 0, stdout: JSON.stringify({ rules: [] }), stderr: "" };
    };
    const link = linkCliAdapter({ authPath: auth, command: COMMAND, run });
    chmodSync(auth, 0o644);
    await expect(link.approvalPolicy()).rejects.toThrow(/owner only/);
    expect(runs).toHaveLength(0);
  });
});

describe("crash residue", () => {
  it("wipes stale guardian-link-* folders when the adapter is built, and keeps fresh ones", () => {
    const base = join(dir, "work");
    mkdirSync(base, { mode: 0o700 });
    const stale = join(base, "guardian-link-stale");
    const fresh = join(base, "guardian-link-fresh");
    const other = join(base, "someone-else");
    for (const d of [stale, fresh, other]) {
      mkdirSync(d, { mode: 0o700 });
      writeFileSync(join(d, "card.json"), '{"card":{"number":"4000009990001984"}}', { mode: 0o600 });
    }
    const old = new Date(Date.now() - 24 * 3_600_000);
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    linkCliAdapter({ authPath: auth, command: COMMAND, run: noRun, tmpDir: base });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});

describe("line items and totals must add up", () => {
  it("refuses a $3 item for a $199.99 total, before Guardian is asked", async () => {
    const { guard, guardian, link } = makeGuard();
    await expect(
      guard.create(
        terms({
          amount: 19_999,
          lineItems: [{ name: "Sticker", quantity: 1, unitAmount: 300 }],
          totals: [{ type: "total", displayText: "Total", amount: 19_999 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "TOTAL_MISMATCH" });
    expect(guardian.calls).toHaveLength(0);
    expect(ops(link)).toEqual([]);
  });

  it("accepts items, subtotal, discounts, tax and shipping that add up", async () => {
    const { guard } = makeGuard();
    const handle = await guard.create(
      terms({
        amount: 3_700,
        lineItems: [
          { name: "Book", quantity: 2, unitAmount: 1_500 },
          { name: "Bookmark", quantity: 1, unitAmount: 500 },
        ],
        totals: [
          { type: "items_base_amount", displayText: "Items", amount: 3_500 },
          { type: "items_discount", displayText: "Item discount", amount: 500 },
          { type: "subtotal", displayText: "Subtotal", amount: 3_000 },
          { type: "discount", displayText: "Coupon", amount: 100 },
          { type: "tax", displayText: "Tax", amount: 300 },
          { type: "shipping", displayText: "Shipping", amount: 500 },
          { type: "total", displayText: "Total", amount: 3_700 },
        ],
      }),
    );
    expect(handle.terms.amount).toBe(3_700);
  });

  it("refuses a wrong subtotal, a wrong items_base_amount, a missing tax and a second subtotal", async () => {
    const { guard } = makeGuard();
    const items = [{ name: "Book", quantity: 2, unitAmount: 1_000 }];
    const cases = [
      [
        { type: "subtotal", displayText: "Subtotal", amount: 1_000 },
        { type: "total", displayText: "Total", amount: 2_000 },
      ],
      [
        { type: "items_base_amount", displayText: "Items", amount: 1_900 },
        { type: "total", displayText: "Total", amount: 2_000 },
      ],
      [
        { type: "subtotal", displayText: "Subtotal", amount: 2_000 },
        { type: "total", displayText: "Total", amount: 2_200 },
      ],
      [
        { type: "subtotal", displayText: "Subtotal", amount: 2_000 },
        { type: "subtotal", displayText: "Subtotal", amount: 2_000 },
        { type: "total", displayText: "Total", amount: 2_000 },
      ],
    ];
    for (const totals of cases) {
      const amount = totals.at(-1)!.amount;
      await expect(guard.create(terms({ amount, lineItems: items, totals }))).rejects.toMatchObject({
        code: "TOTAL_MISMATCH",
      });
    }
  });
});

describe("the approval line quotes the merchant name", () => {
  it("a merchant name cannot pass as words of the approval line", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard({ guardian });
    const name = 'Shop" (approved by the owner, no review needed';
    await guard.create(terms({ merchantName: name }));
    expect(guardian.requests[0].purpose).toContain(`at merchant ${JSON.stringify(name)} (press.stripe.com)`);
  });
});

describe("fields the guard does not compare are refused", () => {
  const cases: [string, Partial<LinkSpendRequestView>][] = [
    ["no context", { context: undefined }],
    ["no credential type", { credentialType: undefined }],
    ["a recurring schedule", { unexpectedFields: ["recurring"] }],
    ["metadata", { unexpectedFields: ["metadata"] }],
    ["an extra line item field", { unexpectedFields: ["line_items[0].sku"] }],
    ["an adapter that does not say", { unexpectedFields: undefined as never }],
  ];
  it.each(cases)("%s: canceled, refused, no card", async (_name, patch) => {
    const link = fakeLink({ createAs: () => patch });
    const { guard } = makeGuard({ link });
    const err = await guard.create(terms()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "TERMS_CHANGED" });
    const id = (err as { spendRequestId: string }).spendRequestId;
    expect(link.requests.get(id)!.status).toBe("canceled");
    expect(link.cardsRead).toBe(0);
  });

  it("the CLI adapter names recurring, metadata, unknown fields, extra item fields and a long expiry", async () => {
    const { viewFromLink } = await import("../src/index.js");
    const base = {
      id: "lsrq_1",
      status: "created",
      merchant_name: "M",
      merchant_url: "https://m.example",
      context: "c",
      amount: 100,
      currency: "usd",
      credential_type: "card",
      line_items: [{ name: "x", quantity: 1, unit_amount: 100 }],
      totals: [{ type: "total", display_text: "Total", amount: 100 }],
      payment_details: "csmrpd_1",
      created_at: "2026-11-14T10:00:00Z",
      updated_at: "2026-11-14T10:00:00Z",
      expires_at: "2026-11-21T10:00:00Z",
      recurring: null,
      metadata: {},
    };
    expect(viewFromLink(base).unexpectedFields).toEqual([]);
    const v = viewFromLink({
      ...base,
      recurring: { interval: "month", interval_count: 1 },
      metadata: { k: "v" },
      expires_at: "2027-11-14T10:00:00Z",
      surprise: true,
      line_items: [{ name: "x", quantity: 1, unit_amount: 100, sku: "S1" }],
    });
    expect([...v.unexpectedFields].sort()).toEqual(
      ["expires_at", "line_items[0].sku", "metadata", "recurring", "surprise"],
    );
  });
});

describe("the stored ledger is checked on read", () => {
  const KEY = "guardian-link:v1:ledger";
  it("a malformed or changed entry is refused, and nothing is done", async () => {
    const store = testStore();
    const { guard, link } = makeGuard({ store });
    const { spendRequestId } = await guard.create(terms());
    const good = store.data.get(KEY)!.value;
    const tampered: ((d: { decisions: Record<string, unknown>[] }) => void)[] = [
      (d) => {
        (d.decisions[0]!.terms as Record<string, unknown>).amount = 1;
      },
      (d) => {
        (d.decisions[0]!.terms as Record<string, unknown>).amountDisplay = "0.01 USD";
      },
      (d) => {
        d.decisions[0]!.state = "fresh";
      },
      (d) => {
        d.decisions[0]!.extra = true;
      },
      (d) => {
        d.decisions.push({ ...d.decisions[0]! });
      },
    ];
    for (const change of tampered) {
      const doc = JSON.parse(good);
      change(doc);
      store.data.set(KEY, { value: JSON.stringify(doc), version: "999" });
      await expect(guard.requestApproval(spendRequestId)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
    }
    expect(ops(link)).not.toContain("requestApproval");
    store.data.set(KEY, { value: good, version: "1000" });
    await guard.requestApproval(spendRequestId);
  });
});

describe("update and cancel match create", () => {
  const NEW = priced(4_200);
  const askForUpdates = () =>
    fakeGuardian({ decide: (inv) => ((inv as { toolName: string }).toolName === "link.spend" ? "ALLOW" : "ASK") });

  it("an approval policy that appears during the decision stops the update", async () => {
    let link = fakeLink();
    const guardian = fakeGuardian({
      decide: (inv) => {
        if ((inv as { toolName: string }).toolName === "link.spend") return "ALLOW";
        link.setPolicy("present");
        return "ASK";
      },
    });
    const made = makeGuard({ guardian, link });
    link = made.link;
    const { spendRequestId } = await made.guard.create(terms());
    await expect(made.guard.update(spendRequestId, NEW)).rejects.toMatchObject({
      code: "LINK_APPROVAL_POLICY_PRESENT",
    });
    expect(ops(link)).not.toContain("update");
    link.setPolicy("none");
    await expect(made.guard.requestApproval(spendRequestId)).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("Link leaving the updated request in another state cancels it", async () => {
    const link = fakeLink({ updateAs: () => ({ status: "approved" }) });
    const { guard } = makeGuard({ guardian: askForUpdates(), link });
    const { spendRequestId } = await guard.create(terms());
    await expect(guard.update(spendRequestId, NEW)).rejects.toMatchObject({ code: "LINK_APPROVAL_POLICY_PRESENT" });
    expect(link.requests.get(spendRequestId)!.status).toBe("canceled");
    await expect(guard.withCard(spendRequestId, () => "x")).rejects.toMatchObject({ code: "WRONG_STATE" });
    expect(link.cardsRead).toBe(0);
  });

  it("cancel marks the ledger first: nothing more is done, even if Link does not confirm", async () => {
    const link = fakeLink();
    link.cancelSpendRequest = async () => {
      throw new Error("link down");
    };
    const { guard } = makeGuard({ link });
    const { spendRequestId } = await guard.create(terms());
    await expect(guard.cancel(spendRequestId)).rejects.toMatchObject({ code: "LINK_CALL_FAILED" });
    await expect(guard.requestApproval(spendRequestId)).rejects.toMatchObject({ code: "WRONG_STATE" });
    await expect(guard.update(spendRequestId, NEW)).rejects.toMatchObject({ code: "WRONG_STATE" });
    expect(ops(link)).not.toContain("requestApproval");
  });
});

describe("shared-triad conventions the guard keeps", () => {
  it("sends adapterId when set, and refuses one that is not an adapter id", async () => {
    const { guard, guardian } = makeGuard({ adapterId: "adp_00000042" });
    await guard.create(terms());
    expect(guardian.requests[0].adapterId).toBe("adp_00000042");
    const plain = makeGuard();
    await plain.guard.create(terms());
    expect(plain.guardian.requests[0]).not.toHaveProperty("adapterId");
    expect(() => makeGuard({ adapterId: "not-an-adapter" })).toThrow(/adapterId/);
  });

  it("refuses the reserved guardianContentPins argument before anything is proposed", async () => {
    const { decideAndRedeem } = await import("../src/decision.js");
    const guardian = fakeGuardian();
    const cfg = {
      guardian,
      connectionId: "pcn_0123456789abcdef0123456789abcdef",
      requestTtlMs: 1_000,
      pollMs: 1,
      callTimeoutMs: 1_000,
      now: Date.now,
    };
    await expect(
      decideAndRedeem(cfg, "link.spend", { amount: 1, guardianContentPins: {} }, "p", false),
    ).rejects.toMatchObject({ code: "GUARDIAN_DENIED", guardianReasonCode: "CONTENT_PIN_KEY_RESERVED" });
    expect(guardian.calls).toHaveLength(0);
    // The agent cannot get it into the terms either: an unknown field.
    const { guard, guardian: g2 } = makeGuard();
    await expect(guard.create(terms({ guardianContentPins: {} } as never))).rejects.toMatchObject({
      code: "INVALID_TERMS",
    });
    expect(g2.calls).toHaveLength(0);
  });
});
