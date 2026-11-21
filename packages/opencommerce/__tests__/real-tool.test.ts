import { describe, expect, it, vi } from "vitest";
import { AgentcardClient, buyTool } from "@agent-cards/commerce-sdk";
import type { GuardianClient } from "@odingard/guardian-sdk";

import { guardBuyTool } from "../src/index.js";

describe("with the real @agent-cards/commerce-sdk buy tool", () => {
  it("keeps the tool's shape and refuses a confirm before anything reaches Agentcard", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("no network in tests");
    });
    const agentcard = new AgentcardClient({
      clientId: "id",
      clientSecret: "secret",
      fetch: fetch as never,
    });
    const buy = buyTool({ agentcard, externalUserId: "shopper-1" });
    const request = vi.fn();
    const governed = guardBuyTool(buy, {
      client: {
        request,
        claim: vi.fn(),
        execute: vi.fn(),
      } as unknown as GuardianClient,
      connectionId: "con_1",
    });
    expect(JSON.stringify(governed)).toBe(JSON.stringify(buy));
    expect(governed.definition).toEqual(buy.definition);
    expect(governed.inputSchema["~standard"].version).toBe(1);
    expect(governed.openai.function.name).toBe("buy");
    const view = JSON.parse(
      await governed.run({
        ask: "yes",
        confirm: true,
        new_order: false,
        product_id: null,
        store_id: null,
      }),
    );
    expect(view.decline_code).toBe("guardian_blocked");
    expect(fetch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
