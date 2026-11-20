/**
 * mastra-agent.mjs — a Mastra agent pays supplier invoices, with Guardian
 * deciding before the payment tool runs.
 *
 *   $480 to a known supplier             → ALLOW: the tool runs, receipt recorded
 *   $12,400 to a known supplier          → ASK:   the Mastra run suspends; after a
 *                                                  person approves, resuming it pays
 *   $9,000 to a payee nobody approved    → DENY:  the tool never runs
 *
 * This is Mastra's real agent loop (`Agent`, `createTool`, suspend/resume
 * with in-memory storage) and `guardianTools` from @odingard/guardian-mastra.
 * The payment tool is YOUR code; Guardian decides whether it may run and
 * records the evidence (in-process mode).
 *
 * Run:  node agents/mastra-agent.mjs      (no account, no API key)
 *
 * Labels are honest:
 *   [SCRIPTED model]       no language model is called: a scripted stand-in
 *                          proposes the three tool calls an LLM would
 *   [SIMULATED guardian]   local demo policy (demo-guardian.mjs), not Guardian
 *   [LIVE guardian]        GUARDIAN_BASE_URL / GUARDIAN_AGENT_CREDENTIAL /
 *                          GUARDIAN_CONNECTION_ID set: real hosted Guardian.
 *                          Register pay_invoice as a record-only tool on that
 *                          connection and allow it for the agent first. Your
 *                          console policy decides (the $5k threshold and the
 *                          payee rule are demo-policy only), and ASK waits
 *                          for a real person.
 *   [SIMULATED payment]    no payment provider is called
 */
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import {
  MastraLanguageModelV2Mock,
  simulateReadableStream,
} from "@mastra/core/test-utils/llm-mock";
import { createTool } from "@mastra/core/tools";
import { guardianTools } from "@odingard/guardian-mastra";
import { z } from "zod";

import { guardian } from "../demo-guardian.mjs";

const { client, connectionId, demo } = guardian();
const G = demo ? "[SIMULATED guardian]" : "[LIVE guardian]";
const M = "[SCRIPTED model]";
const P = "[SIMULATED payment]";

/** Your payment code. It runs only after ALLOW, or after a person approves an ASK. */
const payInvoice = createTool({
  id: "pay_invoice",
  description: "Pay a supplier invoice",
  inputSchema: z.object({
    invoiceId: z.string(),
    payeeId: z.string(),
    amountCents: z.number().int().positive(),
    currency: z.string(),
  }),
  execute: async (invoice) => {
    console.log(`  ${P} paying ${invoice.invoiceId}`);
    return { paymentId: `sim_${invoice.invoiceId}`, status: "succeeded" };
  },
});

const tools = guardianTools(
  { pay_invoice: payInvoice },
  {
    client,
    connectionId,
    agentName: "ap-agent",
    // The tool body is the payment: it runs here, after Guardian's answer.
    mode: "inProcess",
    // A held call suspends the Mastra run instead of failing the tool call.
    onAsk: "suspend",
    onReceipt: ({ requestId }) =>
      console.log(`  ${G} ALLOW → receipt recorded (requestId ${requestId})`),
    purpose: (_tool, inv) =>
      `Pay invoice ${inv.invoiceId}: ${(inv.amountCents / 100).toFixed(2)} ${inv.currency} to ${inv.payeeId}`,
  },
);

const invoices = [
  { invoiceId: "INV-1001", payeeId: "acme-supplies", amountCents: 48_000, currency: "USD" },
  { invoiceId: "INV-1002", payeeId: "acme-supplies", amountCents: 1_240_000, currency: "USD" },
  { invoiceId: "INV-1003", payeeId: "acme-supplies-new-bank", amountCents: 900_000, currency: "USD" },
];

/**
 * The scripted model: for a prompt that ends with a user message it proposes
 * the next invoice's tool call; once the tool result is in the prompt it
 * answers in text, quoting what the agent loop handed back.
 */
let nextInvoice = 0;
function modelStep(prompt) {
  const last = prompt.at(-1);
  if (last.role !== "tool") {
    const invoice = invoices[nextInvoice];
    nextInvoice += 1;
    return [
      {
        type: "tool-call",
        toolCallId: `call_${invoice.invoiceId}`,
        toolName: "pay_invoice",
        input: JSON.stringify(invoice),
      },
    ];
  }
  const { output } = last.content[0];
  const text =
    output.type === "error-text"
      ? `Not paid. ${output.value}`
      : `Paid: ${JSON.stringify(output.value)}`;
  return [{ type: "text", text }];
}

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const finishReason = (step) =>
  step.some((part) => part.type === "tool-call") ? "tool-calls" : "stop";
const model = new MastraLanguageModelV2Mock({
  doGenerate: async ({ prompt }) => {
    const step = modelStep(prompt);
    return { content: step, finishReason: finishReason(step), usage, warnings: [] };
  },
  doStream: async ({ prompt }) => {
    const step = modelStep(prompt);
    const chunks = [{ type: "stream-start", warnings: [] }];
    for (const part of step) {
      if (part.type === "text") {
        chunks.push(
          { type: "text-start", id: "text_1" },
          { type: "text-delta", id: "text_1", delta: part.text },
          { type: "text-end", id: "text_1" },
        );
      } else {
        chunks.push(part);
      }
    }
    chunks.push({ type: "finish", finishReason: finishReason(step), usage });
    return { stream: simulateReadableStream({ chunks }) };
  },
});

// Suspend and resume need storage for the run's snapshot.
const mastra = new Mastra({
  agents: {
    ap: new Agent({
      id: "ap-agent",
      name: "ap-agent",
      instructions: "Pay the supplier invoices you are given.",
      model,
      tools,
    }),
  },
  storage: new InMemoryStore(),
  logger: false,
});
const agent = mastra.getAgent("ap");

/**
 * Resume the suspended run once a person has approved the request in
 * Guardian. Resuming is not approving: the tool runs only if Guardian says
 * the request was approved, and the run suspends again if it is still held.
 */
async function resumeWhenApproved(run) {
  const { toolCallId, suspendPayload } = run.suspendPayload;
  const { requestId } = suspendPayload.guardian;
  console.log(`  ${G} ASK → run suspended, nothing paid yet (requestId ${requestId})`);
  if (demo) {
    console.log(`  ${G} a person approves the exact invoice (simulated)…`);
    return agent.resumeGenerate({}, { runId: run.runId, toolCallId });
  }
  console.log(`  ${G} approve request ${requestId} in the Guardian console (polling for 5 min)…`);
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const resumed = await agent.resumeGenerate({}, { runId: run.runId, toolCallId });
    if (resumed.finishReason !== "suspended") return resumed;
  }
  throw new Error("approval timed out; nothing was paid");
}

for (const invoice of invoices) {
  console.log(
    `\n→ pay ${invoice.invoiceId}: $${(invoice.amountCents / 100).toLocaleString()} to ${invoice.payeeId}`,
  );
  let run = await agent.generate(
    `Pay invoice ${invoice.invoiceId}: ${invoice.amountCents} cents to ${invoice.payeeId}`,
  );
  if (run.finishReason === "suspended") {
    run = await resumeWhenApproved(run);
  }
  console.log(`  ${M} ${run.text}`);
}
