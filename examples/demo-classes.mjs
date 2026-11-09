/**
 * demo-classes.mjs — the seven Guardian demonstration classes (demos
 * 0–6) through ONE SDK lifecycle: request → ALLOW/ASK/DENY →
 * (human) → execute → receipt.
 *
 * Label per run (printed, never assumed):
 *   SIMULATED — no env vars: a local deterministic demo policy stands in for
 *               Guardian. Nothing real is sent, paid, deployed or refunded.
 *   LIVE      — GUARDIAN_BASE_URL / GUARDIAN_AGENT_CREDENTIAL /
 *               GUARDIAN_CONNECTION_ID set: real hosted Guardian decides.
 *               Each tool must exist on that tool connection; the effect is
 *               whatever your connection's tool server really does.
 */
import { classifyRequestResult } from "@odingard/guardian-sdk";
import { guardian } from "./demo-guardian.mjs";

const { client, connectionId, demo } = guardian();
const label = demo ? "SIMULATED" : "LIVE";

const CLASSES = [
  [
    "0 email send",
    "send_email",
    { to: "cfo@example.com", subject: "Q3 numbers" },
  ],
  [
    "1 agent delegation",
    "delegate_task",
    { toAgent: "agt_research", task: "summarise" },
  ],
  [
    "2 vendor payment (flagship)",
    "pay_vendor",
    { vendor: "ACME", amountCents: 125000 },
  ],
  [
    "3 PHI disclosure",
    "disclose_phi_external",
    { patient: "p_1", to: "partner.example" },
  ],
  [
    "4 production deploy (flagship)",
    "deploy_production",
    { service: "api", ref: "v2.3.1" },
  ],
  [
    "5 CRM update",
    "update_crm_record",
    { account: "acc_9", field: "tier", value: "gold" },
  ],
  [
    "6 customer refund (flagship)",
    "issue_refund",
    { orderId: "ord_1042", amountCents: 4999, reason: "damaged item" },
  ],
];

for (const [name, toolName, args] of CLASSES) {
  const result = await client.request({
    action: "tool.invoke",
    connectionId,
    toolName,
    arguments: args,
    purpose: `demo class ${name}`,
  });
  const d = classifyRequestResult(result);
  let line = `[${label}] demo ${name.padEnd(32)} ${d.decision}`;
  let token = d.decision === "ALLOW" ? d.capabilityToken : undefined;
  if (d.decision === "ASK") {
    // A real deployment holds here until a human approves in the Guardian
    // console or an embedded approval surface; claim() then collects the
    // capability. The local demo policy auto-approves to show the shape.
    const claimed = classifyRequestResult(await client.claim(d.requestId));
    line += ` → human: ${claimed.decision}`;
    token = claimed.decision === "ALLOW" ? claimed.capabilityToken : undefined;
  }
  if (d.decision === "DENY") line += ` (${d.reasonCode}) — never executed`;
  if (token) {
    const ex = await client.execute({
      requestId: d.requestId,
      capabilityToken: token,
    });
    line += ex.ok
      ? ` → executed, receipt ${ex.receipt.status}`
      : ` → ${ex.reasonCode}`;
  }
  console.log(line);
}
