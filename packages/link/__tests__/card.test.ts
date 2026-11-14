// Card details are read once, for the approved request only, and never
// reach a log, a record or an error.
import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LinkCard, LinkGuardRecord } from "../src/index.js";
import { fakeGuardian, fakeLink, makeGuard as make, TEST_CARD_NUMBER, TEST_CVC, terms } from "./helpers.js";

// A fixed clock, so no timestamp can contain the card's last four digits by chance.
const makeGuard = (o: Parameters<typeof make>[0] = {}) => make({ now: () => 1_700_000_000_000, ...o });

const LAST4 = TEST_CARD_NUMBER.slice(-4);

function captureConsole() {
  const lines: string[] = [];
  for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 8 }))).join(" "));
    });
  }
  return lines;
}

afterEach(() => vi.restoreAllMocks());

const noCardIn = (text: string) => {
  expect(text).not.toContain(TEST_CARD_NUMBER);
  expect(text).not.toContain(TEST_CVC);
  expect(text).not.toContain(LAST4);
};

describe("card details never reach logs", () => {
  it("records, the record sink, console output and the card's own printing carry no detail", async () => {
    const lines = captureConsole();
    const sink: LinkGuardRecord[] = [];
    const { guard } = makeGuard({
      link: fakeLink({ personInLink: "approve" }),
      guardian: fakeGuardian({ decide: () => "ASK" }),
      onRecord: (r) => {
        sink.push(r);
        console.log("guard record", r);
      },
    });
    const { spendRequestId } = await guard.spend(
      terms({ amount: 12_000, lineItems: [{ name: "Set", quantity: 1, unitAmount: 12_000 }], totals: [{ type: "total", displayText: "Total", amount: 12_000 }] }),
    );
    let seen: LinkCard | undefined;
    const printed = await guard.withCard(spendRequestId, (card) => {
      seen = card;
      expect(card.number).toBe(TEST_CARD_NUMBER);
      expect(card.cvc).toBe(TEST_CVC);
      console.log("card is", card);
      console.log(`card is ${card}`);
      console.log(JSON.stringify({ card }));
      return [String(card), JSON.stringify(card), inspect(card), `${card}`, Object.keys(card).join(",")].join("\n");
    });
    noCardIn(printed);
    noCardIn(lines.join("\n"));
    noCardIn(JSON.stringify(guard.records()));
    noCardIn(JSON.stringify(sink));
    expect(guard.records().some((r) => r.event === "card-read")).toBe(true);
    expect(() => seen!.number).toThrow(/only readable inside withCard/);
  });

  it("refusals after the card was read carry no detail", async () => {
    const { guard } = makeGuard({ link: fakeLink({ personInLink: "approve" }) });
    const { spendRequestId } = await guard.spend(terms());
    await guard.withCard(spendRequestId, () => undefined);
    const err = await guard.withCard(spendRequestId, () => undefined).then(() => new Error("no refusal"), (e: unknown) => e as Error);
    noCardIn(`${err.message}\n${err.stack}\n${inspect(err)}`);
  });

  it("an adapter error with card data in it is not passed on", async () => {
    const link = fakeLink({ personInLink: "approve" });
    link.readCard = async () => {
      throw new Error(`boom ${TEST_CARD_NUMBER} ${TEST_CVC}`);
    };
    const { guard } = makeGuard({ link });
    const { spendRequestId } = await guard.spend(terms());
    const err = await guard.withCard(spendRequestId, () => undefined).then(() => new Error("no refusal"), (e: unknown) => e as Error);
    expect(err).toMatchObject({ code: "CARD_UNREADABLE" });
    noCardIn(`${err.message}\n${inspect(err)}\n${JSON.stringify(guard.records())}`);
    // A failed read still counts as the one read.
    await expect(guard.withCard(spendRequestId, () => undefined)).rejects.toMatchObject({ code: "CARD_ALREADY_READ" });
  });

  it("a card Link returns in a shape the guard cannot read is not handed over", async () => {
    const link = fakeLink({ personInLink: "approve" });
    const real = link.readCard.bind(link);
    link.readCard = async (id) => ({ ...(await real(id)), card: { number: "not-a-card", expMonth: 13, expYear: 2030 } });
    const { guard } = makeGuard({ link });
    const { spendRequestId } = await guard.spend(terms());
    let ran = false;
    await expect(
      guard.withCard(spendRequestId, () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: "CARD_UNREADABLE" });
    expect(ran).toBe(false);
  });
});
