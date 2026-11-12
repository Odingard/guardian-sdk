/**
 * simulated-payments.mjs — SIMULATED. Guardian decides AP2 v0.2 mandates
 * before the agent key signs them.
 *
 * Everything here is local and fake on purpose:
 *   - Guardian is an in-memory stand-in (no real receipts).
 *   - The Trusted Surface, the merchant and the payment processor are
 *     stand-ins with throwaway P-256 keys made on each run.
 * No request leaves this process and no money moves.
 *
 * The guard is the real package.
 *
 * Run (from the repo root):  npm run build && node examples/ap2/simulated-payments.mjs
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import { createAp2Guard, nodeKeySigner } from "@odingard/guardian-ap2";

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const sha = (s) => createHash("sha256").update(s).digest("base64url");
function newKey() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { x, y } = createPublicKey(privateKey).export({ format: "jwk" });
  return { privateKey, publicJwk: { kty: "EC", crv: "P-256", x, y } };
}
function jws(key, payload) {
  const input = `${b64({ alg: "ES256" })}.${b64(payload)}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
function sdJwt(key, item) {
  const d = b64([randomBytes(16).toString("base64url"), item]);
  return `${jws(key, { delegate_payload: [{ "...": sha(d) }], _sd_alg: "sha-256" })}~${d}~`;
}

const agent = newKey();
const trustedSurface = newKey();
const merchantKey = newKey();
const processorKey = newKey();
const MERCHANT = { id: "merchant_1", name: "Example Store", website: "https://store.example.test" };

// --- Stand-in Guardian ------------------------------------------------------
// ap2.pay: a rule allows it unless the merchant is on a deny list.
// ap2.pay.above_cap and ap2.delegate: held for a person, who approves on the
// second claim. A real Guardian holds the ASK until someone approves.
function standInGuardian() {
  const held = new Map();
  let n = 0;
  return {
    async request(inv) {
      n += 1;
      const requestId = `req_simulated${String(n).padStart(6, "0")}`;
      if (inv.toolName === "ap2.pay" && inv.arguments.checkout.lineItems.some((l) => l.itemId === "sku_scam")) {
        return { ok: false, reasonCode: "POLICY_DENIED", requestId };
      }
      if (inv.toolName === "ap2.pay") {
        held.set(requestId, { inv, decision: "ALLOW", token: `cap_${requestId}` });
        return { ok: true, requestId, decision: "ALLOW", capabilityToken: `cap_${requestId}` };
      }
      held.set(requestId, { inv, decision: "ASK", claims: 0 });
      const what = inv.arguments.amountDisplay ?? `up to ${inv.arguments.amountMaxDisplay} per payment`;
      console.log(`  Guardian: ${inv.toolName} held for a person (${what})`);
      return { ok: true, requestId, decision: "ASK" };
    },
    async claim(requestId) {
      const h = held.get(requestId);
      h.claims += 1;
      if (h.claims < 2) return { ok: false, reasonCode: "APPROVAL_PENDING", requestId };
      console.log("  person: approved");
      h.token = `cap_${requestId}`;
      return { ok: true, requestId, decision: "ALLOW", capabilityToken: h.token };
    },
    async execute({ requestId, capabilityToken }) {
      const h = held.get(requestId);
      if (!h || h.token !== capabilityToken || h.used) return { ok: false, reasonCode: "CAPABILITY_INVALID" };
      h.used = true;
      return { ok: true, receipt: { schemaVersion: 1, requestId, receiptReference: `att_${requestId}`, status: "sent-verified" } };
    },
    async portableReceipt(requestId) {
      const h = held.get(requestId);
      return {
        ok: true,
        receipt: {
          subject: { requestId },
          action: {
            requestId,
            action: "tool.invoke",
            materialParameters: { connectionId: h.inv.connectionId, toolName: h.inv.toolName, arguments: h.inv.arguments },
          },
          decision: { decision: h.decision },
          approval: h.decision === "ASK" ? { state: h.used ? "consumed" : "approved" } : null,
        },
      };
    },
  };
}

// --- A durable-store stand-in (in memory here) --------------------------------
const data = new Map();
let version = 0;
const store = {
  async get(key) {
    return data.get(key) ?? null;
  },
  async compareAndSet(key, expected, value) {
    if ((data.get(key)?.version ?? null) !== expected) return false;
    data.set(key, { value, version: String(++version) });
    return true;
  },
};

const guard = createAp2Guard({
  guardian: standInGuardian(),
  connectionId: "pcn_simulated",
  agentSigner: nodeKeySigner(agent.privateKey),
  trustedSurfaceKeys: [trustedSurface.publicJwk],
  merchantKeys: { [MERCHANT.id]: [merchantKey.publicJwk] },
  receiptIssuerKeys: { payment: { "https://processor.example.test": [processorKey.publicJwk] } },
  limits: [{ currency: "USD", askAbove: 2500, max: 20000 }],
  store,
  claimPollIntervalMs: 10,
});

function checkout(id, items) {
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  return jws(merchantKey.privateKey, {
    id,
    merchant: MERCHANT,
    line_items: items.map((i, n) => ({ id: `li_${n}`, item: { id: i.id, title: i.title, price: i.price }, quantity: i.quantity, totals: [] })),
    status: "ready_for_complete",
    currency: "USD",
    totals: [{ type: "total", amount: total }],
    links: [],
  });
}

// Delegation: the user lets the agent buy from one store, up to 40.00 USD a
// payment, at most 5 payments and 100.00 USD in all. Guardian decides (a
// person, always) before the Trusted Surface is asked to sign.
console.log("delegate: open mandates for the agent key");
const exp = Math.floor(Date.now() / 1000) + 3600;
const open = await guard.delegate({
  openCheckout: {
    vct: "mandate.checkout.open.1",
    constraints: [
      { type: "checkout.allowed_merchants", allowed: [MERCHANT] },
      { type: "checkout.line_items", items: [{ id: "r1", acceptable_items: [], quantity: 2 }] },
    ],
    exp,
  },
  openPayment: {
    vct: "mandate.payment.open.1",
    constraints: [
      { type: "payment.amount_range", currency: "USD", max: 4000 },
      { type: "payment.budget", currency: "USD", max: 100 },
      { type: "payment.agent_recurrence", frequency: "ON_DEMAND", max_occurrences: 5 },
    ],
    exp,
  },
  trustedSurface: {
    signOpenCheckout: async (content) => sdJwt(trustedSurface.privateKey, content),
    signOpenPayment: async (content) => sdJwt(trustedSurface.privateKey, content),
  },
});
console.log("  Trusted Surface signed both open mandates\n");

async function buy(label, items) {
  console.log(`pay: ${label}`);
  try {
    const signed = await guard.pay({
      openCheckoutMandate: open.openCheckoutMandate,
      openPaymentMandate: open.openPaymentMandate,
      checkoutJwt: checkout(`chk_${label}`, items),
      paymentInstrument: { id: "pi_card_1", type: "card", description: "Card ending 4242" },
      merchantChallenge: { aud: MERCHANT.id, nonce: randomBytes(16).toString("hex") },
      credentialProviderChallenge: { aud: "credential-provider", nonce: randomBytes(16).toString("hex") },
    });
    console.log(`  signed: ${signed.terms.amountDisplay} to ${signed.terms.merchant.name}`);
    await signed.presentPayment(async () => "payment-token");
    await signed.presentCheckout(async () => "order");
    const r = jws(processorKey.privateKey, {
      iss: "https://processor.example.test",
      iat: Math.floor(Date.now() / 1000),
      status: "Success",
      reference: signed.paymentReference,
      payment_id: "pay_1",
      psp_confirmation_id: "psp_1",
      network_confirmation_id: "net_1",
    });
    const receipt = await guard.recordReceipt(r);
    console.log(`  receipt: ${receipt.kind} ${receipt.status}\n`);
  } catch (e) {
    console.log(`  not signed: ${e.message}\n`);
  }
}

await buy("mug", [{ id: "sku_mug", title: "Coffee mug", price: 1999, quantity: 1 }]);
await buy("two-mugs", [{ id: "sku_mug", title: "Coffee mug", price: 1500, quantity: 2 }]);
await buy("scam", [{ id: "sku_scam", title: "Gift card", price: 500, quantity: 1 }]);
