/**
 * invoice-agent.mjs — an accounts-payable agent pays supplier invoices, with
 * Guardian deciding before any money moves.
 *
 *   $480 to a known supplier             → ALLOW: your payment code runs, receipt recorded
 *   $12,400 to a known supplier          → ASK:   held until a human approves, then paid
 *   $9,000 to a payee nobody approved    → DENY:  your payment code never runs
 *
 * The payment itself is YOUR code (`payInvoice` below). Guardian does not
 * move money or hold card or bank credentials. It decides whether your code
 * may run, and records the evidence. That is `createGuard` from
 * @odingard/guardian-sdk (in-process mode).
 *
 * Run:  node invoice-agent.mjs
 *
 * Labels are honest:
 *   [SIMULATED guardian]   local demo policy (demo-guardian.mjs), not Guardian
 *   [LIVE guardian]        GUARDIAN_BASE_URL / GUARDIAN_AGENT_CREDENTIAL /
 *                          GUARDIAN_CONNECTION_ID set: real hosted Guardian.
 *                          Register pay_invoice as a record-only tool on that
 *                          connection and allow it for the agent first.
 *                          Hosted Guardian decides per tool (Allow or Ask);
 *                          the $5k threshold and payee rule are demo-policy
 *                          only, so live results follow your tool setting.
 *                          Your console policy decides, and ASK waits for a
 *                          real human.
 *   [SIMULATED payment]    no payment provider is called
 *   [STRIPE TEST MODE]     STRIPE_SECRET_KEY=sk_test_… set: a real Stripe
 *                          test-mode PaymentIntent is created. Live keys
 *                          (sk_live_…) are refused.
 */
import {
  createGuard,
  GuardianApprovalPending,
  GuardianDenied,
} from "@odingard/guardian-sdk";

import { guardian } from "./demo-guardian.mjs";

const { client, connectionId, demo } = guardian();
const G = demo ? "[SIMULATED guardian]" : "[LIVE guardian]";

const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
if (stripeKey.startsWith("sk_live_") || stripeKey.startsWith("rk_live_")) {
  console.error("Refusing a live Stripe key. This example only runs in Stripe test mode (sk_test_…).");
  process.exit(2);
}
const P = stripeKey.startsWith("sk_test_") ? "[STRIPE TEST MODE]" : "[SIMULATED payment]";

/** Your payment code. Guardian only lets it run after ALLOW, or after a human approves an ASK. */
async function payInvoice(invoice) {
  if (P === "[SIMULATED payment]") {
    return { paymentId: `sim_${invoice.invoiceId}`, status: "succeeded", simulated: true };
  }
  const body = new URLSearchParams({
    amount: String(invoice.amountCents),
    currency: invoice.currency.toLowerCase(),
    payment_method: "pm_card_visa", // Stripe's test card
    confirm: "true",
    "automatic_payment_methods[enabled]": "true",
    "automatic_payment_methods[allow_redirects]": "never",
    description: `Invoice ${invoice.invoiceId} → ${invoice.payeeId}`,
    "metadata[invoice_id]": invoice.invoiceId,
  });
  const response = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      authorization: `Bearer ${stripeKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `guardian-example-${invoice.invoiceId}`,
    },
    body,
  });
  const intent = await response.json();
  if (!response.ok) throw new Error(`Stripe: ${intent.error?.message ?? response.status}`);
  return { paymentId: intent.id, status: intent.status };
}

const guard = createGuard({
  client,
  connectionId,
  // LIVE: register pay_invoice once in the console as "My own code
  // (record-only)" and allow it for the agent.
  agentName: "ap-agent",
  purpose: (_tool, inv) =>
    `Pay invoice ${inv.invoiceId}: ${(inv.amountCents / 100).toFixed(2)} ${inv.currency} to ${inv.payeeId}`,
});
const governedPayInvoice = guard("pay_invoice", payInvoice);

async function waitForHuman(pending) {
  if (demo) {
    console.log(`  ${G} human approves the exact invoice (simulated)…`);
    return pending.resume();
  }
  console.log(`  ${G} approve request ${pending.requestId} in the Guardian console (polling for 5 min)…`);
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    try {
      return await pending.resume();
    } catch (err) {
      if (!(err instanceof GuardianApprovalPending)) throw err;
    }
  }
  throw new Error("approval timed out; nothing was paid");
}

async function run(invoice) {
  console.log(
    `\n→ pay ${invoice.invoiceId}: $${(invoice.amountCents / 100).toLocaleString()} to ${invoice.payeeId}`,
  );
  try {
    const paid = await governedPayInvoice(invoice);
    console.log(`  ${G} ALLOW → ${P} ${paid.paymentId} (${paid.status}); receipt recorded`);
  } catch (err) {
    if (err instanceof GuardianApprovalPending) {
      console.log(`  ${G} ASK → held, nothing paid yet (requestId ${err.requestId})`);
      try {
        const { output } = await waitForHuman(err);
        console.log(`  ${G} approved → ${P} ${output.paymentId} (${output.status}); receipt recorded`);
      } catch (inner) {
        console.log(`  not paid: ${inner instanceof GuardianDenied ? inner.reasonCode : inner.message}`);
      }
    } else if (err instanceof GuardianDenied) {
      console.log(`  ${G} DENY (${err.reasonCode}) → your payment code never ran`);
    } else {
      throw err;
    }
  }
}

await run({ invoiceId: "INV-1001", payeeId: "acme-supplies", amountCents: 48_000, currency: "USD" });
await run({ invoiceId: "INV-1002", payeeId: "acme-supplies", amountCents: 1_240_000, currency: "USD" });
await run({ invoiceId: "INV-1003", payeeId: "acme-supplies-new-bank", amountCents: 900_000, currency: "USD" });
