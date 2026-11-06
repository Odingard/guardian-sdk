/**
 * steel-checkout.mjs — Guardian for Steel, agent side.
 *
 * The agent holds only a Guardian credential and a connection id: it can
 * PROPOSE `steel.checkout.submit`, never drive Steel itself. The order goes
 * to ASK; only after a human approves does the protected executor (on the
 * Guardian side, holding the Steel session + merchant credential) place it.
 *
 * SIMULATED with no env vars (local demo policy; no browser, no merchant).
 * Against hosted Guardian it needs a Steel tool connection whose executor
 * is deployed behind Guardian — see packages/steel/README.md for maturity.
 */
import { createGuardianSteelDispatcher, SteelCheckoutArgumentsSchema } from "@odingard/guardian-steel";
import { guardian } from "./demo-guardian.mjs";

const { client, connectionId, demo } = guardian();
const label = demo ? "SIMULATED" : "LIVE";
const steel = createGuardianSteelDispatcher({ guardian: client, connectionId });

const order = SteelCheckoutArgumentsSchema.parse({
  merchantId: "fixture-shop.guardian.test",
  sku: "WIDGET-1",
  quantity: 2,
  expectedTotalCents: 8400,
  currency: "USD",
  shipTo: { name: "Ada", line1: "1 Main St", city: "Austin", postalCode: "78701", country: "US" },
});

const first = await steel.submitOrder(order);
console.log(`[${label}] submitOrder →`, first.status, first.requestId ?? "");
if (first.status === "pending-approval") {
  console.log(`[${label}] human approves the exact order, then the agent resumes…`);
  const done = await steel.resume(first.requestId);
  console.log(`[${label}] resume →`, done.status, done.reasonCode ?? done.receiptStatus ?? "");
  if (done.status !== "executed") console.log(`[${label}] (no real Steel browser here — the dispatcher only reports executed for a sent-verified receipt)`);
}
