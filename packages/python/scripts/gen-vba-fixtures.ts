/**
 * Golden cross-language fixtures for verify_before_acting.
 *
 *   npm run fixtures:python   (from the repo root)
 *
 * Writes tests/fixtures/verify-before-acting.json. Every receipt is
 * genuinely built and signed (ephemeral test key); every case records the
 * TypeScript verifyBeforeActing verdict, which the Python port must match.
 */
import { writeFileSync } from "node:fs";

import {
  approvalRecordDigest,
  createCanonicalAction,
  type ApprovalRecord,
  type CapabilityClaims,
  type EvidenceRecord,
} from "../../sdk/src/contracts/index.js";
import { appendEvidenceRecord } from "../../sdk/src/evidence/evidence.js";
import {
  buildPortableReceipt,
  capabilityClaimsDigest,
  createEphemeralReceiptSigner,
} from "../../sdk/src/evidence/receipt.js";
import { verifyBeforeActing } from "../../sdk/src/verify-before-acting.js";

const here = new URL(".", import.meta.url);
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
const signer = createEphemeralReceiptSigner();
const keys = { keys: [signer.verificationJwk] };
const foreignKeys = { keys: [createEphemeralReceiptSigner().verificationJwk] };

type Opts = {
  decision?: "ALLOW" | "ASK" | "DENY";
  approval?: "approved" | "pending" | "revoked";
  capability?: "issued" | "used" | "expired" | "revoked" | null;
  capabilityExpiresAtEpochMs?: number;
  valueCents?: number | null;
  issuedAtEpochMs?: number;
  expiresAtEpochMs?: number;
  parameters?: Record<string, unknown>;
};

function receipt(o: Opts = {}): Record<string, unknown> {
  const decision = o.decision ?? "ALLOW";
  const cap =
    o.capability === undefined
      ? decision === "ALLOW" ||
        (decision === "ASK" && o.approval === "approved")
        ? "issued"
        : null
      : o.capability;
  const made = createCanonicalAction({
    schemaVersion: 1,
    ...CONTEXT,
    action: "api.request",
    resource: "api:stripe:pcn_00000001",
    interface: "rest",
    uses: 1,
    materialParameters: o.parameters ?? PAYMENT,
    ...(o.valueCents === null ? {} : { valueCents: o.valueCents ?? 100 }),
    merchantId: "acme",
    purpose: "Pay the saved customer $1.00",
    initiatingContext: "agent",
    authority: {
      policy: { id: "pol_00000001", version: 1 },
      evaluatedGrants: GRANTS,
    },
    issuedAtEpochMs: NOW - 1_000,
    expiresAtEpochMs: o.expiresAtEpochMs ?? NOW + 120_000,
    nonce: `nce_${"a".repeat(24)}`,
    requestedAdapterId: "adp_00000006",
  });
  if (!made.ok) throw new Error("action");
  const digest = made.action.materialDigest;
  let approval: ApprovalRecord | null = null;
  if (o.approval) {
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
      state: o.approval,
      version: o.approval === "pending" ? 1 : 2,
      updatedAtEpochMs: NOW - 800,
      decidedByPrincipalId:
        o.approval === "pending" ? null : CONTEXT.principalId,
    } as ApprovalRecord;
  }
  let claims: CapabilityClaims | null = null;
  if (cap) {
    claims = {
      schemaVersion: 1,
      capabilityId: "cap_00000001",
      tenantId: CONTEXT.tenantId,
      principalId: CONTEXT.principalId,
      agentId: CONTEXT.agentId,
      requestId: CONTEXT.requestId,
      actionDigest: digest,
      actionNonce: made.action.nonce,
      audience: "adp_00000006",
      policy: { id: "pol_00000001", version: 1 },
      evaluatedGrants: GRANTS,
      issuedAtEpochMs: NOW - 700,
      expiresAtEpochMs: o.capabilityExpiresAtEpochMs ?? NOW + 60_000,
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
  if (claims && cap !== "issued") {
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
        state: cap,
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
    issuedAtEpochMs: o.issuedAtEpochMs ?? NOW - 500,
    chain,
    action: made.action,
    approval,
    capabilityClaims: claims,
    capabilityState: cap,
  });
  if (!built.ok) throw new Error(built.reasonCode);
  return signer.sign(built.body) as Record<string, unknown>;
}

type Expected = Record<string, unknown>;
type CaseOptions = {
  nowEpochMs: number;
  maxAgeMs?: number;
  seenRequestIds?: string[];
  /** The online status reply, or "throw" for a failed check. */
  status?:
    | { ok: true; status: string }
    | { ok: false; reasonCode: string }
    | "throw";
};
type Case = {
  name: string;
  receipt: unknown;
  keys: unknown;
  expected: Expected;
  options: CaseOptions;
};

const base: Expected = {
  action: "api.request",
  materialParameters: PAYMENT,
  valueCents: 100,
  merchantId: "acme",
  currency: "usd",
};
const json = (body: string) => ({
  ...PAYMENT,
  headers: [{ name: "content-type", value: "application/json" }],
  body,
});
const cases: Case[] = [];
const add = (
  name: string,
  r: unknown,
  patch: Expected = {},
  opts: Partial<CaseOptions> = {},
  k: unknown = keys,
) =>
  cases.push({
    name,
    receipt: r,
    keys: k,
    expected: { ...base, ...patch },
    options: { nowEpochMs: NOW, ...opts },
  });

add("valid ALLOW", receipt());
add(
  "ASK approved by a person",
  receipt({ decision: "ASK", approval: "approved" }),
);
add("ASK pending", receipt({ decision: "ASK", approval: "pending" }));
add("ASK with no approval", receipt({ decision: "ASK" }));
add("ASK approval revoked", receipt({ decision: "ASK", approval: "revoked" }));
add("DENY", receipt({ decision: "DENY" }));
add("no capability issued", receipt({ capability: null }));
add("capability revoked", receipt({ capability: "revoked" }));
add("capability expired (state)", receipt({ capability: "expired" }));
add("capability used", receipt({ capability: "used" }));
add("capability claims expired", receipt({ capabilityExpiresAtEpochMs: NOW }));
add("action window closed", receipt({ expiresAtEpochMs: NOW - 1 }));
add("stale receipt", receipt({ issuedAtEpochMs: NOW - 300_001 }));
add(
  "stale under a tighter max age",
  receipt({ issuedAtEpochMs: NOW - 10_000 }),
  {},
  { maxAgeMs: 5_000 },
);
add("future-dated receipt", receipt({ issuedAtEpochMs: NOW + 61_000 }));
add("tampered amount in the request", receipt(), {
  materialParameters: {
    ...PAYMENT,
    body: PAYMENT.body.replace("amount=100", "amount=100000"),
  },
  valueCents: 100000,
});
add("different URL", receipt(), {
  materialParameters: { ...PAYMENT, url: "https://api.stripe.com/v1/payouts" },
});
add("extra request field", receipt(), {
  materialParameters: { ...PAYMENT, extra: "field" },
});
add("receiver amount differs", receipt(), { valueCents: 101 });
// A bool is not an amount: TypeScript refuses true for 1 cent; Python must too.
add("receiver passes true as the amount", receipt({ valueCents: 1 }), {
  valueCents: true,
});
add("no amount authorized", receipt({ valueCents: null }));
add("destination differs", receipt(), { merchantId: "globex" });
add("currency differs", receipt(), { currency: "eur" });
add("action kind differs", receipt(), { action: "email.send" });
add(
  "no currency in the request",
  receipt({
    parameters: { ...PAYMENT, body: "amount=100&customer=cus_demo" },
  }),
  {
    materialParameters: { ...PAYMENT, body: "amount=100&customer=cus_demo" },
  },
);
{
  const p = json(
    '{"amount":100,"currency":"usd","metadata":{"currency":"eur"}}',
  );
  add(
    "JSON: nested currency of the same name is fine",
    receipt({ parameters: p }),
    { materialParameters: p },
  );
}
{
  const p = json('{"amount":100,"currency":"eur","currency":"usd"}');
  add(
    "JSON: currency repeated at the root is refused",
    receipt({ parameters: p }),
    { materialParameters: p },
  );
}
// amountField: the amount is read from the signed request body (api.request
// cannot declare money facts). No declared value needs a person's approval.
{
  const approved = { decision: "ASK" as const, approval: "approved" as const };
  add(
    "amountField: body amount matches, ASK approved",
    receipt({ valueCents: null, ...approved }),
    { amountField: "amount" },
  );
  add(
    "amountField: body amount differs from the receiver's",
    receipt({ valueCents: null, ...approved }),
    { amountField: "amount", valueCents: 101 },
  );
  const noAmount = { ...PAYMENT, body: "currency=usd&customer=cus_demo" };
  add(
    "amountField: amount missing from the body",
    receipt({ valueCents: null, ...approved, parameters: noAmount }),
    { amountField: "amount", materialParameters: noAmount },
  );
  const twice = { ...PAYMENT, body: "amount=100&amount=1&currency=usd" };
  add(
    "amountField: amount repeated in the body",
    receipt({ valueCents: null, ...approved, parameters: twice }),
    { amountField: "amount", materialParameters: twice },
  );
  add(
    "amountField: no declared value and ALLOW (no person approved)",
    receipt({ valueCents: null }),
    { amountField: "amount" },
  );
  add(
    "amountField: declared value disagrees with the body",
    receipt({ valueCents: 50, ...approved }),
    { amountField: "amount", valueCents: 100 },
  );
  add("amountField: declared value agrees with the body, ALLOW", receipt(), {
    amountField: "amount",
  });
  add(
    "amountField: no capability issued",
    receipt({ valueCents: null, ...approved, capability: null }),
    { amountField: "amount" },
  );
  for (const [label, body] of [
    ["JSON integer amount", '{"amount":100,"currency":"usd"}'],
    ["JSON string amount", '{"amount":"100","currency":"usd"}'],
    ["JSON amount 100.0", '{"amount":100.0,"currency":"usd"}'],
    ["JSON amount 1e2", '{"amount":1e2,"currency":"usd"}'],
    ["JSON fractional amount", '{"amount":100.5,"currency":"usd"}'],
    ["JSON negative amount", '{"amount":-100,"currency":"usd"}'],
    ["JSON boolean amount", '{"amount":true,"currency":"usd"}'],
    [
      "JSON amount beyond a safe integer",
      '{"amount":9007199254740993,"currency":"usd"}',
    ],
    [
      "JSON amount repeated at the root",
      '{"amount":1,"amount":100,"currency":"usd"}',
    ],
    ["JSON nested amount only", '{"metadata":{"amount":100},"currency":"usd"}'],
    ["JSON amount with leading zero", '{"amount":"0100","currency":"usd"}'],
    ["JSON amount padded with spaces", '{"amount":" 100 ","currency":"usd"}'],
    [
      "JSON amount with a unit separator",
      '{"amount":"\\u001c100","currency":"usd"}',
    ],
    [
      "JSON amount 17 digits",
      '{"amount":"10000000000000000","currency":"usd"}',
    ],
    [
      "JSON amount at the safe-integer limit",
      '{"amount":9007199254740991,"currency":"usd"}',
    ],
    [
      "JSON string amount beyond a safe integer",
      '{"amount":"9007199254740992","currency":"usd"}',
    ],
  ] as const) {
    const p = json(body);
    add(
      `amountField: ${label}`,
      receipt({ valueCents: null, ...approved, parameters: p }),
      { amountField: "amount", materialParameters: p, valueCents: undefined },
    );
  }
}
// The body is read only for a known JSON or form content type. The smuggled
// body reads 100 usd as a form, but 99999 eur to a JSON parser.
{
  const approved = { decision: "ASK" as const, approval: "approved" as const };
  const SMUGGLED =
    '{"x":"&amount=100&currency=usd&","amount":99999,"currency":"eur"}';
  const typed = (headers: unknown[], body: string) => ({
    ...PAYMENT,
    headers,
    body,
  });
  const ct = (value: string) => ({ name: "content-type", value });
  for (const [label, p] of [
    [
      "smuggled body, leading space",
      typed([ct(" application/json")], SMUGGLED),
    ],
    ["smuggled body, leading tab", typed([ct("\tapplication/json")], SMUGGLED)],
    [
      "smuggled body, merge-patch+json",
      typed([ct("application/merge-patch+json")], SMUGGLED),
    ],
    ["smuggled body, text/json", typed([ct("text/json")], SMUGGLED)],
    ["smuggled body, no content type", typed([], SMUGGLED)],
    ["form body, text/plain", typed([ct("text/plain")], PAYMENT.body)],
    [
      "JSON with a charset parameter",
      typed(
        [{ name: "Content-Type", value: "Application/JSON ; charset=utf-8" }],
        '{"amount":100,"currency":"usd"}',
      ),
    ],
    [
      "form with a charset parameter",
      typed(
        [ct("application/x-www-form-urlencoded; charset=utf-8")],
        PAYMENT.body,
      ),
    ],
    [
      "two content-type headers",
      typed(
        [
          ct("application/x-www-form-urlencoded"),
          { name: "Content-Type", value: "application/json" },
        ],
        PAYMENT.body,
      ),
    ],
    [
      "header value not a string",
      typed(
        [ct("application/x-www-form-urlencoded"), { name: "x-a", value: 1 }],
        PAYMENT.body,
      ),
    ],
    [
      "JSON NaN elsewhere in the body",
      json('{"amount":100,"currency":"usd","x":NaN}'),
    ],
    [
      "JSON Infinity elsewhere in the body",
      json('{"amount":100,"currency":"usd","x":Infinity}'),
    ],
    [
      "JSON -Infinity elsewhere in the body",
      json('{"amount":100,"currency":"usd","x":-Infinity}'),
    ],
    ["JSON NaN amount", json('{"amount":NaN,"currency":"usd"}')],
    [
      "JSON huge integer elsewhere in the body",
      json(`{"amount":100,"currency":"usd","x":${"9".repeat(5000)}}`),
    ],
    [
      "JSON nested 3000 deep elsewhere in the body",
      json(
        `{"amount":100,"currency":"usd","x":${"[".repeat(3000)}${"]".repeat(3000)}}`,
      ),
    ],
    [
      "JSON nested 3000 deep and malformed",
      json(
        `{"amount":100,"currency":"usd","x":${"[".repeat(3000)}${"]".repeat(2999)}}`,
      ),
    ],
    [
      "form body, charset utf-16be",
      typed(
        [ct("application/x-www-form-urlencoded; charset=utf-16be")],
        "amount=100&currency=usd&%00a%00m%00o%00u%00n%00t=%009%009%009",
      ),
    ],
    [
      "form body, charset latin1",
      typed(
        [ct("application/x-www-form-urlencoded; charset=latin1")],
        PAYMENT.body,
      ),
    ],
    [
      "form body, quoted UTF-8 charset",
      typed(
        [ct('application/x-www-form-urlencoded; charset="UTF-8"')],
        PAYMENT.body,
      ),
    ],
    [
      "form body, charset plus another parameter",
      typed(
        [ct("application/x-www-form-urlencoded; charset=utf-8; boundary=x")],
        PAYMENT.body,
      ),
    ],
    [
      "JSON, charset utf-16",
      typed(
        [ct("application/json; charset=utf-16")],
        '{"amount":100,"currency":"usd"}',
      ),
    ],
    [
      "form body, amount key with a leading space",
      { ...PAYMENT, body: "amount=100& amount=99999&currency=usd" },
    ],
    [
      "form body, amount key with a trailing +",
      { ...PAYMENT, body: "amount=100&amount+=99999&currency=usd" },
    ],
    ["form body with a leading ?", { ...PAYMENT, body: `?${PAYMENT.body}` }],
    ["form body with two leading ?", { ...PAYMENT, body: `??${PAYMENT.body}` }],
    [
      "form body split by ;",
      { ...PAYMENT, body: "amount=100;amount=1&currency=usd" },
    ],
  ] as const) {
    add(
      `content type: ${label}`,
      receipt({ valueCents: null, ...approved, parameters: p }),
      { amountField: "amount", materialParameters: p },
    );
  }
  // Currency trimming must follow JavaScript's trim(), not Python's strip().
  for (const [label, currency] of [
    ["unit separator suffix", "usd\u001f"],
    ["NEL prefix", "\u0085usd"],
    ["BOM prefix", "\ufeffusd"],
    ["no-break space suffix", "usd\u00a0"],
  ] as const) {
    const p = typed(
      [ct("application/json")],
      JSON.stringify({ amount: 100, currency }),
    );
    add(
      `currency trim: ${label}`,
      receipt({ valueCents: null, ...approved, parameters: p }),
      { amountField: "amount", materialParameters: p },
    );
  }
  // An inherited JavaScript name is not a field.
  const plain = typed(
    [ct("application/json")],
    '{"amount":100,"currency":"usd"}',
  );
  add(
    "inherited name: currencyField constructor",
    receipt({ valueCents: null, ...approved, parameters: plain }),
    {
      amountField: "amount",
      currencyField: "constructor",
      materialParameters: plain,
    },
  );
}
add(
  "already acted on (replay)",
  receipt(),
  {},
  { seenRequestIds: [CONTEXT.requestId] },
);
add(
  "online status active",
  receipt(),
  {},
  { status: { ok: true, status: "active" } },
);
add(
  "online status revoked",
  receipt(),
  {},
  { status: { ok: true, status: "revoked" } },
);
add(
  "online status failed",
  receipt(),
  {},
  { status: { ok: false, reasonCode: "SERVICE_UNAVAILABLE" } },
);
add("online status threw", receipt(), {}, { status: "throw" });
{
  const r = structuredClone(receipt()) as { action: { valueCents: number } };
  r.action.valueCents = 100000;
  add("edited receipt", r, { valueCents: 100000 });
}
add("foreign key set", receipt(), {}, {}, foreignKeys);
add("not a receipt", "nope");

const out = [];
for (const c of cases) {
  const status = c.options.status;
  const result = await verifyBeforeActing(
    c.receipt,
    c.keys,
    c.expected as never,
    {
      nowEpochMs: c.options.nowEpochMs,
      ...(c.options.maxAgeMs === undefined
        ? {}
        : { maxAgeMs: c.options.maxAgeMs }),
      ...(c.options.seenRequestIds
        ? { seenRequestIds: new Set(c.options.seenRequestIds) }
        : {}),
      ...(status === undefined
        ? {}
        : {
            status: async () => {
              if (status === "throw") throw new Error("down");
              return status as never;
            },
          }),
    },
  );
  out.push({ ...c, result });
}
writeFileSync(
  new URL("../tests/fixtures/verify-before-acting.json", here),
  JSON.stringify(out, null, 1) + "\n",
);
console.log(`verify-before-acting fixtures: ${out.length} cases`);
