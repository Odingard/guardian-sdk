/**
 * A Claude Code agent for Maritime (https://maritime.sh), governed by Guardian.
 *
 * LIVE: needs a Claude API key and a Guardian agent. Nothing is simulated.
 *
 * Maritime runs each agent in its own micro-VM and talks to it over its
 * bring-your-own-agent contract: GET /health and POST /chat on $PORT, with
 * persistent state under /data. Inside the VM, Claude Code runs unattended
 * (permissionMode "bypassPermissions"), which is right for an isolated
 * sandbox but means nothing asks before a command runs.
 *
 * Guardian adds that check. Every shell command, file write and MCP call goes
 * to Guardian first:
 *   - everyday commands run;
 *   - deploys, destructive commands and pushes wait for a person to approve
 *     the exact action (Guardian console or phone);
 *   - anything Guardian denies, or nobody approves in time, does not run;
 *   - every allowed call leaves a receipt you can verify offline.
 * A PreToolUse hook runs even under bypassPermissions, and its deny holds.
 *
 * Environment (set on the Maritime agent; mark keys as secrets):
 *   ANTHROPIC_API_KEY                 Claude key (a workspace-scoped key)
 *   GUARDIAN_AGENT_CREDENTIAL         Guardian console -> Agents
 *   GUARDIAN_CONNECTION_ID            pcn_... "Coding agent — everyday" (Allow)
 *   GUARDIAN_HOOK_ASK_CONNECTION_ID   pcn_... "Coding agent — needs approval" (Ask)
 *   IS_SANDBOX=1                      required: Maritime runs agents as root
 *   CLAUDE_MODEL                      optional (default claude-opus-5-5)
 *
 * Maritime's gateway gives each reply about 30 seconds, and a Guardian
 * approval can take up to 5 minutes. A request is never cancelled: if it is
 * still running (for example, waiting for an approval) when the reply is due,
 * the agent says what it is waiting for, and the finished answer comes back
 * as the reply to the next message in that conversation.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { guardianHookMatcher } from "@odingard/guardian-hook/agent-sdk";

const PORT = Number(process.env.PORT ?? 8080);
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 20);
const REPLY_BUDGET_MS = Number(process.env.REPLY_BUDGET_MS ?? 24_000);
const AGENT_NAME = process.env.GUARDIAN_HOOK_AGENT_NAME || "Maritime agent";

// /data survives restarts, redeploys and sleep/wake; everything else is disposable.
const DATA_DIR = fs.existsSync("/data") ? "/data" : path.resolve("data");
const WORKSPACE = path.join(DATA_DIR, "workspace");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
fs.mkdirSync(WORKSPACE, { recursive: true });
process.env.CLAUDE_CONFIG_DIR ||= path.join(DATA_DIR, ".claude");

/** What is missing before this agent may run anything at all. */
export function missingConfig(env = process.env) {
  const missing = [
    "ANTHROPIC_API_KEY",
    "GUARDIAN_AGENT_CREDENTIAL",
    "GUARDIAN_CONNECTION_ID",
  ].filter((name) => !env[name]?.trim());
  if (env.IS_SANDBOX !== "1") missing.push("IS_SANDBOX=1");
  return missing;
}

let sessions = {};
try {
  sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
} catch {
  sessions = {};
}
function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
  } catch {
    // A lost session map only costs conversation memory, never safety.
  }
}

/** Per conversation: the running request, a finished reply not yet delivered, and Guardian's latest note. */
const conversations = new Map();
function stateFor(id) {
  let state = conversations.get(id);
  if (!state) {
    state = { running: null, stashed: null, guardianNote: null };
    conversations.set(id, state);
  }
  return state;
}

async function runQuery(message, conversationId, state) {
  const options = {
    cwd: WORKSPACE,
    model: MODEL,
    maxTurns: MAX_TURNS,
    // Unattended inside an isolated VM. Guardian, not a prompt, decides.
    permissionMode: "bypassPermissions",
    hooks: {
      PreToolUse: [
        guardianHookMatcher({
          agentName: AGENT_NAME,
          // Shown in the chat if the reply is due while an action is held.
          log: (line) => {
            state.guardianNote = line;
            process.stderr.write(`${line}\n`);
          },
        }),
      ],
    },
  };
  if (sessions[conversationId]) options.resume = sessions[conversationId];

  let sessionId = sessions[conversationId] ?? null;
  let result = null;
  let streamed = "";
  for await (const msg of query({ prompt: message, options })) {
    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
    } else if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text" && block.text) streamed += `${block.text}\n`;
      }
    } else if (msg.type === "result") {
      sessionId = msg.session_id ?? sessionId;
      if (msg.subtype === "success" && typeof msg.result === "string") {
        result = msg.result;
      }
    }
  }
  if (sessionId) {
    sessions[conversationId] = sessionId;
    saveSessions();
  }
  return (result ?? streamed).trim() || "Done.";
}

function failureText(error) {
  const text = String(error?.message ?? error);
  // Never echo keys or credentials; the SDK's messages do not contain them.
  return `Something went wrong running Claude Code: ${text}`;
}

export async function handleChat(message, conversationId) {
  const missing = missingConfig();
  if (missing.length > 0) {
    return `This agent is not set up yet, so it will not run anything. Set ${missing.join(", ")} in the agent's environment variables on Maritime, then restart it.`;
  }
  const state = stateFor(conversationId);
  if (state.stashed) {
    const out = state.stashed;
    state.stashed = null;
    return out;
  }
  if (state.running) {
    return state.guardianNote
      ? `Still waiting. ${state.guardianNote}`
      : "Still working on your last request. Message me again in a moment.";
  }

  state.guardianNote = null;
  let deliveredInline = false;
  const task = runQuery(message, conversationId, state);
  state.running = task;
  task
    .then((reply) => {
      if (!deliveredInline) state.stashed = reply;
    })
    .catch((error) => {
      if (!deliveredInline) state.stashed = failureText(error);
    })
    .finally(() => {
      if (state.running === task) state.running = null;
    });

  const winner = await Promise.race([
    task.then(
      (reply) => ({ reply }),
      (error) => ({ error }),
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve("timeout"), REPLY_BUDGET_MS),
    ),
  ]);
  if (winner !== "timeout") {
    deliveredInline = true;
    state.stashed = null;
    return "error" in winner ? failureText(winner.error) : winner.reply;
  }
  return state.guardianNote
    ? `${state.guardianNote} Nothing runs until then. Message me again for the result.`
    : "I'm on it. This takes more than a few seconds; message me again shortly for the answer.";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (
    req.method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/healthz")
  ) {
    return send(200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/") {
    return send(200, {
      agent: "claude-code",
      governedBy: "guardian",
      model: MODEL,
      ready: missingConfig().length === 0,
    });
  }
  if (req.method === "POST" && url.pathname === "/chat") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return send(400, { error: "invalid JSON" });
    }
    const message =
      typeof payload.message === "string" ? payload.message.trim() : "";
    if (!message) return send(400, { error: "message is required" });
    const conversationId =
      payload.conversation_id || payload.conversationId || "default";
    try {
      return send(200, { response: await handleChat(message, conversationId) });
    } catch (error) {
      return send(200, { response: failureText(error) });
    }
  }
  return send(404, { error: "not found" });
});

if (process.argv[1]?.endsWith("server.mjs")) {
  server.listen(PORT, "0.0.0.0", () => {
    const missing = missingConfig();
    process.stderr.write(
      `Guardian-governed Claude Code agent on :${PORT} (model ${MODEL}).` +
        (missing.length ? ` Not ready: set ${missing.join(", ")}.` : "") +
        "\n",
    );
  });
}
