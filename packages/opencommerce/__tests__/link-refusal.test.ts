import { describe, expect, it, vi } from "vitest";
import { AgentcardClient, buyTool } from "@agent-cards/commerce-sdk";
import type { GuardianClient } from "@odingard/guardian-sdk";

import {
  blockedForModel,
  GuardianPurchaseBlocked,
  guardBuyTool,
} from "../src/index.js";

const CONVERSATION = "conv_link_1";
const PROFILE = "profile_agentcard01";

function cartOf(merchant: string) {
  return {
    hash: `hash_${merchant}`,
    merchant,
    merchant_name: "Corner Shop",
    store: {
      id: "cornershop.example",
      name: "Corner Shop",
      domain: "cornershop.example",
    },
    items: [{ name: "Paper", qty: 1, priceCents: 1200 }],
    totalCents: 1200,
    currency: "usd",
  };
}

/** An Agentcard that answers a cart, and records what reaches it. */
function agentcardOf(merchant: string) {
  const cart = cartOf(merchant);
  const sent: Record<string, unknown>[] = [];
  const fetch = vi.fn(
    async (url: string, init: { method?: string; body?: string }) => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/api/v2/oauth/token")) {
        return json({ access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/buy/conversations/")) {
        return json({ conversation_id: CONVERSATION, carts: [cart] });
      }
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      sent.push(body);
      if (body.link_payment !== undefined) {
        return json({
          conversation_id: CONVERSATION,
          status: "order_placed",
          order_id: "ord_1",
          reply: "Your Corner Shop order is placed.",
          carts: [],
        });
      }
      return json({
        conversation_id: CONVERSATION,
        status: "needs_input",
        next_action: "confirm",
        reply: "1 Paper from Corner Shop, $12.00. Say yes to buy.",
        cart,
        carts: [cart],
        wallets: [{ wallet: "link", fits: true, network_id: PROFILE }],
      });
    },
  );
  const agentcard = new AgentcardClient({
    clientId: "id",
    clientSecret: "secret",
    fetch: fetch as never,
  });
  return { agentcard, sent, cart };
}

/** A Link client whose spend requests the shopper approves at once. */
function linkOf() {
  let n = 0;
  const requests = new Map<string, Record<string, unknown>>();
  const link = {
    userInfo: {
      retrieve: vi.fn(async () => ({ email: "shopper@example.com" })),
    },
    paymentMethods: {
      list: vi.fn(async () => [{ id: "pm_1", is_default: true }]),
    },
    spendRequests: {
      create: vi.fn(async (params: Record<string, unknown>) => {
        const id = `lsrq_${++n}`;
        const request = {
          id,
          status: "pending_approval",
          approval_url: `https://link.example/approve/${id}`,
          ...params,
        };
        requests.set(id, request);
        return request;
      }),
      retrieve: vi.fn(async (id: string) => ({
        ...requests.get(id),
        status: "approved",
        shared_payment_token: { id: "spt_test1" },
      })),
      cancel: vi.fn(async (id: string) => ({
        ...requests.get(id),
        status: "canceled",
      })),
    },
  };
  return link;
}

function guardianOf(decisions: Array<"DENY" | "ALLOW">) {
  let i = 0;
  const request = vi.fn(async () => {
    const decision = decisions[i++] ?? "DENY";
    return decision === "ALLOW"
      ? {
          ok: true,
          decision: "ALLOW",
          requestId: `req_${i}`,
          capabilityToken: `cap_${i}`,
        }
      : {
          ok: true,
          decision: "DENY",
          requestId: `req_${i}`,
          reasonCode: "OVER_LIMIT",
        };
  });
  const execute = vi.fn(async ({ requestId }: { requestId: string }) => ({
    ok: true,
    receipt: { status: "sent-verified", requestId },
  }));
  return {
    client: { request, claim: vi.fn(), execute } as unknown as GuardianClient,
    request,
  };
}

describe("a Stripe Link confirm Guardian refuses, with the real buy tool", () => {
  it.each([
    ["retail", "retail"],
    ["store checkout", "cornershop.example"],
  ])(
    "%s: says Guardian blocked it, frees the cart, and a later approved yes pays",
    async (_label, merchant) => {
      const { agentcard, sent } = agentcardOf(merchant);
      const link = linkOf();
      const buy = buyTool({
        agentcard,
        externalUserId: "shopper-1",
        wallet: { link } as never,
        wallets: ["link"],
      });
      const guardian = guardianOf(["DENY", "ALLOW"]);
      const governed = guardBuyTool(buy, {
        client: guardian.client,
        connectionId: "con_1",
        agentcard,
      });
      const wallet = governed as unknown as {
        awaitWallet: () => Promise<unknown>;
      };
      await governed.answer({
        ask: "printer paper",
        confirm: false,
        new_order: true,
        product_id: null,
        store_id: null,
      });
      const yes = {
        ask: "yes",
        confirm: true,
        new_order: false,
        product_id: null,
        store_id: null,
      };

      // DENY: the confirm never reaches Agentcard, and Guardian's refusal is the answer.
      await governed.answer(yes);
      await governed.approve!({ wallet: "link" } as never);
      expect(link.spendRequests.create).toHaveBeenCalledTimes(1);
      const refused = await wallet.awaitWallet().then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(GuardianPurchaseBlocked);
      expect(refused).toMatchObject({
        code: "GUARDIAN_DENIED",
        reasonCode: "OVER_LIMIT",
        status: 403,
      });
      expect((refused as Error).message).toMatch(
        /^Guardian blocked this purchase/,
      );
      expect(
        JSON.parse(blockedForModel(refused as GuardianPurchaseBlocked)),
      ).toMatchObject({
        decline_code: "guardian_blocked",
        guardian: { code: "GUARDIAN_DENIED" },
      });
      expect(sent.some((b) => b.link_payment !== undefined)).toBe(false);
      // The SDK read it as a refusal: the Link payment was released, not held as a lost answer.
      expect(link.spendRequests.cancel).toHaveBeenCalledWith("lsrq_1");

      // The model's own yes after the refusal reads the refusal too, never UNGOVERNED_CLIENT.
      const view = JSON.parse(await governed.run(yes));
      expect(view.guardian?.code).not.toBe("UNGOVERNED_CLIENT");
      expect(JSON.stringify(view)).not.toMatch(/may have gone through/);

      // The cart is not left placing: a later yes Guardian allows asks Link again and pays.
      await governed.approve!({ wallet: "link" } as never);
      expect(link.spendRequests.create).toHaveBeenCalledTimes(2);
      await wallet.awaitWallet();
      expect(guardian.request).toHaveBeenCalledTimes(2);
      const paid = sent.filter((b) => b.link_payment !== undefined);
      expect(paid).toHaveLength(1);
      expect(paid[0]!.link_payment).toMatchObject({
        spend_request_id: "lsrq_2",
      });
    },
  );
});
