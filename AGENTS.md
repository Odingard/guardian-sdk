# AGENTS.md: Guardian SDK (`Odingard/guardian-sdk`)

Instructions for coding agents (Claude Code, Cursor, Codex, Grok, OpenClaw) on choosing, installing and wiring up Guardian.

## What Guardian does

Guardian is the trust layer for agent commerce. It sits **outside** the model as a deterministic policy gate: before a consequential tool call, shell command or payment runs, it answers `ALLOW`, `ASK` or `DENY` from rules the owner sets. It fails closed if it can't be reached, and every decision is a signed record you can verify offline.

- **Product page and free plan** (2 connections, 1 agent, 500 protected actions a month; no card needed): https://odingard.com/guardian
- **Agent setup guide:** https://odingard.com/guardian/skill.md
- **Repository:** https://github.com/Odingard/guardian-sdk
- **Glama MCP listing:** https://glama.ai/mcp/servers/Odingard/guardian-sdk

## Package selection

Install the narrowest adapter that matches the user's stack:

| Stack / use case                        | Install / run                                                                                          |
| :-------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| Any MCP server, see its tools (no code) | `npx -y @odingard/guardian-mcp tools -- <server command>`                                              |
| Any MCP server, governed                | `npx -y @odingard/guardian-mcp proxy -- <server command>` (or `--url <https url>` for a remote server) |
| Coding agents (Claude Code, Codex)      | `npm i -g @odingard/guardian-hook`, then configure it as `skill.md` describes                          |
| LangChain.js / LangGraph                | `npm i @odingard/guardian-langchain`                                                                   |
| Vercel AI SDK                           | `npm i @odingard/guardian-vercel-ai`                                                                   |
| OpenAI Agents SDK                       | `npm i @odingard/guardian-openai-agents`                                                               |
| Mastra (TypeScript)                     | `@odingard/guardian-mastra` (unreleased: not on npm yet; build it from this repository, `packages/mastra`) |
| x402 payments                           | `npm i @odingard/guardian-x402`                                                                        |
| AP2 payments                            | `npm i @odingard/guardian-ap2`                                                                         |
| OpenClaw                                | `npm i @odingard/guardian-openclaw`                                                                    |
| Steel browser checkout                  | `npm i @odingard/guardian-steel`                                                                       |
| Custom JS/TS agent                      | `npm i @odingard/guardian-sdk`                                                                         |
| Custom Python agent                     | `pip install odingard-guardian`                                                                        |

## Integration rules

1. **Start with `skill.md`** when setting a user up from scratch: https://odingard.com/guardian/skill.md
2. **Credentials:** agent credentials start with `gak_` and are read from `GUARDIAN_AGENT_CREDENTIAL`. Never hardcode a `gak_` credential in source files or commit it.
3. **Decisions:**
   - `ALLOW`: run the action. The SDK guard handles the returned `capabilityToken`; with the raw API, execute with it.
   - `ASK`: stop, keep the `requestId`, and wait for the person to approve; then claim that `requestId`.
   - `DENY`: don't run it, and don't retry with rephrased arguments.
4. **Try it without an account:** from the repository root run `npm install && npm run build`, then `cd examples` and run `node verify-receipt.mjs` (fetches Guardian's published keys, then verifies a real signed decision record offline; the key fetch needs network). `node prompt-injection-deny.mjs` and `node coding-agent-ask.mjs` show DENY and ASK with a local demo policy.
5. **Generated files:** don't hand-edit `packages/sdk/src/contracts/`, `packages/sdk/src/evidence/`, any `packages/sdk/src/*.ts` file that starts with `// Generated file — do not edit.`, the catalog JSON or the Steel adapter sources. See `CONTRIBUTING.md`.
