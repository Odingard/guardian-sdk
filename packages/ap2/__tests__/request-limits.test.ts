// Open mandates with item constraints, as the AP2 reference roles send them,
// must fit the Guardian request limits (nesting at most 8 levels) without
// hiding what the person approves, and the exact constraint stays bound.
import { createHash } from "node:crypto";

import {
  createGuardianClient,
  type GuardianInvocation,
} from "@odingard/guardian-sdk";
import { describe, expect, it } from "vitest";

import { requestLimitBreach } from "../src/decision.js";
import {
  Ap2GuardRefused,
  type OpenCheckoutContent,
  type OpenPaymentContent,
} from "../src/index.js";
import { jcs } from "../src/util.js";
import {
  CONNECTION,
  fakeGuardian,
  issueSdJwt,
  makeGuard,
  MERCHANT,
  NOW_SEC,
  openMandates,
  payInput,
  world,
  type FakeGuardianOptions,
  type World,
} from "./helpers.js";

async function refusal(p: Promise<unknown>): Promise<Ap2GuardRefused> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Ap2GuardRefused);
    return e as Ap2GuardRefused;
  }
  throw new Error("expected a refusal");
}

const digestOf = (v: unknown) =>
  `sha256:${createHash("sha256").update(jcs(v), "utf8").digest("hex")}`;

/** Deepest nesting of a JSON value, the way the SDK counts it (the root is 0). */
function depthOf(v: unknown, d = 0): number {
  if (v === null || typeof v !== "object") return d;
  const children = Array.isArray(v) ? v : Object.values(v);
  return children.reduce<number>((m, c) => Math.max(m, depthOf(c, d + 1)), d);
}

/**
 * The fake Guardian, but every request first goes through the real SDK
 * client (its own checks, then a stand-in transport that records the body).
 */
function sdkCheckedGuardian(opts: FakeGuardianOptions = {}) {
  const fake = fakeGuardian(opts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodies: any[] = [];
  const real = createGuardianClient({
    baseUrl: "https://guardian.example.test",
    credential: "gak_test_only",
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({ ok: false, reasonCode: "TEST_TRANSPORT" }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  const fakeRequest = fake.request.bind(fake);
  fake.request = async (inv: GuardianInvocation) => {
    await real.request(inv);
    return fakeRequest(inv);
  };
  return Object.assign(fake, { bodies });
}

/** An open checkout mandate shaped like the AP2 reference shopping flow's. */
const referenceItems = [
  {
    id: "line_1",
    acceptable_items: [
      { id: "sku_mug", title: "Coffee mug" },
      { id: "sku_mug_blue", title: "Coffee mug, blue" },
    ],
    quantity: 2,
  },
  { id: "line_2", acceptable_items: [], quantity: 1 },
];
const referenceConstraints = [
  { type: "checkout.line_items", items: referenceItems },
  { type: "checkout.allowed_merchants", allowed: [MERCHANT] },
];

describe("item constraints fit the Guardian request limits", () => {
  it("a reference-shaped open mandate (items 9 levels deep) gives a request the SDK accepts, with every item shown and the constraint bound by digest", async () => {
    const w = world();
    const guardian = sdkCheckedGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    const input = payInput(w, {
      open: { checkoutConstraints: referenceConstraints },
    });

    // Before: the copied constraint put acceptable_items[0] 9 levels deep.
    expect(
      depthOf({
        arguments: {
          openMandates: { checkout: { constraints: referenceConstraints } },
        },
      }),
    ).toBeGreaterThan(8);

    const p = await guard.pay(input);
    expect(p.approvedByPerson).toBe(true);
    expect(w.signed).toHaveLength(2);

    expect(guardian.bodies).toHaveLength(1);
    const material = guardian.bodies[0].materialParameters;
    expect(material.toolName).toBe("ap2.pay.above_cap");
    expect(depthOf(material)).toBeLessThanOrEqual(8);
    expect(requestLimitBreach(material.arguments)).toBeNull();

    const view = material.arguments.openMandates.checkout.constraints;
    expect(view).toEqual([
      {
        type: "checkout.line_items",
        constraintDigest: digestOf(referenceConstraints[0]),
        acceptableItems: [
          {
            requirementId: "line_1",
            quantity: 2,
            itemId: "sku_mug",
            title: "Coffee mug",
          },
          {
            requirementId: "line_1",
            quantity: 2,
            itemId: "sku_mug_blue",
            title: "Coffee mug, blue",
          },
          { requirementId: "line_2", quantity: 1, anyItem: true },
        ],
      },
      { type: "checkout.allowed_merchants", allowed: [MERCHANT] },
    ]);
    // The merchant, amount, currency and the cart's items and quantities are shown too.
    expect(material.arguments).toMatchObject({
      merchant: MERCHANT,
      amount: 1999,
      currency: "USD",
      checkout: {
        lineItems: [{ itemId: "sku_mug", title: "Coffee mug", quantity: 1 }],
      },
    });
    // The digest is part of the approved terms, and so of termsDigest.
    expect(p.terms.openMandates?.checkout.constraints).toEqual(view);
  });

  it("delegation with item constraints gives a request the SDK accepts", async () => {
    const w = world();
    const guardian = sdkCheckedGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    const openCheckout = {
      vct: "mandate.checkout.open.1",
      constraints: referenceConstraints,
      iat: NOW_SEC,
      exp: NOW_SEC + 3600,
    };
    const openPayment = {
      vct: "mandate.payment.open.1",
      constraints: [
        { type: "payment.amount_range", currency: "USD", min: 0, max: 2500 },
      ],
      iat: NOW_SEC,
      exp: NOW_SEC + 3600,
    };
    await guard.delegate({
      openCheckout,
      openPayment,
      trustedSurface: {
        signOpenCheckout: async (c: OpenCheckoutContent) =>
          issueSdJwt(w.ts.privateKey, c as never),
        signOpenPayment: async (c: OpenPaymentContent) =>
          issueSdJwt(w.ts.privateKey, c as never),
      },
    });
    const material = guardian.bodies[0].materialParameters;
    expect(depthOf(material)).toBeLessThanOrEqual(8);
    expect(material.arguments.openCheckout.constraints[0]).toMatchObject({
      type: "checkout.line_items",
      constraintDigest: digestOf(referenceConstraints[0]),
    });
    expect(
      material.arguments.openCheckout.constraints[0].acceptableItems,
    ).toHaveLength(3);
  });
});

describe("the item constraint a person approved is the one signed under", () => {
  function swapAfterApproval(
    w: World,
    input: ReturnType<typeof payInput>,
    items: unknown[],
  ) {
    let swapped = false;
    return () => {
      if (swapped) return;
      swapped = true;
      input.openCheckoutMandate = openMandates(w, {
        checkoutConstraints: [
          { type: "checkout.line_items", items },
          { type: "checkout.allowed_merchants", allowed: [MERCHANT] },
        ],
      }).openCheckout;
    };
  }

  it("a changed item constraint after approval is refused before signing", async () => {
    const w = world();
    const input = payInput(w, {
      open: { checkoutConstraints: referenceConstraints },
    });
    const changed = [{ ...referenceItems[0], quantity: 20 }, referenceItems[1]];
    const guardian = fakeGuardian({
      decide: () => "ASK",
      onClaim: swapAfterApproval(w, input, changed),
    });
    const { guard } = makeGuard(w, { guardian });
    const err = await refusal(guard.pay(input));
    expect(err.code).toBe("TERMS_CHANGED");
    expect(err.message).toContain("item constraints changed");
    expect(w.signed).toHaveLength(0);
  });

  it("the same item constraint in another open mandate is refused too", async () => {
    const w = world();
    const input = payInput(w, {
      open: { checkoutConstraints: referenceConstraints },
    });
    const guardian = fakeGuardian({
      decide: () => "ASK",
      onClaim: swapAfterApproval(w, input, referenceItems),
    });
    const { guard } = makeGuard(w, { guardian });
    const err = await refusal(guard.pay(input));
    expect(err.code).toBe("TERMS_CHANGED");
    expect(w.signed).toHaveLength(0);
  });
});

describe("limits fail closed with a clear code", () => {
  it("more acceptable items than the guard shows is refused before Guardian is asked", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    const many = Array.from({ length: 65 }, (_, i) => ({
      id: `sku_${i}`,
      title: `Item ${i}`,
    }));
    many[0] = { id: "sku_mug", title: "Coffee mug" };
    const input = payInput(w, {
      open: {
        checkoutConstraints: [
          {
            type: "checkout.line_items",
            items: [{ id: "r1", acceptable_items: many, quantity: 1 }],
          },
        ],
      },
    });
    const err = await refusal(guard.pay(input));
    expect(err.code).toBe("TOO_MANY_ITEMS");
    expect(guardian.calls).toHaveLength(0);
    expect(w.signed).toHaveLength(0);

    // 64 in all is shown.
    const ok = payInput(w, {
      open: {
        checkoutConstraints: [
          {
            type: "checkout.line_items",
            items: [
              { id: "r1", acceptable_items: many.slice(0, 64), quantity: 1 },
            ],
          },
        ],
      },
    });
    const g2 = sdkCheckedGuardian({ decide: () => "ASK" });
    await makeGuard(w, { guardian: g2 }).guard.pay(ok);
    expect(
      g2.bodies[0].materialParameters.arguments.openMandates.checkout
        .constraints[0].acceptableItems,
    ).toHaveLength(64);
  });

  it("a request outside the limits is refused locally as REQUEST_INVALID with the reason, not as unreachable", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    const deep = { a: { b: { c: { d: { e: { f: "x" } } } } } };
    const input = payInput(w, {
      checkout: { extra: { messages: [{ type: "info", detail: deep }] } },
    });
    const err = await refusal(guard.pay(input));
    expect(err.code).toBe("REQUEST_INVALID");
    expect(err.message).toContain("arguments.checkout.messages[0].detail");
    expect(err.message).toContain("nested deeper than 8 levels");
    expect(err.message).not.toContain('"x"');
    expect(guardian.calls).toHaveLength(0);
    expect(w.signed).toHaveLength(0);
  });

  it("argument size is counted as the SDK counts it: non-Latin titles within 16,384 characters are sent", async () => {
    const w = world();
    const guardian = sdkCheckedGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    // About 7,000 characters of CJK text: under 16,384 characters, over 16,384 UTF-8 bytes.
    const cjk = "咖啡杯".repeat(1_000);
    const items = [
      {
        id: "line_1",
        acceptable_items: [{ id: "sku_mug", title: cjk }],
        quantity: 2,
      },
      {
        id: "line_2",
        acceptable_items: [{ id: "sku_cup", title: cjk.slice(0, 1_500) }],
        quantity: 1,
      },
    ];
    const input = payInput(w, {
      open: { checkoutConstraints: [{ type: "checkout.line_items", items }] },
    });
    await guard.pay(input);
    const args = guardian.bodies[0].materialParameters.arguments;
    const text = jcs(args);
    expect(text.length).toBeLessThanOrEqual(16_384);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(16_384);
    expect(requestLimitBreach(args)).toBeNull();
    expect(w.signed).toHaveLength(2);
  });

  it("an SDK validation error is reported as REQUEST_INVALID with the SDK's reason", async () => {
    const w = world();
    const guardian = sdkCheckedGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    // Guardian takes a purpose of at most 1024 characters; this merchant name makes it longer.
    const input = payInput(w, {
      checkout: { merchant: { ...MERCHANT, name: "M".repeat(1100) } },
    });
    const err = await refusal(guard.pay(input));
    expect(err.code).toBe("REQUEST_INVALID");
    expect(err.message).toContain("purpose");
    expect(err.message).toContain("nothing was sent");
    expect(guardian.bodies).toHaveLength(0);
    expect(w.signed).toHaveLength(0);
  });

  it("a network failure is still GUARDIAN_UNREACHABLE", async () => {
    const w = world();
    const { guard } = makeGuard(w, {
      guardian: createGuardianClient({
        baseUrl: "https://guardian.example.test",
        credential: "gak_test_only",
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      }),
      connectionId: CONNECTION,
    });
    const err = await refusal(guard.pay(payInput(w)));
    expect(err.code).toBe("GUARDIAN_UNREACHABLE");
    expect(w.signed).toHaveLength(0);
  });
});
