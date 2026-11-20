/**
 * Held requests are scoped per session: one set of wrapped tools on one
 * Mastra agent serves several conversations, and a call held and approved in
 * one must not be claimed by the same call in another. Real `Agent` loop,
 * scripted model, stand-in Guardian.
 */
import { describe, expect, it, vi } from "vitest";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { SCOPE_UNKNOWN } from "@odingard/guardian-sdk";

import { guardianTools, type GuardianMastraOptions } from "../src/index.js";
import { fakeGuardian, say, scriptedModel, toolCall } from "./helpers.js";

const ARGS = { orderId: "ord_9", amount: 25 };

/** Each `generate` makes the same tool call, then answers in text. */
function setup(
  options: Partial<GuardianMastraOptions> = {},
  args: Record<string, unknown> = ARGS,
  suspending = false,
) {
  const guardian = fakeGuardian(() => "ASK");
  const body = vi.fn(() => ({ refunded: true }));
  let calls = 0;
  const call = () => [toolCall(`call_${++calls}`, "refund", args)];
  // A run that suspends takes no text step until it is resumed.
  const script = suspending
    ? [call(), call(), [say("ok")]]
    : Array.from({ length: 8 }, () => [call(), [say("ok")]]).flat();
  const { model } = scriptedModel(script);
  const tools = guardianTools(
    {
      refund: createTool({
        id: "refund_order",
        description: "Refund an order",
        // The model may add fields of its own; they stay arguments.
        inputSchema: z.looseObject({ orderId: z.string(), amount: z.number() }),
        execute: async () => body() as never,
      }),
    },
    {
      client: guardian.client,
      connectionId: "con_1",
      mode: "inProcess",
      ...options,
    },
  );
  const mastra = new Mastra({
    agents: {
      billing: new Agent({
        id: "billing",
        name: "billing",
        instructions: "Refund orders when asked.",
        model,
        tools,
      }),
    },
    storage: new InMemoryStore(),
    logger: false,
  });
  const agent = mastra.getAgent("billing");
  const ask = (thread?: string, resource?: string, extra: object = {}) =>
    agent.generate("Refund order ord_9, $25", {
      ...(thread === undefined && resource === undefined
        ? {}
        : {
            memory: {
              ...(thread === undefined ? {} : { thread }),
              ...(resource === undefined ? {} : { resource }),
            } as never,
          }),
      ...extra,
    });
  return { guardian, body, ask, agent };
}

describe("held requests are scoped per Mastra thread", () => {
  it("the same call in another thread proposes its own request and never claims the first thread's approval", async () => {
    const { guardian, body, ask } = setup();
    await ask("thread_a", "user_a"); // held: req_1
    guardian.approve("req_1");

    await ask("thread_b", "user_b"); // same tool, same arguments
    expect(guardian.claim).not.toHaveBeenCalled();
    expect(guardian.requests.map((r) => r.requestId)).toEqual([
      "req_1",
      "req_2",
    ]);
    expect(body).not.toHaveBeenCalled();

    // The first thread's repeat call claims its own request and runs once.
    await ask("thread_a", "user_a");
    expect(guardian.claim).toHaveBeenCalledTimes(1);
    expect(guardian.claim).toHaveBeenCalledWith("req_1");
    expect(guardian.request).toHaveBeenCalledTimes(2);
    expect(body).toHaveBeenCalledTimes(1);
    expect(guardian.redeemed).toEqual(["req_1"]);
  });

  it("the same thread id under another resource is another scope", async () => {
    const { guardian, body, ask } = setup();
    await ask("thread_1", "user_a");
    guardian.approve("req_1");
    await ask("thread_1", "user_b");
    expect(guardian.claim).not.toHaveBeenCalled();
    expect(guardian.request).toHaveBeenCalledTimes(2);
    expect(body).not.toHaveBeenCalled();
  });

  it("the scope is never read from the tool call's arguments", async () => {
    // The model writes the other session's ids into its arguments.
    const forged = { ...ARGS, threadId: "thread_a", resourceId: "user_a" };
    const { guardian, body, ask } = setup({}, forged);
    await ask("thread_a", "user_a"); // held: req_1, same arguments
    guardian.approve("req_1");
    await ask("thread_b", "user_b");
    expect(guardian.claim).not.toHaveBeenCalled();
    expect(guardian.request).toHaveBeenCalledTimes(2);
    expect(body).not.toHaveBeenCalled();
  });

  it("without a thread or resource, and without scope, held calls are shared as before", async () => {
    const { guardian, body, ask } = setup();
    await ask();
    guardian.approve("req_1");
    await ask();
    expect(guardian.claim).toHaveBeenCalledWith("req_1");
    expect(guardian.request).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('onAsk "suspend": the resumed run claims its own thread\'s request', async () => {
    const { guardian, body, ask, agent } = setup(
      { onAsk: "suspend" },
      ARGS,
      true,
    );
    const first = await ask("thread_a", "user_a");
    expect(first.finishReason).toBe("suspended");
    const other = await ask("thread_b", "user_b");
    expect(other.finishReason).toBe("suspended");
    expect(guardian.request).toHaveBeenCalledTimes(2);
    guardian.approve("req_1");
    const done = await agent.resumeGenerate(
      {},
      { runId: first.runId!, toolCallId: "call_1" },
    );
    expect(done.finishReason).toBe("stop");
    expect(guardian.claim).toHaveBeenCalledTimes(1);
    expect(guardian.claim).toHaveBeenCalledWith("req_1");
    expect(guardian.request).toHaveBeenCalledTimes(2);
    expect(body).toHaveBeenCalledTimes(1);
  });
});

describe("the scope option", () => {
  const tenant = (context: unknown) =>
    (
      context as {
        requestContext?: { get(key: string): unknown };
      }
    )?.requestContext?.get("tenantId") as string | undefined;

  it("names the scope from the context the app passes, in place of the thread", async () => {
    const { RequestContext } = await import("@mastra/core/request-context");
    const withTenant = (tenantId: string) => {
      const requestContext = new RequestContext();
      requestContext.set("tenantId", tenantId);
      return { requestContext };
    };
    const { guardian, body, ask } = setup({ scope: tenant });
    await ask("thread_1", "user_1", withTenant("tenant_a")); // req_1
    guardian.approve("req_1");
    // Same thread and resource, another tenant: not this scope.
    await ask("thread_1", "user_1", withTenant("tenant_b"));
    expect(guardian.claim).not.toHaveBeenCalled();
    expect(guardian.request).toHaveBeenCalledTimes(2);
    // Another thread, the same tenant: this scope.
    await ask("thread_2", "user_2", withTenant("tenant_a"));
    expect(guardian.claim).toHaveBeenCalledWith("req_1");
    expect(body).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["undefined", () => undefined],
    ["an empty string", () => ""],
    ["SCOPE_UNKNOWN", () => SCOPE_UNKNOWN],
    [
      "a throw",
      () => {
        throw new Error("no session");
      },
    ],
  ])(
    "a scope option that gives %s is an unknown session: a held call is never claimed",
    async (_name, scope) => {
      const { guardian, body, ask } = setup({ scope: scope as never });
      await ask("thread_a", "user_a");
      guardian.approve("req_1");
      await ask("thread_a", "user_a");
      expect(guardian.claim).not.toHaveBeenCalled();
      expect(guardian.request).toHaveBeenCalledTimes(2);
      expect(body).not.toHaveBeenCalled();
    },
  );
});
