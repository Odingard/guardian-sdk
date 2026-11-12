# skill.md changelog

Each version of `skill.md` is tagged `skill-v<version>` in this repository and
served with the same bytes at https://odingard.com/guardian/skill.md (latest)
and https://odingard.com/guardian/skill/<version>/skill.md. To check a copy:

```sh
sha256sum skill.md
```

The hash must equal the one recorded below for its version.

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
