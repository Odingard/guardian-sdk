/**
 * A Claude agent governed by Guardian (Claude Agent SDK + guardian-hook).
 *
 * LIVE: needs a real Claude API key and a real Guardian agent. Nothing here
 * is simulated: every shell command, file write and MCP call the agent makes
 * goes to Guardian first. Everyday commands run; deploys, destructive
 * commands and pushes wait for a person to approve on their phone; every
 * allowed call leaves a receipt you can verify offline.
 *
 *   export ANTHROPIC_API_KEY=...                 (your Claude key)
 *   export GUARDIAN_AGENT_CREDENTIAL=...         (Guardian console → Agents)
 *   export GUARDIAN_CONNECTION_ID=pcn_...        ("Coding agent — everyday", Allow)
 *   export GUARDIAN_HOOK_ASK_CONNECTION_ID=pcn_...  ("Coding agent — needs approval", Ask)
 *   export CLAUDE_MODEL=...                      (optional; the Agent SDK default otherwise)
 *   npm run claude-agent-sdk -- "List the files here, then run: terraform apply"
 *
 * The two connections are what "Set up for Claude Code" in the console
 * creates; the same setup governs Claude Code and Claude Agent SDK agents.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { guardianHookMatcher } from "@odingard/guardian-hook/agent-sdk";

const missing = [
  "ANTHROPIC_API_KEY",
  "GUARDIAN_AGENT_CREDENTIAL",
  "GUARDIAN_CONNECTION_ID",
].filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Set ${missing.join(", ")} first (see the top of this file).`);
  process.exit(2);
}

const prompt =
  process.argv.slice(2).join(" ") ||
  "List the files in this directory, then run `terraform apply -auto-approve`.";

for await (const message of query({
  prompt,
  options: {
    ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
    // Guardian decides every governed call before it runs. The matcher sets
    // onFailure: "block" (a crash blocks the call) and a timeout longer than
    // Guardian's 5-minute approval window.
    hooks: {
      PreToolUse: [
        guardianHookMatcher({ agentName: "Claude agent (example)" }),
      ],
    },
  },
})) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text") console.log(block.text);
      if (block.type === "tool_use") {
        console.log(`[tool] ${block.name} ${JSON.stringify(block.input)}`);
      }
    }
  } else if (message.type === "result") {
    console.log(
      message.subtype === "success"
        ? `\nDone: ${message.result}`
        : `\nStopped: ${message.subtype}`,
    );
  }
}
