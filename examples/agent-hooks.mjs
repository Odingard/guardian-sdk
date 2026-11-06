/**
 * SIMULATED: Guardian's hook as OpenAI Codex CLI or DeepSeek Harness sees it.
 *
 *   node agent-hooks.mjs codex    # Codex PreToolUse payloads (Bash, apply_patch, MCP)
 *   node agent-hooks.mjs dsh      # DeepSeek Harness payloads (bash, write, str_replace_editor, …)
 *
 * The payloads have the shape each agent sends on stdin. The Guardian here is
 * a local stand-in policy (no account, no network): shell → ALLOW, deploys →
 * ASK then a simulated approval, destructive → DENY, file edits → ALLOW. What
 * is printed is exactly what the agent would receive: exit code, stdout and
 * stderr. For the LIVE run with a real agent and a real Guardian, see
 * codex/README.md and deepseek-harness/README.md.
 */
import { runHookAs } from "@odingard/guardian-hook";

const dialect = process.argv[2] === "dsh" ? "dsh" : "codex";
console.log(`SIMULATED: stand-in Guardian policy, ${dialect} hook output\n`);

const POLICY = {
  shell: "ALLOW",
  file_write: "ALLOW",
  shell_deploy: "ASK",
  git_push: "ASK",
  shell_destructive: "DENY",
};

/** A stand-in for the Guardian client: deterministic, local. */
function standInGuardian() {
  let n = 0;
  return {
    async request({ toolName, arguments: args }) {
      const requestId = `req_sim_${++n}`;
      console.log(`  Guardian sees: ${toolName} ${JSON.stringify(args)}`);
      const mode = POLICY[toolName] ?? "ASK";
      if (mode === "ALLOW") {
        return {
          ok: true,
          requestId,
          decision: "ALLOW",
          capabilityToken: "cap_sim",
        };
      }
      if (mode === "DENY") {
        return {
          ok: true,
          requestId,
          decision: "DENY",
          reasonCode: "NOT_AUTHORIZED",
        };
      }
      return { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId };
    },
    async claim(requestId) {
      console.log(
        `  (simulated) a person approves ${requestId} on their phone`,
      );
      return {
        ok: true,
        requestId,
        decision: "ALLOW",
        capabilityToken: "cap_sim",
      };
    },
    async execute() {
      return {
        ok: true,
        receipt: { receiptReference: "rcpt_sim", status: "succeeded" },
      };
    },
  };
}

const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/app.ts",
  "@@",
  "-const x = 1;",
  "+const x = 2;",
  "*** End Patch",
].join("\n");

const CALLS =
  dialect === "codex"
    ? [
        ["Bash", { command: "npm test" }],
        ["apply_patch", { command: PATCH }],
        ["Bash", { command: "terraform apply -auto-approve" }],
        ["Bash", { command: "rm -rf /data/workspace" }],
      ]
    : [
        ["bash", { command: "npm test" }],
        ["write", { file_path: "/data/workspace/notes.md", content: "hello" }],
        ["str_replace_editor", { command: "view", path: "/data/workspace" }],
        ["bash", { command: "terraform apply -auto-approve" }],
        ["bash", { command: "rm -rf /data/workspace" }],
      ];

const env = {
  GUARDIAN_AGENT_CREDENTIAL: "simulated",
  GUARDIAN_CONNECTION_ID: "pcn_simulated_everyday",
  GUARDIAN_HOOK_ASK_CONNECTION_ID: "pcn_simulated_approval",
};

function show(result) {
  console.log(`  → exit ${result.exitCode}`);
  if (result.stdout) console.log(`    stdout ${result.stdout}`);
  if (result.stderr) console.log(`    stderr ${result.stderr}`);
  if (!result.stdout && !result.stderr) {
    console.log(
      result.verdict
        ? "    (no output: the call runs)"
        : "    (not governed: the agent's own rules apply)",
    );
  }
}

for (const [tool_name, tool_input] of CALLS) {
  console.log(`\n${tool_name} ${JSON.stringify(tool_input).slice(0, 80)}`);
  const result = await runHookAs(
    dialect,
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name,
      tool_input,
      cwd: "/data/workspace",
    }),
    env,
    { client: standInGuardian(), wait: async () => {}, log: () => {} },
  );
  show(result);
}

console.log("\nFail closed: the same call with no Guardian configuration");
show(
  await runHookAs(
    dialect,
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: dialect === "codex" ? "Bash" : "bash",
      tool_input: { command: "npm test" },
    }),
    {},
  ),
);
