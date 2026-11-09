/**
 * An OpenAI Agents SDK agent governed by Guardian.
 *
 * LIVE: needs a real OpenAI API key and a real Guardian agent. Nothing here
 * is simulated: every tool call the agent makes goes to Guardian before the
 * tool runs. Reading an order runs; a refund waits for a person to approve
 * it; every allowed call leaves a receipt.
 *
 *   export OPENAI_API_KEY=...                  (your OpenAI key)
 *   export GUARDIAN_BASE_URL=https://guardian-api.odingard.com
 *   export GUARDIAN_AGENT_CREDENTIAL=...       (Guardian console → Agents)
 *   export GUARDIAN_CONNECTION_ID=pcn_...      (a tool server connection)
 *   npm run openai-agents -- "Look up order 42, then refund it in full"
 *
 * On that connection, register `lookup_order` and `refund_order` as
 * "My own code (record-only)" tools and allow them for the agent: set
 * `lookup_order` to Allow and `refund_order` to Ask.
 *
 * The tools below are stand-ins: they print what they would do. Replace
 * them with your own code.
 */
import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { createGuardianClient } from "@odingard/guardian-sdk";
import {
  createGuardianTool,
  findApprovalPending,
} from "@odingard/guardian-openai-agents";

const missing = [
  "OPENAI_API_KEY",
  "GUARDIAN_BASE_URL",
  "GUARDIAN_AGENT_CREDENTIAL",
  "GUARDIAN_CONNECTION_ID",
].filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Set ${missing.join(", ")} first (see the top of this file).`);
  process.exit(2);
}

const governed = createGuardianTool({
  client: createGuardianClient({
    baseUrl: process.env.GUARDIAN_BASE_URL,
    credential: process.env.GUARDIAN_AGENT_CREDENTIAL,
  }),
  connectionId: process.env.GUARDIAN_CONNECTION_ID,
  agentName: "Support agent (example)",
  onReceipt: ({ toolName, requestId }) =>
    console.log(`[guardian] receipt for ${toolName} (${requestId})`),
});

const lookupOrder = governed({
  name: "lookup_order",
  description: "Look up an order by id",
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) =>
    JSON.stringify({ orderId, total: 129.0, currency: "USD" }),
});

const refundOrder = governed({
  name: "refund_order",
  description: "Refund an order",
  parameters: z.object({ orderId: z.string(), amount: z.number() }),
  execute: async ({ orderId, amount }) => {
    console.log(`[your code] refunding ${amount} on order ${orderId}`);
    return `Refunded ${amount} on order ${orderId}.`;
  },
});

const agent = new Agent({
  name: "Support agent",
  instructions: "Help with orders. Use the tools; never guess order data.",
  tools: [lookupOrder, refundOrder],
});

const prompt =
  process.argv.slice(2).join(" ") ||
  "Look up order 42, then refund it in full.";

try {
  const result = await run(agent, prompt);
  console.log(`\nDone: ${result.finalOutput}`);
} catch (err) {
  const pending = findApprovalPending(err);
  if (!pending) throw err;
  console.log(
    `\n[guardian] ${pending.toolName} is waiting for approval ` +
      `(requestId ${pending.requestId}). Approve or deny it in Guardian.`,
  );
  // Poll until a person decides or the request expires. The tool runs only
  // after approval; a denial or expiry throws GuardianDenied.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      const { output } = await pending.resume();
      console.log(`[guardian] approved. Tool output: ${output}`);
      break;
    } catch (again) {
      if (findApprovalPending(again)) continue;
      console.log(`[guardian] not approved: ${again.message}`);
      break;
    }
  }
}
