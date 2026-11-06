/**
 * shopping-agent.mjs — a shopping agent whose purchase goes to ASK.
 *
 *   search_products  → ALLOW (harmless, executes immediately)
 *   checkout_cart    → ASK   (spends money — a human must approve)
 *
 * Run:  node shopping-agent.mjs        (local demo policy, zero setup)
 * With env vars set it runs the identical flow against hosted Guardian —
 * the ASK then holds until a human approves in the console.
 */
import { guardian } from "./demo-guardian.mjs";

const { client, connectionId } = guardian();

async function propose(toolName, args) {
  const result = await client.request({
    action: "tool.invoke",
    connectionId,
    toolName,
    arguments: args,
    purpose: `shopping-agent: ${toolName}`,
  });
  console.log(`\n→ propose ${toolName}(${JSON.stringify(args)})`);
  if (!result.ok) {
    console.log(`  request rejected: ${result.reasonCode}`);
    return;
  }
  console.log(`  decision: ${result.decision}`);

  if (result.decision === "DENY") {
    console.log(`  refused before execution (${result.reasonCode ?? "DENY"})`);
    return;
  }

  let capabilityToken = result.capabilityToken;
  if (result.decision === "ASK") {
    console.log("  held for human approval…");
    // Against hosted Guardian this is where you notify the human; the demo
    // policy simulates their approval on the claim below.
    const granted = await client.claim(result.requestId);
    if (!granted.ok || !granted.capabilityToken) {
      console.log(`  not approved: ${granted.reasonCode ?? "pending"}`);
      return;
    }
    console.log("  human approved — capability issued");
    capabilityToken = granted.capabilityToken;
  }

  const execution = await client.execute({
    requestId: result.requestId,
    capabilityToken,
  });
  console.log(
    execution.ok
      ? `  executed — receipt ${execution.receipt.requestId}`
      : `  execution failed: ${execution.reasonCode}`,
  );
}

await propose("search_products", { query: "espresso machine" });
await propose("checkout_cart", { cartId: "cart_42", totalCents: 18900 });
