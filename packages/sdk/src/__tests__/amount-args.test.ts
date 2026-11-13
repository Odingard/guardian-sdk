import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ToolAmountDeclarationSchema,
  readToolAmount,
  type ToolAmountDeclaration,
} from "../contracts-entry.js";
import {
  createGuard,
  createGuardianClient,
  createGuardianContext,
  GuardianApprovalPending,
  GuardianDenied,
  type GuardianClient,
  type GuardianInvocation,
  type GuardianRequestResult,
} from "../index.js";

/**
 * `amountArgs`: the SDK echoes the owner's amount declaration on every call
 * of a declared tool, with the amount it reads from the named argument, and
 * a refusal on a declared tool is explained in plain words.
 */

const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";

const cents: ToolAmountDeclaration = {
  argument: "amount",
  unit: "minor",
  currency: "usd",
};
const dollars: ToolAmountDeclaration = {
  argument: "amount",
  unit: "major",
  currency: "usd",
};

const allow: GuardianRequestResult = {
  ok: true,
  requestId: "req_allow",
  decision: "ALLOW",
  capabilityToken: "cap",
};

function recordingClient(
  invoke: GuardianRequestResult,
  claim?: GuardianRequestResult,
) {
  const invocations: GuardianInvocation[] = [];
  const calls: string[] = [];
  const client: GuardianClient = {
    async request(invocation) {
      invocations.push(invocation);
      calls.push(`request:${invocation.action}`);
      return invoke;
    },
    async claim(requestId) {
      calls.push(`claim:${requestId}`);
      return claim ?? { ok: false, reasonCode: "APPROVAL_PENDING" };
    },
    async execute({ requestId }) {
      calls.push(`execute:${requestId}`);
      return {
        ok: true,
        receipt: { requestId, status: "sent-verified" } as never,
      };
    },
    async portableReceipt() {
      return { ok: false, reasonCode: "UNUSED" };
    },
    async receipts() {
      return { ok: false, reasonCode: "UNUSED" };
    },
  } as GuardianClient;
  return { client, invocations, calls };
}

describe("readToolAmount (public contracts)", () => {
  it("reads cents and dollars in the accepted forms", () => {
    const read = (d: ToolAmountDeclaration, amount: unknown) =>
      readToolAmount(d, { amount });
    expect(read(cents, 2000)).toEqual({
      kind: "money",
      amountMinor: 2000,
      currency: "usd",
    });
    expect(read(cents, "2000")).toMatchObject({ amountMinor: 2000 });
    expect(read(cents, 0)).toMatchObject({ amountMinor: 0 });
    expect(read(dollars, 20)).toMatchObject({ amountMinor: 2000 });
    expect(read(dollars, "20")).toMatchObject({ amountMinor: 2000 });
    expect(read(dollars, "20.00")).toMatchObject({ amountMinor: 2000 });
    expect(read(dollars, "20.5")).toMatchObject({ amountMinor: 2050 });
    expect(read(dollars, "19.99")).toMatchObject({ amountMinor: 1999 });
  });

  it("refuses every amount it cannot read exactly", () => {
    for (const amount of [
      undefined,
      null,
      true,
      [],
      {},
      -1,
      1.5,
      "-1",
      "020",
      " 20",
    ]) {
      expect(readToolAmount(cents, { amount }).kind).toBe("refused");
    }
    for (const amount of [
      19.99,
      "$20",
      "1,000",
      " 20",
      "20.001",
      "1e3",
      "-1",
      "020",
    ]) {
      expect(readToolAmount(dollars, { amount }).kind).toBe("refused");
    }
  });

  it("checks a declared currency argument and an allowed-arguments list", () => {
    const withCurrency = { ...cents, currencyArgument: "currency" };
    expect(
      readToolAmount(withCurrency, { amount: 100, currency: "usd" }).kind,
    ).toBe("money");
    for (const currency of ["USD", "Usd"]) {
      expect(readToolAmount(withCurrency, { amount: 100, currency })).toEqual({
        kind: "money",
        amountMinor: 100,
        currency: "usd",
      });
    }
    expect(readToolAmount(withCurrency, { amount: 100 })).toEqual({
      kind: "refused",
      code: "CURRENCY_MISSING",
    });
    expect(
      readToolAmount(withCurrency, { amount: 100, currency: "eur" }),
    ).toEqual({
      kind: "refused",
      code: "CURRENCY_NOT_ALLOWED",
    });
    const listed = { ...cents, allowedArguments: ["amount", "sku"] };
    expect(readToolAmount(listed, { amount: 100, sku: "a" }).kind).toBe(
      "money",
    );
    expect(readToolAmount(listed, { amount: 100, tip: 5 })).toEqual({
      kind: "refused",
      code: "AMOUNT_ARGUMENT_NOT_ALLOWED",
    });
  });

  it("the declaration schema refuses nested names, other currencies and unknown fields", () => {
    for (const declaration of [
      { ...cents, argument: "order.amount" },
      { ...cents, currency: "eur" },
      { ...cents, extra: true },
      { ...cents, allowedArguments: ["sku"] },
    ]) {
      expect(ToolAmountDeclarationSchema.safeParse(declaration).success).toBe(
        false,
      );
    }
  });
});

describe("amountArgs", () => {
  it("sends the declaration and the amount it reads", async () => {
    const { client, invocations, calls } = recordingClient(allow);
    const guard = createGuard({
      client,
      connectionId: CONNECTION,
      amountArgs: { purchase: dollars },
    });
    const purchase = guard("purchase", (input: { amount: string }) => input);
    await expect(purchase({ amount: "19.99" })).resolves.toEqual({
      amount: "19.99",
    });
    expect(invocations[0]).toMatchObject({
      action: "tool.invoke",
      toolName: "purchase",
      arguments: { amount: "19.99" },
      amountArgument: dollars,
      valueCents: 1_999,
    });
    expect(calls).toEqual(["request:tool.invoke", "execute:req_allow"]);
  });

  it("an unreadable amount sends no valueCents, the tool does not run, and the error says why", async () => {
    const { client, invocations, calls } = recordingClient({
      ok: false,
      reasonCode: "ACTION_PARAMETERS_INVALID",
    });
    let ran = 0;
    const purchase = createGuard({
      client,
      connectionId: CONNECTION,
      amountArgs: { purchase: dollars },
    })("purchase", () => {
      ran += 1;
    });
    const error = await purchase({ amount: 19.99 }).catch((e: unknown) => e);
    expect(invocations[0]).toMatchObject({ amountArgument: dollars });
    expect(invocations[0]).not.toHaveProperty("valueCents");
    expect(error).toBeInstanceOf(GuardianDenied);
    expect((error as GuardianDenied).reasonCode).toBe(
      "ACTION_PARAMETERS_INVALID",
    );
    expect((error as GuardianDenied).hint).toContain(
      'the amount in its "amount" argument could not be read (AMOUNT_INVALID)',
    );
    expect(ran).toBe(0);
    expect(calls).not.toContain("execute:req_allow");
  });

  it("a declaration that is not the owner's gives a plain error that names it", async () => {
    const { client } = recordingClient({
      ok: false,
      reasonCode: "INVALID_REQUEST",
    });
    let ran = 0;
    const result = (await createGuard({
      client,
      connectionId: CONNECTION,
      amountArgs: { purchase: dollars },
      onDeny: "result",
    })("purchase", () => {
      ran += 1;
    })({ amount: "20" })) as {
      guardian: { decision: string; message: string };
    };
    expect(result.guardian.decision).toBe("DENY");
    expect(result.guardian.message).toContain(
      '{"argument":"amount","currency":"usd","unit":"major"}',
    );
    expect(result.guardian.message).toContain(
      "the declaration the owner set on this tool in the Guardian console",
    );
    expect(ran).toBe(0);
  });

  it("an ASK that is approved runs once with the approved amount", async () => {
    const { client, invocations, calls } = recordingClient(
      { ok: true, requestId: "req_ask", decision: "ASK" },
      {
        ok: true,
        requestId: "req_ask",
        decision: "ALLOW",
        capabilityToken: "cap",
      },
    );
    const seen: unknown[] = [];
    const guard = createGuard({
      client,
      connectionId: CONNECTION,
      amountArgs: { purchase: cents },
    });
    const purchase = guard("purchase", (input: { amount: number }) => {
      seen.push(input);
      return "bought";
    });
    const held = await purchase({ amount: 40_000 }).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(GuardianApprovalPending);
    expect((held as GuardianApprovalPending<unknown>).requestId).toBe(
      "req_ask",
    );
    expect(invocations[0]).toMatchObject({
      amountArgument: cents,
      valueCents: 40_000,
    });
    expect(seen).toEqual([]);
    await expect(
      (held as GuardianApprovalPending<unknown>).resume(),
    ).resolves.toMatchObject({
      requestId: "req_ask",
      output: "bought",
    });
    expect(seen).toEqual([{ amount: 40_000 }]);
    expect(calls).toEqual([
      "request:tool.invoke",
      "claim:req_ask",
      "execute:req_ask",
    ]);
  });

  it("with fileArgs and allowedArguments the pins pass and the amount is read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "amount-pins-"));
    try {
      const path = join(dir, "invoice.pdf");
      await writeFile(path, "invoice 42");
      const listed = {
        ...dollars,
        allowedArguments: ["amount", "attachmentPath"],
      };
      const { client, invocations } = recordingClient(allow);
      const seen: unknown[] = [];
      const pay = createGuard({
        client,
        connectionId: CONNECTION,
        amountArgs: { pay: listed },
        fileArgs: { pay: { attachmentPath: "recheck" } },
      })("pay", (input: Record<string, unknown>) => {
        seen.push(input);
        return "paid";
      });
      await expect(
        pay({ amount: "19.99", attachmentPath: path }),
      ).resolves.toBe("paid");
      expect(invocations[0]).toMatchObject({
        amountArgument: listed,
        valueCents: 1_999,
        arguments: {
          amount: "19.99",
          attachmentPath: path,
          guardianContentPins: [
            expect.objectContaining({ arg: "attachmentPath", index: 0 }),
          ],
        },
      });
      expect(seen).toEqual([{ amount: "19.99", attachmentPath: path }]);
      // An argument the owner did not list: no amount is read.
      await pay({ amount: "19.99", attachmentPath: path, tip: "5" }).catch(
        () => undefined,
      );
      expect(invocations[1]).toMatchObject({ amountArgument: listed });
      expect(invocations[1]).not.toHaveProperty("valueCents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a tool without a declaration is unchanged", async () => {
    const { client, invocations } = recordingClient(allow);
    await createGuard({
      client,
      connectionId: CONNECTION,
      amountArgs: { purchase: dollars },
    })(
      "browse",
      (input: unknown) => input,
    )({ amount: "20" });
    expect(invocations[0]).not.toHaveProperty("amountArgument");
    expect(invocations[0]).not.toHaveProperty("valueCents");
  });

  it("an invalid declaration is a configuration error at wrap time", () => {
    for (const declaration of [
      { ...dollars, currency: "eur" },
      { ...dollars, argument: "order.amount" },
      { ...dollars, extra: true },
      null,
    ]) {
      expect(() =>
        createGuardianContext({
          client: recordingClient(allow).client,
          connectionId: CONNECTION,
          amountArgs: { purchase: declaration as never },
        }),
      ).toThrow(TypeError);
    }
  });

  it("the client puts amountArgument in the material parameters and sends valueCents", async () => {
    const proposals: Record<string, unknown>[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (new URL(url).pathname === "/v1/agent/requests") proposals.push(body);
      return new Response(
        JSON.stringify({ ok: false, reasonCode: "NOT_AUTHORIZED" }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      );
    };
    const client = createGuardianClient({
      baseUrl: "https://g.test",
      credential: "gac1.test",
      fetch: fetch as never,
    });
    await client.request({
      action: "tool.invoke",
      connectionId: CONNECTION,
      toolName: "purchase",
      arguments: { amount: "400" },
      amountArgument: dollars,
      valueCents: 40_000,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      action: "tool.invoke",
      valueCents: 40_000,
      materialParameters: {
        schema: "odingard.guardian.tool.invoke.v1",
        connectionId: CONNECTION,
        toolName: "purchase",
        arguments: { amount: "400" },
        amountArgument: dollars,
      },
    });
  });
});
