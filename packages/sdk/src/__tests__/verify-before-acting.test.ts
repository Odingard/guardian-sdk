import { describe, expect, it } from "vitest";

import {
  approvalRecordDigest,
  createCanonicalAction,
  type ApprovalRecord,
  type CapabilityClaims,
  type EvidenceRecord,
} from "../contracts/index.js";
import { appendEvidenceRecord } from "../evidence/evidence.js";
import {
  buildPortableReceipt,
  capabilityClaimsDigest,
  createEphemeralReceiptSigner,
} from "../evidence/receipt.js";

import {
  fetchReceiptStatus,
  verifyBeforeActing,
  type ExpectedAction,
} from "../verify-before-acting.js";

/**
 * The receiver's side of "verify, don't trust".
 * Every receipt here is genuinely built and signed; refusals come from the
 * checks, not from malformed fixtures.
 */
const NOW = 1_800_000_000_000;
const CONTEXT = {
  tenantId: "ten_00000001",
  principalId: "pri_00000001",
  agentId: "agt_00000001",
  requestId: "req_00000001",
  correlationId: "cor_00000001",
} as const;
const GRANTS = [{ id: "grt_00000001", version: 2 }];
const PAYMENT = {
  schema: "odingard.guardian.api.request.v1",
  connectionId: "pcn_00000001",
  method: "POST",
  url: "https://api.stripe.com/v1/payment_intents",
  headers: [
    { name: "content-type", value: "application/x-www-form-urlencoded" },
  ],
  body: "amount=100&currency=usd&customer=cus_demo&confirm=true",
};

type Options = Readonly<{
  decision?: "ALLOW" | "ASK" | "DENY";
  approval?: "approved" | "pending" | "revoked";
  /** Default "issued"; null = no capability issued. */
  capability?: "issued" | "used" | "expired" | "revoked" | null;
  capabilityExpiresAtEpochMs?: number;
  parameters?: Record<string, unknown>;
  valueCents?: number;
  merchantId?: string;
  issuedAtEpochMs?: number;
  expiresAtEpochMs?: number;
}>;

function signedReceipt(options: Options = {}) {
  const decision = options.decision ?? "ALLOW";
  const capabilityState =
    options.capability === undefined
      ? decision === "ALLOW" ||
        (decision === "ASK" && options.approval === "approved")
        ? "issued"
        : null
      : options.capability;
  const made = createCanonicalAction({
    schemaVersion: 1,
    ...CONTEXT,
    action: "api.request",
    resource: "api:stripe:pcn_00000001",
    interface: "rest",
    uses: 1,
    materialParameters: options.parameters ?? PAYMENT,
    ...(options.valueCents === undefined
      ? { valueCents: 100 }
      : options.valueCents < 0
        ? {}
        : { valueCents: options.valueCents }),
    merchantId: options.merchantId ?? "acme",
    purpose: "Pay the saved customer $1.00",
    initiatingContext: "agent",
    authority: {
      policy: { id: "pol_00000001", version: 1 },
      evaluatedGrants: GRANTS,
    },
    issuedAtEpochMs: NOW - 1_000,
    expiresAtEpochMs: options.expiresAtEpochMs ?? NOW + 120_000,
    nonce: `nce_${"a".repeat(24)}`,
    requestedAdapterId: "adp_00000006",
  });
  if (!made.ok) throw new Error(`action fixture: ${JSON.stringify(made)}`);
  const action = made.action;
  const digest = action.materialDigest;

  let approval: ApprovalRecord | null = null;
  if (options.approval) {
    approval = {
      schemaVersion: 1,
      binding: {
        schemaVersion: 1,
        approvalId: "apr_00000001",
        ...CONTEXT,
        actionDigest: digest,
        actionDecisionRecordDigest: "b".repeat(64),
        askDecisionDigest: "c".repeat(64),
        adapterId: "adp_00000006",
        policy: { id: "pol_00000001", version: 1 },
        evaluatedGrants: GRANTS,
        presentationDigest: "e".repeat(64),
        requestedAtEpochMs: NOW - 1_000,
        expiresAtEpochMs: NOW + 120_000,
      },
      state: options.approval,
      version: options.approval === "pending" ? 1 : 2,
      updatedAtEpochMs: NOW - 800,
      decidedByPrincipalId:
        options.approval === "pending" ? null : CONTEXT.principalId,
    } as ApprovalRecord;
  }
  let claims: CapabilityClaims | null = null;
  if (capabilityState) {
    claims = {
      schemaVersion: 1,
      capabilityId: "cap_00000001",
      tenantId: CONTEXT.tenantId,
      principalId: CONTEXT.principalId,
      agentId: CONTEXT.agentId,
      requestId: CONTEXT.requestId,
      actionDigest: digest,
      actionNonce: action.nonce,
      audience: "adp_00000006",
      policy: { id: "pol_00000001", version: 1 },
      evaluatedGrants: GRANTS,
      issuedAtEpochMs: NOW - 700,
      expiresAtEpochMs: options.capabilityExpiresAtEpochMs ?? NOW + 60_000,
      maxUses: 1,
      keyId: "key_00000001",
      algorithm: "HS256",
    } as CapabilityClaims;
  }

  const events: unknown[] = [
    { eventType: "REQUEST_RECEIVED", payload: { actionDigest: digest } },
    { eventType: "ACTION_NORMALIZED", payload: { actionDigest: digest } },
    {
      eventType: "DECISION_RECORDED",
      payload: {
        actionDigest: digest,
        actionDecisionDigest: "d".repeat(64),
        decision,
        reasonCode:
          decision === "ALLOW"
            ? "AUTHORIZED"
            : decision === "ASK"
              ? "APPROVAL_REQUIRED"
              : "ACTION_NOT_ALLOWED",
      },
    },
  ];
  if (approval && approval.version === 2) {
    // The real lifecycle: pending (v1), the person's decision (v2), state (v2).
    const pending = {
      ...approval,
      state: "pending",
      version: 1,
      decidedByPrincipalId: null,
      updatedAtEpochMs: NOW - 900,
    } as ApprovalRecord;
    events.push(
      {
        eventType: "APPROVAL_STATE_REFERENCED",
        payload: {
          approvalId: "apr_00000001",
          version: 1,
          state: "pending",
          approvalDigest: approvalRecordDigest(pending),
        },
      },
      {
        eventType: "APPROVAL_DECISION_RECORDED",
        payload: {
          approvalId: "apr_00000001",
          version: 2,
          decision: approval.state === "approved" ? "approve" : "revoke",
          actorPrincipalId: CONTEXT.principalId,
          actorReference: "att_00000001",
          presentationDigest: "e".repeat(64),
        },
      },
    );
  }
  if (approval) {
    events.push({
      eventType: "APPROVAL_STATE_REFERENCED",
      payload: {
        approvalId: "apr_00000001",
        version: approval.version,
        state: approval.state,
        approvalDigest: approvalRecordDigest(approval),
      },
    });
  }
  if (claims && capabilityState !== "issued") {
    events.push({
      eventType: "CAPABILITY_STATE_REFERENCED",
      payload: {
        actionDigest: digest,
        capabilityId: "cap_00000001",
        state: "issued",
        capabilityDigest: capabilityClaimsDigest(claims),
      },
    });
  }
  if (claims) {
    events.push({
      eventType: "CAPABILITY_STATE_REFERENCED",
      payload: {
        actionDigest: digest,
        capabilityId: "cap_00000001",
        state: capabilityState,
        capabilityDigest: capabilityClaimsDigest(claims),
      },
    });
  }
  let chain: EvidenceRecord[] = [];
  events.forEach((event, index) => {
    const next = appendEvidenceRecord(chain, {
      schemaVersion: 1,
      id: `evd_${String(index + 1).padStart(8, "0")}`,
      ...CONTEXT,
      eventTimeEpochMs: NOW - 1_000 + index,
      event: event as EvidenceRecord["event"],
    });
    if (!next.ok) throw new Error(next.reasonCode);
    chain = next.chain;
  });
  const built = buildPortableReceipt({
    receiptId: `rcp_${"1".repeat(32)}`,
    issuedAtEpochMs: options.issuedAtEpochMs ?? NOW - 500,
    chain,
    action,
    approval,
    capabilityClaims: claims,
    capabilityState,
  });
  if (!built.ok) throw new Error(built.reasonCode);
  const signer = createEphemeralReceiptSigner();
  return {
    receipt: signer.sign(built.body) as Record<string, unknown>,
    keys: { keys: [signer.verificationJwk] },
  };
}

const expected = (patch: Partial<ExpectedAction> = {}): ExpectedAction => ({
  action: "api.request",
  materialParameters: PAYMENT,
  valueCents: 100,
  merchantId: "acme",
  currency: "usd",
  ...patch,
});

const check = (
  options: Options,
  patch: Partial<ExpectedAction> = {},
  extra: Parameters<typeof verifyBeforeActing>[3] = {},
) => {
  const { receipt, keys } = signedReceipt(options);
  return verifyBeforeActing(receipt, keys, expected(patch), {
    nowEpochMs: NOW,
    ...extra,
  });
};

describe("verifyBeforeActing: the exact approved action is accepted", () => {
  it("accepts an ALLOW for exactly this request, amount, destination and currency", async () => {
    expect(await check({})).toEqual({
      ok: true,
      requestId: CONTEXT.requestId,
      receiptId: `rcp_${"1".repeat(32)}`,
      materialDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      decision: "ALLOW",
      approvedByHuman: false,
      valueCents: 100,
      merchantId: "acme",
      currency: "usd",
    });
  });

  it("accepts an ASK only once a person approved it", async () => {
    expect(
      await check({ decision: "ASK", approval: "approved" }),
    ).toMatchObject({ ok: true, decision: "ASK", approvedByHuman: true });
    for (const options of [
      { decision: "ASK" as const },
      { decision: "ASK" as const, approval: "pending" as const },
    ]) {
      expect(await check(options)).toMatchObject({
        ok: false,
        reasonCode: "NOT_APPROVED",
      });
    }
  });
});

describe("verifyBeforeActing: what the receiver gets must be what was approved", () => {
  it("refuses a tampered amount in the request (the Elev case)", async () => {
    const tampered = {
      ...PAYMENT,
      body: PAYMENT.body.replace("amount=100", "amount=100000"),
    };
    expect(
      await check({}, { materialParameters: tampered, valueCents: 100000 }),
    ).toMatchObject({ ok: false, reasonCode: "REQUEST_MISMATCH" });
  });

  it("refuses a different destination URL, method or header", async () => {
    for (const changed of [
      { ...PAYMENT, url: "https://api.stripe.com/v1/payouts" },
      { ...PAYMENT, method: "PUT" },
      { ...PAYMENT, headers: [] },
      { ...PAYMENT, extra: "field" },
    ]) {
      expect(
        await check({}, { materialParameters: changed }),
        JSON.stringify(changed),
      ).toMatchObject({ ok: false, reasonCode: "REQUEST_MISMATCH" });
    }
  });

  it("refuses when the receiver's own amount, destination or currency differ", async () => {
    expect(await check({}, { valueCents: 101 })).toMatchObject({
      reasonCode: "AMOUNT_MISMATCH",
    });
    expect(await check({ valueCents: -1 })).toMatchObject({
      reasonCode: "AMOUNT_NOT_AUTHORIZED",
    });
    expect(await check({}, { merchantId: "globex" })).toMatchObject({
      reasonCode: "DESTINATION_MISMATCH",
    });
    expect(await check({}, { currency: "eur" })).toMatchObject({
      reasonCode: "CURRENCY_MISMATCH",
    });
    expect(await check({}, { action: "email.send" })).toMatchObject({
      reasonCode: "ACTION_MISMATCH",
    });
  });

  it("a valid receipt for a different request is refused (digest mismatch)", async () => {
    const other = {
      ...PAYMENT,
      body: "amount=100&currency=usd&customer=cus_x",
    };
    expect(await check({}, { materialParameters: other })).toMatchObject({
      reasonCode: "REQUEST_MISMATCH",
    });
  });
});

describe("verifyBeforeActing: only a genuine, live, unused authorization", () => {
  it("refuses an edited or foreign-signed receipt", async () => {
    const { receipt, keys } = signedReceipt();
    const edited = structuredClone(receipt) as {
      action: { valueCents: number };
    };
    edited.action.valueCents = 100000;
    expect(
      await verifyBeforeActing(edited, keys, expected({ valueCents: 100000 }), {
        nowEpochMs: NOW,
      }),
    ).toMatchObject({ ok: false, reasonCode: "RECEIPT_INVALID" });
    const foreign = signedReceipt().keys;
    expect(
      await verifyBeforeActing(receipt, foreign, expected(), {
        nowEpochMs: NOW,
      }),
    ).toMatchObject({ ok: false, reasonCode: "RECEIPT_INVALID" });
  });

  it("refuses DENY, revoked, expired and already used", async () => {
    expect(await check({ decision: "DENY" })).toMatchObject({
      reasonCode: "NOT_AUTHORIZED",
    });
    expect(await check({ decision: "ASK", approval: "revoked" })).toMatchObject(
      { reasonCode: "NOT_APPROVED" },
    );
    expect(await check({ capability: "revoked" })).toMatchObject({
      reasonCode: "REVOKED",
    });
    expect(await check({ capability: "expired" })).toMatchObject({
      reasonCode: "EXPIRED",
    });
    expect(await check({ capability: "used" })).toMatchObject({
      reasonCode: "ALREADY_USED",
    });
    expect(await check({ expiresAtEpochMs: NOW - 1 + 0 })).toMatchObject({
      reasonCode: "EXPIRED",
    });
  });

  it("refuses a receipt with no issued capability, or whose capability expired", async () => {
    expect(await check({ capability: null })).toMatchObject({
      reasonCode: "NOT_ISSUED",
    });
    expect(
      await check({ decision: "ASK", approval: "approved", capability: null }),
    ).toMatchObject({ reasonCode: "NOT_ISSUED" });
    // The action window is still open, but the capability's own expiry passed.
    expect(await check({ capabilityExpiresAtEpochMs: NOW })).toMatchObject({
      reasonCode: "EXPIRED",
    });
  });

  it("refuses a stale or future-dated receipt", async () => {
    expect(await check({ issuedAtEpochMs: NOW - 300_001 })).toMatchObject({
      reasonCode: "STALE",
    });
    expect(
      await check({ issuedAtEpochMs: NOW - 10_000 }, {}, { maxAgeMs: 5_000 }),
    ).toMatchObject({ reasonCode: "STALE" });
    expect(await check({ issuedAtEpochMs: NOW + 61_000 })).toMatchObject({
      reasonCode: "NOT_YET_VALID",
    });
  });

  it("moves money once: a request already acted on is refused", async () => {
    const seen = new Set([CONTEXT.requestId]);
    expect(await check({}, {}, { seenRequestIds: seen })).toMatchObject({
      reasonCode: "REPLAYED",
    });
  });

  it("with an online status check, only 'active' passes and a failed check refuses", async () => {
    const status = (value: string) => async () =>
      ({ ok: true, status: value }) as never;
    expect(await check({}, {}, { status: status("active") })).toMatchObject({
      ok: true,
    });
    for (const value of [
      "pending",
      "revoked",
      "expired",
      "used",
      "paused",
      "unknown",
    ]) {
      expect(await check({}, {}, { status: status(value) })).toMatchObject({
        reasonCode: "STATUS_NOT_ACTIVE",
      });
    }
    expect(
      await check(
        {},
        {},
        {
          status: async () => {
            throw new Error("down");
          },
        },
      ),
    ).toMatchObject({ reasonCode: "STATUS_UNAVAILABLE" });
  });
});

describe("verifyBeforeActing: currency in a JSON body", () => {
  const json = (body: string) => ({
    ...PAYMENT,
    headers: [{ name: "content-type", value: "application/json" }],
    body,
  });

  it("reads the root currency; a nested currency of the same name is fine", async () => {
    const parameters = json(
      '{"amount":100,"currency":"usd","metadata":{"currency":"eur"}}',
    );
    expect(
      await check({ parameters }, { materialParameters: parameters }),
    ).toMatchObject({ ok: true, currency: "usd" });
  });

  it("refuses a currency repeated in the root object as ambiguous", async () => {
    const parameters = json('{"amount":100,"currency":"eur","currency":"usd"}');
    expect(
      await check({ parameters }, { materialParameters: parameters }),
    ).toMatchObject({ ok: false, reasonCode: "CURRENCY_MISMATCH" });
  });
});

describe("fetchReceiptStatus", () => {
  it("posts the receipt and accepts only a known status", async () => {
    const posted: unknown[] = [];
    const reply = (body: unknown, status = 200) =>
      fetchReceiptStatus(
        "https://guardian.test/",
        { receiptId: "rcp_x" },
        {
          fetch: async (url, init) => {
            posted.push([url, JSON.parse(String(init?.body))]);
            return new Response(JSON.stringify(body), { status });
          },
        },
      );
    expect(await reply({ ok: true, status: "revoked" })).toEqual({
      ok: true,
      status: "revoked",
    });
    expect(posted[0]).toEqual([
      "https://guardian.test/v1/receipts/status",
      { receipt: { receiptId: "rcp_x" } },
    ]);
    expect(await reply({ ok: true, status: "fine" })).toMatchObject({
      ok: false,
    });
    expect(
      await reply({ ok: false, reasonCode: "RECEIPT_INVALID" }, 400),
    ).toEqual({ ok: false, reasonCode: "RECEIPT_INVALID" });
  });
});
