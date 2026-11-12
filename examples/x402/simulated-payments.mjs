/**
 * simulated-payments.mjs — SIMULATED. Guardian decides x402 payments before
 * the wallet signs.
 *
 * Everything here is local and fake on purpose:
 *   - Guardian is an in-memory stand-in (no signing, no real receipts).
 *   - The paid API is an in-memory 402 server (no network).
 *   - The wallet is a throwaway Base Sepolia test key made on each run.
 * No request leaves this process and no money moves.
 *
 * The x402 client, its fetch wrapper, the exact EVM scheme and the guard
 * are the real packages.
 *
 * Run (from the repo root):  npm run build && node examples/x402/simulated-payments.mjs
 */
import { createX402Guard } from "@odingard/guardian-x402";
import { guardedFetch } from "@odingard/guardian-x402/fetch";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const SEPOLIA = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SHOP = "0x1111111111111111111111111111111111111111";
const UNKNOWN = "0x9999999999999999999999999999999999999999";

// --- Stand-in Guardian ------------------------------------------------------
// x402.pay: a rule allows it, except for one recipient it denies.
// x402.pay.above_cap: held for a person; the "person" approves on the
// second claim. A real Guardian holds the ASK until someone approves in the
// console.
function standInGuardian() {
  const held = new Map();
  let n = 0;
  return {
    async request(inv) {
      n += 1;
      const requestId = `req_simulated${String(n).padStart(6, "0")}`;
      if (inv.toolName === "x402.pay" && inv.arguments.payTo === UNKNOWN) {
        return { ok: false, reasonCode: "POLICY_DENIED", requestId };
      }
      if (inv.toolName === "x402.pay") {
        held.set(requestId, { inv, decision: "ALLOW", token: `cap_${requestId}` });
        return { ok: true, requestId, decision: "ALLOW", capabilityToken: `cap_${requestId}` };
      }
      held.set(requestId, { inv, decision: "ASK", claims: 0 });
      console.log(`  Guardian: held for a person (${inv.arguments.amountDisplay} to ${inv.arguments.payTo})`);
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
      return {
        ok: true,
        receipt: { schemaVersion: 1, requestId, receiptReference: `att_${requestId.slice(4)}`, status: "sent-verified" },
      };
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
            materialParameters: {
              connectionId: h.inv.connectionId,
              toolName: h.inv.toolName,
              arguments: h.inv.arguments,
            },
          },
          decision: { decision: h.decision },
          // Guardian marks an approval "consumed" once execute redeems it.
          approval: h.decision === "ASK" ? { state: "consumed" } : null,
        },
      };
    },
    async receipts() {
      return { ok: false, reasonCode: "SIMULATED" };
    },
  };
}

// --- In-memory 402 server ---------------------------------------------------
const PRICES = {
  "/weather": { amount: "10000", payTo: SHOP }, // 0.01 USDC
  "/report": { amount: "250000", payTo: SHOP }, // 0.25 USDC: above askAbove
  "/scam": { amount: "10000", payTo: UNKNOWN },
};
async function paidApi(input, init) {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (req.headers.get("PAYMENT-SIGNATURE")) {
    const settle = { success: true, transaction: `0x${"0".repeat(64)}`, network: SEPOLIA };
    return new Response(`paid content for ${url.pathname}`, {
      status: 200,
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle) },
    });
  }
  const price = PRICES[url.pathname];
  const terms = {
    x402Version: 2,
    resource: { url: req.url },
    accepts: [
      {
        scheme: "exact",
        network: SEPOLIA,
        asset: USDC,
        amount: price.amount,
        payTo: price.payTo,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
  return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(terms) } });
}

// --- The agent --------------------------------------------------------------
const wallet = privateKeyToAccount(generatePrivateKey()); // throwaway test key
const memory = new Map();
let version = 0;
const guard = createX402Guard({
  guardian: standInGuardian(),
  connectionId: "pcn_simulated0000000000000000",
  signer: wallet,
  // A store keeps live authorizations across restarts. This one is in
  // memory, for the demo only; use a durable one in production.
  store: {
    async get(key) {
      return memory.get(key) ?? null;
    },
    async compareAndSet(key, expected, value) {
      if ((memory.get(key)?.version ?? null) !== expected) return false;
      memory.set(key, { value, version: String(++version) });
      return true;
    },
  },
  limits: [{ network: SEPOLIA, asset: USDC, askAbove: "100000", max: "500000" }],
  claimPollIntervalMs: 10,
});
const pay = guardedFetch(guard, paidApi);

for (const path of ["/weather", "/report", "/scam"]) {
  console.log(`\nGET https://api.example.test${path}`);
  try {
    const res = await pay(`https://api.example.test${path}`);
    console.log(`  ${res.status}: ${await res.text()}`);
  } catch (error) {
    console.log(`  not paid: ${error.message}`);
  }
}

console.log("\nLocal records (no keys, no signatures):");
for (const r of guard.records()) {
  console.log(
    `  ${r.event.padEnd(10)} ${r.tool ?? ""} ${r.requestId ?? ""} ${r.code ?? ""}${
      r.guardianReasonCode ? `:${r.guardianReasonCode}` : ""
    } ${r.nonce ? `nonce ${r.nonce.slice(0, 10)}…` : ""}`.trimEnd(),
  );
}
console.log("\nSIMULATED: stand-in Guardian, in-memory server, throwaway test key. Nothing was sent.");
