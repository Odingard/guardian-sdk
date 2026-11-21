/**
 * batteries.mjs: a scripted shopper asks Agentcard's opencommerce buy tool
 * for "two packs of AA batteries from Amazon", and the checkout goes through
 * Guardian (@odingard/guardian-opencommerce) before it reaches Agentcard.
 *
 * Run (from examples/):
 *   AGENTCARD_CLIENT_ID=... AGENTCARD_CLIENT_SECRET=...   (sandbox: npx agent-cards credentials --mode sandbox)
 *   GUARDIAN_AGENT_CREDENTIAL=gak_... GUARDIAN_CONNECTION_ID=pcn_... GUARDIAN_BASE_URL=https://...
 *   node payments/opencommerce/batteries.mjs
 *
 * It refuses production Agentcard credentials unless ALLOW_LIVE_PURCHASE=1.
 * In the sandbox no order is placed and nothing is charged: an allowed
 * checkout ends `declined` with `decline_code: sandbox_mode`.
 * No model is in the loop; the script sends what a model would send.
 */
import { AgentcardClient, buyTool } from "@agent-cards/commerce-sdk";
import { createGuardianClient } from "@odingard/guardian-sdk";
import {
  GuardianPurchaseBlocked,
  guardBuyTool,
} from "@odingard/guardian-opencommerce";

const env = process.env;
const missing = [
  "AGENTCARD_CLIENT_ID",
  "AGENTCARD_CLIENT_SECRET",
  "GUARDIAN_AGENT_CREDENTIAL",
  "GUARDIAN_CONNECTION_ID",
  "GUARDIAN_BASE_URL",
].filter((name) => !env[name]);
if (missing.length > 0) {
  console.error(
    `Set ${missing.join(", ")} (see the comment at the top of this file).`,
  );
  process.exit(1);
}

const agentcard = new AgentcardClient({
  clientId: env.AGENTCARD_CLIENT_ID,
  clientSecret: env.AGENTCARD_CLIENT_SECRET,
  baseUrl: env.AGENTCARD_BASE_URL,
});
try {
  await agentcard.bearer(); // the token exchange says whether these are sandbox credentials
} catch (error) {
  console.error(
    `Agentcard refused the credentials or could not be reached: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
if (agentcard.sandbox !== true && env.ALLOW_LIVE_PURCHASE !== "1") {
  console.error(
    "These Agentcard credentials are not sandbox credentials, so a confirm could buy for real. " +
      "Use sandbox credentials (npx agent-cards credentials --mode sandbox), or set ALLOW_LIVE_PURCHASE=1.",
  );
  process.exit(1);
}
console.log(
  `Agentcard mode: ${agentcard.sandbox === true ? "sandbox" : "LIVE"}`,
);

const buy = guardBuyTool(
  buyTool({
    agentcard,
    externalUserId:
      env.SHOPPER_ID ?? `guardian-example-${Date.now().toString(36)}`,
    // A test address; the model never sets it.
    deliveryAddress: {
      name: "Test Shopper",
      street: "1 Market St",
      city: "San Francisco",
      state: "CA",
      zip: "94105",
      // A reserved fictional number; Amazon requires a phone on the address.
      phone: "+14155550100",
      country: "US",
    },
    // Agentcard's own links (Vault, approval) still go to the shopper as before.
    sendLink: (link) =>
      console.log(`  ${link.kind} link for the shopper: ${link.url}`),
  }),
  {
    client: createGuardianClient({
      baseUrl: env.GUARDIAN_BASE_URL,
      credential: env.GUARDIAN_AGENT_CREDENTIAL,
    }),
    connectionId: env.GUARDIAN_CONNECTION_ID,
    onDecision: (e) =>
      console.log(
        `  Guardian: ${e.decision}${e.requestId ? ` (${e.requestId})` : ""}${e.reasonCode ? ` ${e.reasonCode}` : ""}` +
          ` for $${(e.checkout.amountMinor / 100).toFixed(2)} at ${e.checkout.stores.join(", ")}` +
          (e.decision === "ASK"
            ? ": approve or decline it in the Guardian console or on your device"
            : ""),
      ),
  },
);

const say = async (ask, extra = {}) => {
  console.log(`shopper> ${ask}`);
  const result = await buy.answer({
    ask,
    confirm: false,
    new_order: false,
    product_id: null,
    store_id: null,
    ...extra,
  });
  console.log(
    `agentcard> [${result.status}${result.next_action ? `, next: ${result.next_action}` : ""}] ${result.reply.split("\n")[0]}`,
  );
  return result;
};

try {
  let result = await say("two packs of AA batteries from Amazon", {
    new_order: true,
  });
  for (let i = 0; i < 6 && result.next_action !== "confirm"; i += 1) {
    if (result.products.length > 0 && !result.cart) {
      result = await say("that one, two packs", {
        product_id: result.products[0].id,
      });
    } else if (
      result.next_action === "add_card" ||
      result.next_action === "store_login"
    ) {
      console.log(
        "Open the link above, finish that step, then run the script again.",
      );
      process.exit(0);
    } else {
      result = await say("yes, ship it to my address");
    }
  }
  if (result.next_action !== "confirm") {
    console.log("No cart was ready to confirm; nothing went to Guardian.");
    process.exit(0);
  }
  for (const cart of result.carts) {
    console.log(
      `cart at ${cart.merchant_name}: ${cart.items.map((l) => `${l.qty} x ${l.name}`).join(", ")}, $${(cart.totalCents / 100).toFixed(2)}`,
    );
  }
  // The yes: this is the step that commits money, so Guardian decides it before Agentcard sees it.
  result = await say("yes, place it", { confirm: true });
  // A store that prices tax at the confirm answers with a new total. That is a
  // new cart, so Guardian decides it again.
  if (result.next_action === "confirm")
    result = await say("yes, place it", { confirm: true });
  console.log(
    `done: ${result.status}${result.decline_code ? ` (${result.decline_code})` : ""}`,
  );
} catch (error) {
  if (error instanceof GuardianPurchaseBlocked) {
    console.log(`${error.message} Nothing was sent to Agentcard.`);
  } else {
    console.error(
      `failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
