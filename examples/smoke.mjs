import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL(".", import.meta.url));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    !name.startsWith("GUARDIAN_") && !name.startsWith("REMOTE_MCP_"),
  ),
);
const node = process.execPath;
const python = process.env.PYTHON || "python3";
const examples = [
  [node, "verify-receipt.mjs"],
  [node, "demo-classes.mjs"],
  [node, "shopping-agent.mjs"],
  [node, "prompt-injection-deny.mjs"],
  [node, "coding-agent-ask.mjs"],
  [node, "agents/agent-hooks.mjs", "codex"],
  [node, "agents/agent-hooks.mjs", "dsh"],
  [node, "agents/openclaw/simulated-openclaw-runtime.mjs"],
  [node, "mcp/remote-mcp.mjs"],
  [node, "payments/invoice-agent.mjs"],
  [node, "payments/steel-checkout.mjs"],
  [node, "payments/ap2/simulated-payments.mjs"],
  [node, "payments/x402/simulated-payments.mjs"],
  [python, "agents/hermes/hermes_hook_demo.py"],
  [python, "python/invoice_agent.py"],
];

const failed = [];
for (const [runtime, ...args] of examples) {
  const name = args.join(" ");
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(runtime, args, { cwd, env, stdio: "inherit", timeout: 60000 });
  if (result.status !== 0) {
    console.error(`FAIL ${name}: ${result.error?.message ?? result.signal ?? result.status}`);
    failed.push(name);
  } else {
    console.log(`PASS ${name}`);
  }
}

console.log(`\n${examples.length - failed.length}/${examples.length} published, no-account examples passed.`);
if (failed.length) process.exitCode = 1;
