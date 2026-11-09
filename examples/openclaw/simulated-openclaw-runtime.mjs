/**
 * SIMULATED: Guardian's OpenClaw plugin inside OpenClaw's real tool-hook
 * runtime, with a stand-in Guardian.
 *
 * What is real: OpenClaw 2026.7.1,
 * its before_tool_call hook runner and the wrapper it puts around every tool,
 * and this repo's plugin handler. What is simulated: Guardian itself (an
 * in-memory policy below, no signing, no receipts) and the tools (they only
 * print). For the LIVE run on the official image, see README.md.
 *
 * Step 0 runs the plugin's real install-integrity check against this
 * checkout, which the user running the demo can write (or which runs as
 * root): every call is blocked and Guardian is never asked. Steps 1-5 then
 * use GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1, the opt-out, so the
 * decision flow can be shown from a writable checkout. A real Gateway must
 * protect its install instead (package README, "Required: protect the
 * install"); with the opt-out the agent can switch Guardian off.
 *
 *   cd examples/openclaw && npm install && npm run simulated
 */
import { wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";

import {
  ALLOW_WRITABLE_INSTALL_ENV,
  createGuardianToolHandler,
  HOOK_PRIORITY,
  HOOK_TIMEOUT_MS,
  PLUGIN_ID,
} from "@odingard/guardian-openclaw";

// --- Stand-in Guardian (SIMULATED) -----------------------------------------
// Everyday tools are allowed; Ask-tier tools wait for a "person", who approves
// terraform and nothing else; Composio email sends are denied.
const requests = new Map();
let n = 0;
const fakeGuardian = {
  async request({ toolName, arguments: args }) {
    const requestId = `req_sim_${++n}`;
    if (toolName.startsWith("mcp.composio.gmail_send")) {
      return {
        ok: true,
        requestId,
        decision: "DENY",
        reasonCode: "NOT_AUTHORIZED",
      };
    }
    if (["shell", "file_write", "web_fetch"].includes(toolName)) {
      return { ok: true, requestId, decision: "ALLOW", capabilityToken: "cap" };
    }
    const approves = /terraform apply/.test(String(args.command ?? ""));
    requests.set(requestId, {
      approveAt: approves ? Date.now() + 2_500 : Infinity,
    });
    console.log(`  [guardian] ${toolName} held for approval (${requestId})`);
    return { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId };
  },
  async claim(requestId) {
    const r = requests.get(requestId);
    if (r && Date.now() >= r.approveAt) {
      console.log(`  [guardian] a person approved ${requestId}`);
      return { ok: true, requestId, decision: "ALLOW", capabilityToken: "cap" };
    }
    return { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId };
  },
  async execute({ requestId }) {
    console.log(`  [guardian] capability for ${requestId} redeemed`);
    return {
      ok: true,
      receipt: { receiptReference: requestId, status: "succeeded" },
    };
  },
};

// --- The plugin, registered the way OpenClaw registers it -------------------
const makeHandler = (env) =>
  createGuardianToolHandler({
    config: {
      connectionId: "pcn_everyday",
      askConnectionId: "pcn_ask",
      approvalTimeoutMs: 6_000,
    },
    client: fakeGuardian,
    env,
    logger: {
      info: () => {},
      warn: (m) => console.log(`  [plugin] ${m.slice(0, 160)}…`),
    },
  });
// The hook runner calls whichever handler is current: step 0 uses the real
// install check, steps 1-5 the opt-out (see the header).
let current;
const handler = (event, ctx) => current(event, ctx);
initializeGlobalHookRunner({
  hooks: [],
  plugins: [{ id: PLUGIN_ID, status: "loaded" }],
  trustedToolPolicies: [],
  typedHooks: [
    {
      pluginId: PLUGIN_ID,
      hookName: "before_tool_call",
      handler,
      priority: HOOK_PRIORITY,
      timeoutMs: HOOK_TIMEOUT_MS,
      source: "example",
    },
  ],
});

// --- Tools, wrapped by OpenClaw's own before_tool_call wrapper -------------
function tool(name) {
  return wrapToolWithBeforeToolCallHook(
    {
      name,
      execute: async (_id, params) => {
        console.log(`  [tool] ${name} RAN with ${JSON.stringify(params)}`);
        return { content: [{ type: "text", text: "done" }] };
      },
    },
    { agentId: "main" },
  );
}

async function attempt(label, name, params) {
  console.log(`\n${label}`);
  try {
    const out = await tool(name).execute(
      `tc_${label.length}`,
      params,
      undefined,
    );
    const text = out?.content?.[0]?.text ?? "";
    if (text !== "done")
      console.log(`  [openclaw] blocked: ${text.slice(0, 140)}`);
  } catch (err) {
    console.log(
      `  [openclaw] blocked: ${String(err?.message ?? err).slice(0, 140)}`,
    );
  }
}

current = makeHandler({ ...process.env });
const asked = n;
await attempt("0. everyday command, writable install (blocked)", "exec", {
  command: "ls -la",
});
if (n !== asked)
  throw new Error("Guardian was asked despite a writable install");

console.log(`\n-- SIMULATED from here on: ${ALLOW_WRITABLE_INSTALL_ENV}=1 --`);
current = makeHandler({ ...process.env, [ALLOW_WRITABLE_INSTALL_ENV]: "1" });
await attempt("1. everyday command (allowed)", "exec", { command: "ls -la" });
await attempt("2. read-only tool (not sent to Guardian)", "read", {
  path: "README.md",
});
await attempt("3. deploy (waits; a person approves)", "exec", {
  command: "terraform apply -auto-approve",
});
await attempt("4. destructive command (nobody approves: never runs)", "exec", {
  command: "rm -rf ./build",
});
await attempt(
  "5. Composio email via MCP (denied)",
  "composio__GMAIL_SEND_EMAIL",
  { to: "sam@example.com" },
);
