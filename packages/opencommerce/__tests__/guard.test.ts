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
  DEFAULT_REQUEST_TTL_MS,
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

type Body = Record<string, unknown>;

/**
 * A fake AgentcardClient: `buy` records each request that reached Agentcard;
 * `conversation` reads the carts as Agentcard holds them now.
 */
function fakeAgentcard(shown: { cart: BuyCart }) {
  const sent: Body[] = [];
  const conversations = new Map<string, BuyCart[] | "unreadable">();
  const agentcard = {
    buy: vi.fn(async (body: Body) => {
      sent.push(body);
      return {
        conversation_id:
          typeof body.conversation_id === "string"
            ? body.conversation_id
            : "conv_1",
        carts: [shown.cart],
      };
    }),
    conversation: vi.fn(async (id: string) => {
      const held = conversations.get(id);
      if (held === "unreadable") throw new Error("read failed");
      if (held) return { conversation_id: id, carts: held };
      if (id === "conv_1") return { conversation_id: id, carts: [shown.cart] };
      throw new Error("no such conversation");
    }),
  };
  // The client's own `buy`, as Agentcard receives it (the guard replaces the property).
  return { agentcard, sent, conversations, reached: agentcard.buy };
}

/** A buy tool whose search shows `shown`; every request goes out through the Agentcard client, as the real tool's do. */
function fakeBuy(
  shown: { cart: BuyCart },
  ac: ReturnType<typeof fakeAgentcard> = fakeAgentcard(shown),
) {
  const { agentcard, sent } = ac;
  const answerWith = (bodyOf: (input: BuyToolInput) => Body) =>
    vi.fn(async (input: BuyToolInput) => {
      const body = bodyOf(input);
      const turn = (await agentcard.buy(body)) as { conversation_id: string };
      if (body.confirm !== undefined) {
        return result({
          status: "declined",
          decline_code: "sandbox_mode",
          cart: shown.cart,
          carts: [shown.cart],
          confirm_sent: true,
          conversation_id: turn.conversation_id,
        });
      }
      return result({
        status: "needs_input",
        next_action: "confirm",
        cart: shown.cart,
        carts: [shown.cart],
        conversation_id: turn.conversation_id,
      });
    });
  const toolOf = (answer: ReturnType<typeof answerWith>) => {
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
    return tool;
  };
  const answer = answerWith((input) =>
    input.confirm
      ? { resume: true, confirm: true }
      : { resume: true, ask: input.ask },
  );
  const tool = toolOf(answer);
  // A `nextStep` turn whose call sends `step.body`, as the SDK's step plan does.
  const step: { body: Body | null } = { body: null };
  Object.assign(tool, {
    nextStep: () =>
      step.body === null ? null : toolOf(answerWith(() => step.body!)),
  });
  return {
    tool: tool as unknown as BuyTool,
    sent,
    answer,
    shown,
    agentcard,
    ac,
    step,
  };
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
  request: (invocation?: unknown) => Promise<Answer>;
  claims?: Answer[];
  record?: (receipt: {
    subject: Answer;
    action: Answer & { materialParameters: Answer };
  }) => void;
}) {
  const claims = [...(opts.claims ?? [])];
  const request = vi.fn(opts.request);
  const claim = vi.fn(async () => claims.shift() ?? ask());
  const execute = vi.fn(
    async (): Promise<Answer> => ({
      ok: true,
      receipt: {
        status: "sent-verified",
        requestId: "req_1",
        receiptReference: "rr_1",
      },
    }),
  );
  const withdraw = vi.fn(async () => ({ ok: true }));
  const receipts = vi.fn(
    async (): Promise<Answer> => ({ ok: true, receipts: [] }),
  );
  // The signed record of the last request, as Guardian keeps it; `record` edits it.
  const portableReceipt = vi.fn(async (requestId: string): Promise<Answer> => {
    const calls = request.mock.calls;
    const invocation = (calls[calls.length - 1]?.[0] ?? {}) as Answer;
    const receipt = {
      subject: { requestId },
      action: {
        requestId,
        action: "tool.invoke",
        materialParameters: {
          toolName: invocation.toolName,
          connectionId: invocation.connectionId,
          arguments: JSON.parse(JSON.stringify(invocation.arguments ?? null)),
        },
      },
      decision: { decision: "ASK" },
      approval: { state: "approved" },
    };
    opts.record?.(receipt);
    return { ok: true, receipt };
  });
  const client = {
    request,
    claim,
    execute,
    withdraw,
    receipts,
    portableReceipt,
  } as unknown as GuardianClient;
  return {
    client,
    request,
    claim,
    execute,
    withdraw,
    receipts,
    portableReceipt,
  };
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
    agentcard: buy.agentcard,
    sleep: noSleep,
    pollIntervalMs: 1,
    ...extra,
  });
  return { buy, governed };
}

const confirmsSent = (sent: Body[]) =>
  sent.filter((b) => b.confirm !== undefined).length;

describe("guardBuyTool", () => {
  it("search passes through without Guardian", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { buy, governed } = setup(g);
    const r = await governed.answer(search);
    expect(r.cart?.hash).toBe("h_1");
    expect(buy.sent).toEqual([{ resume: true, ask: search.ask }]);
    expect(g.request).not.toHaveBeenCalled();
    // ...while the yes on the same tool does go to Guardian.
    await governed.answer(yes);
    expect(g.request).toHaveBeenCalledTimes(1);
  });

  it("a turn the tool opens is governed too, and the Anthropic runner path (run) is gated", async () => {
    const g = fakeGuardian({ request: async () => deny() });
    const buy = fakeBuy({ cart: cart(1112, "h_1") });
    const inner = fakeBuy(buy.shown, buy.ac);
    (buy.tool as unknown as { turn: () => BuyTool }).turn = () => inner.tool;
    const governed = guardBuyTool(buy.tool, {
      client: g.client,
      connectionId: "con_1",
      agentcard: buy.agentcard,
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
    // Redeemed before the confirm reached Agentcard.
    expect(g.execute.mock.invocationCallOrder[0]!).toBeLessThan(
      buy.ac.reached.mock.invocationCallOrder.at(-1)!,
    );
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
      requestTtlMs: 50,
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
      agentcard: buy.agentcard,
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

  // ---------- redeem before the purchase ----------

  it("a revoked capability (execute refuses) leaves the confirm unsent", async () => {
    const g = fakeGuardian({ request: async () => ask(), claims: [allow()] });
    g.execute.mockImplementation(async () => ({
      ok: false,
      reasonCode: "CAPABILITY_REVOKED",
    }));
    const { buy, governed } = setup(g);
    await governed.answer(search);
    const error = await governed.answer(yes).catch((e) => e);
    expect(error).toBeInstanceOf(GuardianPurchaseBlocked);
    expect(error).toMatchObject({
      code: "EXECUTE_FAILED",
      reasonCode: "CAPABILITY_REVOKED",
      outcomeUnknown: false,
    });
    expect(confirmsSent(buy.sent)).toBe(0);
    expect(g.receipts).not.toHaveBeenCalled();
  });

  it("an expired capability on ALLOW leaves the confirm unsent", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    g.execute.mockImplementation(async () => ({
      ok: false,
      reasonCode: "CAPABILITY_EXPIRED",
    }));
    const { buy, governed } = setup(g);
    await governed.answer(search);
    await expect(governed.answer(yes)).rejects.toMatchObject({
      code: "EXECUTE_FAILED",
    });
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  it("execute outcome unknown and no verified record: refused, outcomeUnknown, nothing sent", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    g.execute.mockImplementation(async () => ({
      ok: false,
      reasonCode: "HTTP_502",
      outcomeUnknown: true,
    }));
    const { buy, governed } = setup(g);
    await governed.answer(search);
    await expect(governed.answer(yes)).rejects.toMatchObject({
      code: "EXECUTE_FAILED",
      outcomeUnknown: true,
      requestId: "req_1",
    });
    expect(g.receipts).toHaveBeenCalledWith("req_1");
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  it("execute answer lost but Guardian recorded the redemption: the confirm goes once", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    g.execute.mockImplementation(async () => {
      throw new TypeError("socket hang up");
    });
    g.receipts.mockImplementation(async () => ({
      ok: true,
      receipts: [{ state: "verified", attemptId: "att_1" }],
    }));
    const { buy, governed } = setup(g);
    await governed.answer(search);
    const r = await governed.answer(yes);
    expect(r.decline_code).toBe("sandbox_mode");
    expect(confirmsSent(buy.sent)).toBe(1);
  });

  it("execute outcome unknown and the attempt aborted: refused without outcomeUnknown", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    g.execute.mockImplementation(async () => ({
      ok: true,
      receipt: { status: "outcome-pending", requestId: "req_1" },
    }));
    g.receipts.mockImplementation(async () => ({
      ok: true,
      receipts: [{ state: "aborted" }],
    }));
    const { buy, governed } = setup(g);
    await governed.answer(search);
    await expect(governed.answer(yes)).rejects.toMatchObject({
      code: "EXECUTE_FAILED",
      outcomeUnknown: false,
    });
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  // ---------- nextStep decides on the cart as it stands ----------

  function withNextStep(buy: ReturnType<typeof fakeBuy>, body: Body) {
    buy.step.body = body;
  }
  const event = { kind: "card_added", advances: true } as never;
  const carriedYes = (hash: string, conversationId = "conv_1"): Body => ({
    confirm: hash,
    conversation_id: conversationId,
    payment_source: "vault",
    carried: { from: "yes", cart_hash: hash },
  });
  const underFifty = async (invocation?: unknown) =>
    ((invocation as { valueCents: number }).valueCents <= 5000
      ? allow()
      : deny("ABOVE_LIMIT")) as Answer;

  it("nextStep: Guardian decides the conversation's total now, not the total the wrapper saw", async () => {
    const g = fakeGuardian({ request: underFifty });
    const { buy, governed } = setup(g);
    buy.shown.cart = cart(4500, "h_1");
    await governed.answer(search); // the table shows $45.00
    // The store priced tax and fees in: same order, same hash, $58.00 now.
    buy.ac.conversations.set("conv_1", [cart(5800, "h_1")]);
    withNextStep(buy, carriedYes("h_1"));
    const turn = governed.nextStep(event)!;
    const view = JSON.parse(await turn.run(search));
    expect(view.decline_code).toBe("guardian_blocked");
    const proposed = (g.request.mock.calls[0] as unknown[])[0] as Body;
    expect(proposed.valueCents).toBe(5800);
    expect(proposed.arguments).toMatchObject({
      amountMinor: 5800,
      step: "next_step",
      confirms: "one_cart",
    });
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  it("nextStep: a conversation that cannot be read is refused before Guardian, nothing sent", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { buy, governed } = setup(g);
    await governed.answer(search);
    buy.ac.conversations.set("conv_1", "unreadable");
    withNextStep(buy, carriedYes("h_1"));
    await expect(
      governed.nextStep(event)!.answer(search),
    ).rejects.toMatchObject({ code: "CART_UNREADABLE" });
    expect(g.request).not.toHaveBeenCalled();
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  it("nextStep: the conversation the step names is the one read and proposed", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { buy, governed } = setup(g);
    await governed.answer(search); // table: conv_1
    buy.ac.conversations.set("conv_2", [cart(2400, "h_2", "Target")]);
    withNextStep(buy, carriedYes("h_2", "conv_2"));
    await governed.nextStep(event)!.answer(search);
    expect(buy.agentcard.conversation).toHaveBeenCalledWith(
      "conv_2",
      undefined,
    );
    const proposed = (g.request.mock.calls[0] as unknown[])[0] as Body;
    expect(proposed.arguments).toMatchObject({
      conversationId: "conv_2",
      amountMinor: 2400,
      stores: ["Target"],
      carts: [{ cartHash: "h_2" }],
    });
    expect(confirmsSent(buy.sent)).toBe(1);
  });

  it("nextStep that replays the shopper's search (no confirm) goes ahead without Guardian, even with no cart seen", async () => {
    const g = fakeGuardian({ request: async () => deny() });
    const { buy, governed } = setup(g);
    withNextStep(buy, {
      resume: true,
      ask: search.ask,
      payment_source: "vault",
    });
    const r = await governed.nextStep(event)!.answer(search);
    expect(r.status).toBe("needs_input");
    expect(buy.sent).toHaveLength(1);
    expect(g.request).not.toHaveBeenCalled();
  });

  it("the pre-send check compares against the freshly read cart", async () => {
    const g = fakeGuardian({ request: async () => ask() });
    const { buy, governed } = setup(g);
    await governed.answer(search);
    g.claim.mockImplementation(async () => {
      buy.ac.conversations.set("conv_1", [cart(9900, "h_1")]);
      return allow();
    });
    withNextStep(buy, carriedYes("h_1"));
    await expect(
      governed.nextStep(event)!.answer(search),
    ).rejects.toMatchObject({ code: "CART_CHANGED" });
    expect(g.execute).not.toHaveBeenCalled();
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  // ---------- the carts an approval pays ----------

  function twoCarts(g: ReturnType<typeof fakeGuardian>, body: Body) {
    const s = setup(g);
    s.buy.ac.conversations.set("conv_1", [
      cart(2000, "h_a", "Amazon"),
      cart(3000, "h_b", "Target"),
    ]);
    (
      s.buy.tool as unknown as { approve: () => Promise<BuyToolResult> }
    ).approve = async () => {
      await s.buy.agentcard.buy(body);
      return result({ status: "approval_sent" });
    };
    const governed = guardBuyTool(s.buy.tool, {
      client: g.client,
      connectionId: "con_1",
      agentcard: s.buy.agentcard,
      sleep: noSleep,
    });
    return { ...s, governed };
  }

  it("approve of one cart proposes that cart alone", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { buy, governed } = twoCarts(g, {
      conversation_id: "conv_1",
      confirm: "h_a",
    });
    await governed.answer(search);
    await governed.approve!({ wallet: "vault" });
    const proposed = (g.request.mock.calls[0] as unknown[])[0] as Body;
    expect(proposed.valueCents).toBe(2000);
    expect(proposed.arguments).toMatchObject({
      step: "approve",
      confirms: "one_cart",
      carts: [{ cartHash: "h_a" }],
    });
    expect((proposed.arguments as { carts: unknown[] }).carts).toHaveLength(1);
    expect(confirmsSent(buy.sent)).toBe(1);
  });

  it("a combined approval proposes every cart it pays", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { governed } = twoCarts(g, { resume: true, confirm: true });
    await governed.answer(search);
    await governed.approve!({ wallet: "vault" });
    const proposed = (g.request.mock.calls[0] as unknown[])[0] as Body;
    expect(proposed.valueCents).toBe(5000);
    expect(proposed.arguments).toMatchObject({ confirms: "every_cart" });
  });

  it("a Link payment counts its charge when higher than the cart", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { governed } = twoCarts(g, {
      conversation_id: "conv_1",
      confirm: "h_a",
      link_payment: {
        spend_request_id: "sr_1",
        amount_cents: 2600,
        currency: "usd",
      },
    });
    await governed.answer(search);
    await governed.approve!({ wallet: "link" });
    const proposed = (g.request.mock.calls[0] as unknown[])[0] as Body;
    expect(proposed.valueCents).toBe(2600);
  });

  // ---------- request TTL ----------

  it("asks with the gateway's longest TTL and bounds the wait by it", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { governed } = setup(g);
    await governed.answer(search);
    await governed.answer(yes);
    expect(((g.request.mock.calls[0] as unknown[])[0] as Body).ttlMs).toBe(
      DEFAULT_REQUEST_TTL_MS,
    );
    expect(DEFAULT_REQUEST_TTL_MS).toBe(300_000);
    expect(() => setup(g, { requestTtlMs: 10 * 60_000 })).toThrow(TypeError);
  });

  it("an expired request is reported as expiry, not as a person's decline", async () => {
    const decisions: string[] = [];
    const g = fakeGuardian({
      request: async () => ask(),
      claims: [{ ok: false, reasonCode: "REQUEST_EXPIRED" }],
    });
    const { buy, governed } = setup(g, {
      onDecision: (e: { decision: string }) => decisions.push(e.decision),
    });
    await governed.answer(search);
    await expect(governed.answer(yes)).rejects.toMatchObject({
      code: "APPROVAL_EXPIRED",
    });
    expect(decisions).toEqual(["ASK", "EXPIRED"]);
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  // ---------- every path that can confirm ----------

  it("a yes through a turn's handled() fast path reaches Guardian and is blocked on DENY", async () => {
    const g = fakeGuardian({ request: async () => deny() });
    const { buy, governed: _ } = setup(g);
    const inner = fakeBuy(buy.shown, buy.ac);
    // handled() sends the confirm itself, not through answer().
    Object.defineProperty(inner.tool, "handled", {
      value: async () => {
        await buy.agentcard.buy({ resume: true, confirm: true });
        return true;
      },
      enumerable: false,
    });
    (buy.tool as unknown as { turn: () => BuyTool }).turn = () => inner.tool;
    const governed = guardBuyTool(buy.tool, {
      client: g.client,
      connectionId: "con_1",
      agentcard: buy.agentcard,
      sleep: noSleep,
    });
    await governed.answer(search);
    const turn = governed.turn("yes") as unknown as {
      handled: () => Promise<boolean>;
    };
    await expect(turn.handled()).rejects.toMatchObject({
      code: "GUARDIAN_DENIED",
    });
    expect(g.request).toHaveBeenCalledTimes(1);
    expect(confirmsSent(buy.sent)).toBe(0);
  });

  it("a confirm sent on the Agentcard client outside the governed tool is refused", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { buy } = setup(g);
    await expect(
      buy.agentcard.buy({ resume: true, confirm: true }),
    ).rejects.toMatchObject({ code: "UNGOVERNED_CALL" });
    expect(g.request).not.toHaveBeenCalled();
    expect(buy.sent).toHaveLength(0);
  });

  describe("after a person approved, the signed record", () => {
    const approved = (record?: Parameters<typeof fakeGuardian>[0]["record"]) =>
      fakeGuardian({
        request: async () => ask(),
        claims: [allow()],
        ...(record ? { record } : {}),
      });

    it("matching: the confirm goes through, read before execute", async () => {
      const g = approved();
      const { buy, governed } = setup(g);
      await governed.answer(search);
      await governed.answer(yes);
      expect(g.portableReceipt).toHaveBeenCalledWith("req_1");
      expect(g.portableReceipt.mock.invocationCallOrder[0]).toBeLessThan(
        g.execute.mock.invocationCallOrder[0]!,
      );
      expect(confirmsSent(buy.sent)).toBe(1);
    });

    it("naming other arguments: refused, nothing sent, not redeemed", async () => {
      const g = approved((r) => {
        (r.action.materialParameters.arguments as Answer).amountMinor = 1;
      });
      const { buy, governed } = setup(g);
      await governed.answer(search);
      await expect(governed.answer(yes)).rejects.toMatchObject({
        code: "RECORD_MISMATCH",
      });
      expect(confirmsSent(buy.sent)).toBe(0);
      expect(g.execute).not.toHaveBeenCalled();
    });

    it("naming another tool: refused", async () => {
      const g = approved((r) => {
        r.action.materialParameters.toolName = "other.tool";
      });
      const { buy, governed } = setup(g);
      await governed.answer(search);
      await expect(governed.answer(yes)).rejects.toMatchObject({
        code: "RECORD_MISMATCH",
      });
      expect(confirmsSent(buy.sent)).toBe(0);
    });

    it("naming another connection: refused", async () => {
      const g = approved((r) => {
        r.action.materialParameters.connectionId = "con_other";
      });
      const { buy, governed } = setup(g);
      await governed.answer(search);
      await expect(governed.answer(yes)).rejects.toMatchObject({
        code: "RECORD_MISMATCH",
      });
      expect(confirmsSent(buy.sent)).toBe(0);
    });

    it("naming another request: refused", async () => {
      const g = approved((r) => {
        r.subject.requestId = "req_old";
      });
      const { buy, governed } = setup(g);
      await governed.answer(search);
      await expect(governed.answer(yes)).rejects.toMatchObject({
        code: "RECORD_MISMATCH",
      });
      expect(confirmsSent(buy.sent)).toBe(0);
    });

    it("that does not verify against the given keys: refused", async () => {
      const g = approved();
      const { buy, governed } = setup(g, {
        receiptVerificationKeys: { keys: [] },
      });
      await governed.answer(search);
      await expect(governed.answer(yes)).rejects.toMatchObject({
        code: "RECORD_MISMATCH",
      });
      expect(confirmsSent(buy.sent)).toBe(0);
      expect(g.execute).not.toHaveBeenCalled();
    });

    it("is not read on ALLOW", async () => {
      const g = fakeGuardian({ request: async () => allow() });
      const { governed } = setup(g);
      await governed.answer(search);
      await governed.answer(yes);
      expect(g.portableReceipt).not.toHaveBeenCalled();
    });
  });

  it("a tool built on another Agentcard client fails closed (UNGOVERNED_CLIENT)", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const shown = { cart: cart(1112, "h_1") };
    // The tool sends through its own client; another one is passed as agentcard.
    const own = fakeAgentcard(shown);
    const buy = fakeBuy(shown, own);
    const other = fakeAgentcard(shown);
    const governed = guardBuyTool(buy.tool, {
      client: g.client,
      connectionId: "con_1",
      agentcard: other.agentcard,
      sleep: noSleep,
    });
    await governed.answer(search);
    await expect(governed.answer(yes)).rejects.toMatchObject({
      code: "UNGOVERNED_CLIENT",
    });
    const view = JSON.parse(await governed.run(yes));
    expect(view.guardian.code).toBe("UNGOVERNED_CLIENT");
    expect(g.request).not.toHaveBeenCalled();
  });

  it("a result showing an order placed with no governed payment fails closed", async () => {
    const g = fakeGuardian({ request: async () => allow() });
    const { buy, governed } = setup(g);
    buy.answer.mockImplementationOnce(async () =>
      result({ status: "order_placed", order_id: "ord_1" }),
    );
    await expect(governed.answer(search)).rejects.toMatchObject({
      code: "UNGOVERNED_CLIENT",
    });
  });
});
