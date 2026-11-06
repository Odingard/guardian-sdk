/**
 * coding-agent-ask.mjs — a coding agent whose consequential commands go
 * to ASK while read-only work flows through.
 *
 *   read_file      → ALLOW
 *   run_command    → ASK (it can change the machine — a human decides)
 *
 * Run:  node coding-agent-ask.mjs      (local demo policy, zero setup)
 */
import { guardian } from "./demo-guardian.mjs";

const { client, connectionId } = guardian();

async function propose(toolName, args) {
  const result = await client.request({
    action: "tool.invoke",
    connectionId,
    toolName,
    arguments: args,
    purpose: `coding-agent: ${toolName}`,
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

await propose("read_file", { path: "src/index.ts" });
await propose("run_command", { command: "rm -rf dist/ && npm run build" });
