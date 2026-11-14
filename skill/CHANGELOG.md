# skill.md changelog

Each version of `skill.md` is tagged `skill-v<version>` in this repository and
served with the same bytes at https://odingard.com/guardian/skill.md (latest)
and https://odingard.com/guardian/skill/<version>/skill.md. To check a copy:

```sh
sha256sum skill.md
```

The hash must equal the one recorded below for its version.

## 1.0.5

- Date: 2026-11-14
- SHA-256: `fcfec00844966b18653f6da97878b705ea8edb45f1cd96e3fd6c4df371da0278`
- Pins: unchanged from 1.0.4.
- Codex CLI, DeepSeek Harness and Hermes: "tested locally against a real Guardian" in place of "example, not yet tested". Two sentences in 4C shortened. No other change.

## 1.0.4

- Date: 2026-11-13
- SHA-256: `4cfe693ac999223acde2d142c96824a35ff21d1d3826375020f282b9153afa33`
- Pins: `@odingard/guardian-hook` 0.4.0; `@odingard/guardian-mcp` 0.5.0; `@odingard/guardian-sdk`, `@odingard/guardian-langchain` and `@odingard/guardian-vercel-ai` 0.6.0; `@odingard/guardian-openai-agents` 0.4.0; `@odingard/guardian-openclaw` 0.1.1; `odingard-guardian` 0.3.0.
- Pins the sdk 0.6.0 release (dollar amounts on tools, `amountArgs`) and says the MCP package and the wrappers take the SDK as `^0.6.0`. No other change.

## 1.0.3

- Date: 2026-11-12
- SHA-256: `327d10915c4aba8559ba5c6495669431ef471416bb2a383e5ce010f258ff0af9`
- Pins: `@odingard/guardian-hook` and `@odingard/guardian-mcp` 0.4.0; `@odingard/guardian-sdk`, `@odingard/guardian-langchain` and `@odingard/guardian-vercel-ai` 0.5.0; `@odingard/guardian-openai-agents` 0.3.0; `@odingard/guardian-openclaw` 0.1.1; `odingard-guardian` 0.3.0.
- Pins guardian-openclaw 0.1.1 (an OpenShell credential placeholder stays in the Gateway environment). No other change.

## 1.0.2

- Date: 2026-11-12
- SHA-256: `38a1ebb802bf80ea2d59e6ca3cb9b1c4b92576d69f77147b92fb57df0ac854e1`
- Pins: `@odingard/guardian-hook` and `@odingard/guardian-mcp` 0.4.0; `@odingard/guardian-sdk`, `@odingard/guardian-langchain` and `@odingard/guardian-vercel-ai` 0.5.0; `@odingard/guardian-openai-agents` 0.3.0; `@odingard/guardian-openclaw` 0.1.0; `odingard-guardian` 0.3.0.
- Pins the sdk 0.5.0 release (opt-in file preview on approvals) and says the wrappers take the SDK as `^0.5.0`. No other change.

## 1.0.1

- Date: 2026-11-12
- SHA-256: `3bc4388ae798ef3c4987e678edcc27990cc82e01f740d85bbb986de47e7945b7`
- Pins: `@odingard/guardian-hook` and `@odingard/guardian-mcp` 0.4.0; `@odingard/guardian-sdk`, `@odingard/guardian-langchain` and `@odingard/guardian-vercel-ai` 0.4.1; `@odingard/guardian-openai-agents` 0.2.1; `@odingard/guardian-openclaw` 0.1.0; `odingard-guardian` 0.2.1.
- Pins the sdk 0.4.1 release (`bytes` is the default content-pin mode) and says which SDK range the wrappers take. No other change.

## 1.0.0

- Date: 2026-11-11
- SHA-256: `0935c8076bd9e6a08aad8b44e77949a344dc3f1d02dad097eb02cacbf0d90bc7`
- Pins: `@odingard/guardian-hook`, `@odingard/guardian-mcp`, `@odingard/guardian-sdk`, `@odingard/guardian-langchain` and `@odingard/guardian-vercel-ai` 0.4.0; `@odingard/guardian-openai-agents` 0.2.0; `@odingard/guardian-openclaw` 0.1.0; `odingard-guardian` 0.2.0.
- First version. Covers Claude Code, the Claude Agent SDK (TypeScript), Codex CLI, DeepSeek Harness, the MCP proxy, the TypeScript SDK and wrappers, Python and OpenClaw.
