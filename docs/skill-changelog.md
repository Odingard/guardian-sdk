# skill.md changelog

Each version of `skill.md` is tagged `skill-v<version>` in this repository and
served with the same bytes at https://odingard.com/guardian/skill.md (latest)
and https://odingard.com/guardian/skill/<version>/skill.md. To check a copy:

```sh
sha256sum skill.md
```

The hash must equal the one recorded below for its version.

## 1.0.12

- Date: 2026-11-18
- SHA-256: `ed11dbb8fdcd74895e1fac1f3f84865ff50f60af70ce49bb1eef796c44ef313e`
- Pins: `@odingard/guardian-hook` 0.4.3. The other pins are unchanged from 1.0.11.
- Pins the hook release that blocks the action when the hook fails to start or crashes. The Claude Code hook settings in 4A add `"onFailure": "block"`. No other change.

## 1.0.11

- Date: 2026-11-18
- SHA-256: `9fe918b14142c7e04219f6607b7198eaf75a112a20c183b19e261000df22ff90`
- Pins: `@odingard/guardian-hook` 0.4.2; `@odingard/guardian-openclaw` 0.1.3; `odingard-guardian` 0.5.0. The other pins are unchanged from 1.0.10.
- Pins the hook and OpenClaw approval-message release and Python's Agent Framework, Semantic Kernel, amount_args and message changes. No other change.

## 1.0.10

- Date: 2026-11-16
- SHA-256: `3606641e9fc04b3f89622e2bf89025eb498f31482e0aa707de5cb1e2dd738510`
- Pins: unchanged from 1.0.9.
- Credential check: use only the provided check; never print the credential. Section 3.1 gives one check, which prints only `set`, `missing` or `set, wrong format` (the same `gak_` prefix and length test as before, written without stripping the value). Rule 6 says to run only that check and never to print, echo, `cat` or interpolate the credential, or use the `${VAR:-…}` and `${VAR:+…}` forms with it. No other change.

## 1.0.9

- Date: 2026-11-16
- SHA-256: `230087ee309699148c5bf04ac1c155f589b55e1783b745b9ba98e465ebf1a509`
- Pins: unchanged from 1.0.8.
- No pin change; public text only. The section headings 4A to 4E and 4H carry no status, and the status sentences in 4F, 4G and 4H are removed. 4H asks for one test message or MCP call before relying on it for those. No other change.

## 1.0.8

- Date: 2026-11-15
- SHA-256: `56d75531507922603b6c4d1b2bf6a9d57fbebe3bd11d588f732063cee36f1c8f`
- Pins: `@odingard/guardian-sdk` 0.6.2. The other pins are unchanged from 1.0.7.
- Pins the sdk 0.6.2 release (`guardian-sdk --help` exits 0; `verify --help` prints the usage and exits 2). No other change.

## 1.0.7

- Date: 2026-11-15
- SHA-256: `c1858c9ece4c9fc91e674706050597fea2257b1d5ad00d9ba16edb6b1065b357`
- Pins: `@odingard/guardian-sdk` 0.6.1. The other pins are unchanged from 1.0.6.
- Pins the sdk 0.6.1 release (adds the `guardian-sdk verify` command). No other change.

## 1.0.6

- Date: 2026-11-14
- SHA-256: `93766f4b51833dabed764ace7cc94b86e8512bf80ee4af55b5475e79fdf493b0`
- Pins: `@odingard/guardian-hook` 0.4.1; `@odingard/guardian-openclaw` 0.1.2; `odingard-guardian` 0.4.0. The other pins are unchanged from 1.0.5.
- Pins the guardian-hook 0.4.1, guardian-openclaw 0.1.2 and Python 0.4.0 release (refusals name the request; a lost redemption answer is looked up). No other change.

## 1.0.5

- Date: 2026-11-14
- SHA-256: `809c721d459eee6d281a8a9e30394a97af307220e51985d1dcaff8b6a5362322`
- Pins: unchanged from 1.0.4.
- Wording for Codex CLI, DeepSeek Harness and Hermes. Two sentences in 4C shortened. No other change.

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
