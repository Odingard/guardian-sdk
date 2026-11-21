import { describe, expect, it, vi } from "vitest";
import type {
  BuyCart,
  BuyTool,
  BuyToolInput,
  BuyToolResult,
} from "@agent-cards/commerce-sdk";
import type { GuardianClient } from "@odingard/guardian-sdk";

import {
  CHECKOUT_AMOUNT_DECLARATION,
  DEFAULT_CHECKOUT_TOOL,
  GuardianPurchaseBlocked,
  guardBuyTool,
} from "../src/index.js";

// ---------- a fake Agentcard buy tool ----------

function cart(totalCents: number, hash: string, store = "Amazon"): BuyCart {
  return {
    merchant: "retail",
    merchant_name: store,
    store: null,
    items: [
      {
        name: "Energizer AA batteries, 8 pack",
        qty: 2,
        priceCents: totalCents / 2,
        lineTotalCents: totalCents,
        options: [],
        variant: null,
        product_id: "p_1",
        ref: null,
        url: null,
        line_id: "l_1",
      },
    ],
    subtotalCents: totalCents,
    serviceFeesCents: 0,
    merchantFeeLines: null,
    tipCents: 0,
    totalCents,
    totalIsEstimate: false,
    totalUpTo: false,
    totalStatus: "confirmed",
    currency: "usd",
    approvedCeilingCents: null,
    hash,
  } as BuyCart;
}

function result(over: Partial<BuyToolResult>): BuyToolResult {
  return {
    status: "needs_input",
    reply: "",
    messages: [],
    cart: null,
    carts: [],
    products: [],
    links: [],
    link_sent: false,
    approval_expires_at: null,
    shopper_need_not_reply: false,
    conversation_id: "conv_1",
    order_id: null,
    decline_code: null,
    error_code: null,
    next_action: null,
    pick: null,
    stores: [],
    store_pick: null,
    hashes: [],
    ...over,
  } as BuyToolResult;
}

/** A buy tool whose search shows `shown`; a confirm records what reached Agentcard. */
function fakeBuy(shown: { cart: BuyCart }) {
  const sent: BuyToolInput[] = [];
  const answer = vi.fn(async (input: BuyToolInput) => {
    sent.push(input);
    if (input.confirm) {
      return result({
        status: "declined",
        decline_code: "sandbox_mode",
        cart: shown.cart,
        carts: [shown.cart],
        confirm_sent: true,
      });
    }
    return result({
      status: "needs_input",
      next_action: "confirm",
      cart: shown.cart,
      carts: [shown.cart],
    });
  });
  const tool = {
    name: "buy",
    description: "buys",
    input_schema: { type: "object" },
    strict: true,
    parse: (i: unknown) => i,
    answer,
    forModel: (r: BuyToolResult) => ({
      status: r.status,
      decline_code: r.decline_code,
    }),
    run: async () => "unguarded",
    execute: async () => "unguarded",
    handle: async () => "unguarded",
  };
  Object.defineProperty(tool, "definition", {
    value: { name: "buy" },
    enumerable: false,
  });
  return { tool: tool as unknown as BuyTool, sent, answer, shown };
}

// ---------- a fake Guardian ----------

type Answer = Record<string, unknown>;
const allow = (id = "req_1"): Answer => ({
  ok: true,
  decision: "ALLOW",
  requestId: id,
  capabilityToken: "cap_1",
});
const ask = (id = "req_1"): Answer => ({
  ok: true,
  decision: "ASK",
  requestId: id,
  reasonCode: "APPROVAL_REQUIRED",
});
const deny = (code = "POLICY_DENIED", id = "req_1"): Answer => ({
  ok: true,
  decision: "DENY",
  requestId: id,
  reasonCode: code,
});

function fakeGuardian(opts: {
  request: () => Promise<Answer>;
  claims?: Answer[];
}) {
  const claims = [...(opts.claims ?? [])];
  const request = vi.fn(opts.request);
  const claim = vi.fn(async () => claims.shift() ?? ask());
  const execute = vi.fn(async () => ({
    ok: true,
    receipt: {
      status: "sent-verified",
      requestId: "req_1",
      receiptReference: "rr_1",
    },
  }));
  const withdraw = vi.fn(async () => ({ ok: true }));
  const client = {
    request,
    claim,
    execute,
    withdraw,
    receipts: vi.fn(),
    portableReceipt: vi.fn(),
  } as unknown as GuardianClient;
  return { client, request, claim, execute, withdraw };
}

const search: BuyToolInput = {
  ask: "two packs of AA batteries from Amazon",
  confirm: false,
  new_order: true,
};
const yes: BuyToolInput = { ask: "yes", confirm: true, new_order: false };
const noSleep = async () => {};

function setup(
  g: ReturnType<typeof fakeGuardian>,
  extra: Record<string, unknown> = {},
) {
  const buy = fakeBuy({ cart: cart(1112, "h_1") });
  const governed = guardBuyTool(buy.tool, {
    client: g.client,
    connectionId: "con_1",
    sleep: noSleep,
    pollIntervalMs: 1,
    ...extra,
  });
  return { buy, governed };
}

const confirmsSent = (sent: BuyToolInput[]) =>
  sent.filter((i) => i.confirm).length;

describe("guardBuyTool", () => {
  it("search passes through without Guardian", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { buy, governed } = setup(g);
    const r = await governed.answer(search);
    expect(r.cart?.hash).toBe("h_1");
    expect(buy.sent).toEqual([search]);
    expect(g.request).not.toHaveBeenCalled();
    // ...while the yes on the same tool does go to Guardian.
    await governed.answer(yes);
    expect(g.request).toHaveBeenCalledTimes(1);
  });

  it("a turn the tool opens is governed too, and the Anthropic runner path (run) is gated", async () => {
    const g = fakeGuardian({ request: async () => deny() });
    const buy = fakeBuy({ cart: cart(1112, "h_1") });
    const inner = fakeBuy({ cart: cart(1112, "h_1") });
    (buy.tool as unknown as { turn: () => BuyTool }).turn = () => inner.tool;
    const governed = guardBuyTool(buy.tool, {
      client: g.client,
      connectionId: "con_1",
      sleep: noSleep,
    });
    const turn = governed.turn("yes");
    await turn.run(search);
    const view = JSON.parse(await turn.run(yes));
    expect(view.decline_code).toBe("guardian_blocked");
    expect(confirmsSent(inner.sent)).toBe(0);
  });

  it("ALLOW: the confirm reaches Agentcard once, declared as a money action, and is recorded", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { buy, governed } = setup(g);
    await governed.answer(search);
    const r = await governed.answer(yes);
    expect(r.decline_code).toBe("sandbox_mode");
    expect(confirmsSent(buy.sent)).toBe(1);
    expect(g.request).toHaveBeenCalledTimes(1);
    const sentToGuardian = (g.request.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(sentToGuardian).toMatchObject({
      action: "tool.invoke",
      connectionId: "con_1",
      toolName: DEFAULT_CHECKOUT_TOOL,
      amountArgument: CHECKOUT_AMOUNT_DECLARATION,
      valueCents: 1112,
    });
    expect(sentToGuardian.arguments).toMatchObject({
      amountMinor: 1112,
      currency: "usd",
      stores: ["Amazon"],
      carts: [
        {
          cartHash: "h_1",
          items: [
            { name: "Energizer AA batteries, 8 pack", qty: 2, priceCents: 556 },
          ],
        },
      ],
    });
    expect(String(sentToGuardian.purpose)).toContain(
      "2 × Energizer AA batteries, 8 pack at Amazon",
    );
    expect(g.execute).toHaveBeenCalledTimes(1); // signed record
  });

  it("ASK then approved: waits, then the confirm goes through once", async () => {
    const g = fakeGuardian({
      request: async () => ask(),
      claims: [ask(), allow()],
    });
    const { buy, governed } = setup(g);
    await governed.answer(search);
    await governed.answer(yes);
    expect(g.claim).toHaveBeenCalledTimes(2);
    expect(confirmsSent(buy.sent)).toBe(1);
  });

  it("ASK then declined: nothing reaches Agentcard", async () => {
    const g = fakeGuardian({
      request: async () => ask(),
      claims: [deny("APPROVAL_DENIED")],
    });
    const { buy, governed } = setup(g);
    await governed.answer(search);
    await expect(governed.answer(yes)).rejects.toMatchObject({
      code: "APPROVAL_DECLINED",
    });
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  it("ASK then timeout: nothing reaches Agentcard and the request is withdrawn", async () => {
    let t = 0;
    const g = fakeGuardian({ request: async () => ask() });
    const { buy, governed } = setup(g, {
      approvalTimeoutMs: 50,
      now: () => (t += 10),
    });
    await governed.answer(search);
    await expect(governed.answer(yes)).rejects.toMatchObject({
      code: "APPROVAL_TIMEOUT",
    });
    expect(confirmsSent(buy.sent)).toBe(0);
    expect(g.withdraw).toHaveBeenCalledWith("req_1");
  });

  it("DENY: nothing reaches Agentcard, and the model reads the refusal", async () => {
    const g = fakeGuardian({ request: async () => deny() });
    const { buy, governed } = setup(g);
    await governed.answer(search);
    const text = await governed.run(yes);
    const view = JSON.parse(text);
    expect(view.decline_code).toBe("guardian_blocked");
    expect(view.reply).toMatch(/^Guardian blocked this purchase: /);
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  it("Guardian unreachable: fails closed", async () => {
    const g = fakeGuardian({
      request: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const { buy, governed } = setup(g);
    await governed.answer(search);
    const error = await governed.answer(yes).catch((e) => e);
    expect(error).toBeInstanceOf(GuardianPurchaseBlocked);
    expect(error.code).toBe("GUARDIAN_UNREACHABLE");
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  it("amount changed after approval: the next confirm asks again", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { buy, governed } = setup(g);
    await governed.answer(search);
    await governed.answer(yes);
    // The store reprices the cart (tax added): a new total and hash.
    buy.shown.cart = cart(1500, "h_2");
    await governed.answer(search);
    await governed.answer(yes);
    expect(g.request).toHaveBeenCalledTimes(2);
    const second = (g.request.mock.calls[1] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(second.valueCents).toBe(1500);
    expect(
      (second.arguments as { carts: { cartHash: string }[] }).carts[0]!
        .cartHash,
    ).toBe("h_2");
  });

  it("cart changed while a person was deciding: refused, nothing reaches Agentcard", async () => {
    const buy = fakeBuy({ cart: cart(1112, "h_1") });
    let governed!: BuyTool;
    const g = fakeGuardian({ request: async () => ask() });
    g.claim.mockImplementation(async () => {
      // Another call showed a different cart meanwhile.
      buy.shown.cart = cart(9999, "h_9");
      await governed.answer(search);
      return allow();
    });
    governed = guardBuyTool(buy.tool, {
      client: g.client,
      connectionId: "con_1",
      sleep: noSleep,
      pollIntervalMs: 1,
    });
    await governed.answer(search);
    await expect(governed.answer(yes)).rejects.toMatchObject({
      code: "CART_CHANGED",
    });
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  it("a confirm with no cart seen is refused", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { buy, governed } = setup(g);
    await expect(governed.answer(yes)).rejects.toMatchObject({
      code: "NO_CART_SEEN",
    });
    expect(confirmsSent(buy.sent)).toBe(0);
    expect(g.request).not.toHaveBeenCalled();
  });

  it("keeps the tool's shape, non-enumerable fields included", () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { governed } = setup(g);
    expect(governed.name).toBe("buy");
    expect((governed as unknown as { definition: unknown }).definition).toEqual(
      { name: "buy" },
    );
    expect(JSON.parse(JSON.stringify(governed))).toMatchObject({
      name: "buy",
      strict: true,
    });
  });
});
