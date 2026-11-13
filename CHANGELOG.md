# Changelog

## sdk 0.6.0 / guardian-mcp 0.5.0 / guardian-langchain 0.6.0 / guardian-vercel-ai 0.6.0 / guardian-openai-agents 0.4.0 (unreleased)

### Added: dollar amounts on tools (`amountArgs`, `--amount-arg`)

Guardian can now put a dollar limit on a tool you register: name the argument that holds the amount, and Guardian reads it from each call and allows the call up to a limit, asks a person above it and blocks it above a maximum. For a tool Guardian sends itself the limit applies to what reaches the tool, and for a tool your agent's own process runs it applies to Guardian's decision, not to what that code runs. Every tool on the same connection needs an amount (or none does); put tools that spend money on their own connection.

- **`@odingard/guardian-sdk` 0.6.0.** New `amountArgs` option (on `createGuard`, `guard`, `createGuardianContext` and every wrapper that takes the SDK's options): per tool, the amount declaration the owner set on that tool in the Guardian console, `{ argument, unit: "minor" | "major", currency: "usd" }`, optionally with `currencyArgument` and `allowedArguments`. On each call of a declared tool the SDK sends the declaration and the amount it reads from that top-level argument, in cents, and Guardian reads the amount from the arguments itself and decides on it. A call whose amount cannot be read is sent without an amount and Guardian blocks it; a declaration that differs from the owner's is refused before any decision, and the SDK's error names the declaration it sent. Cents are a whole number (`2000` or `"2000"`); dollars are a whole number (`20`) or text with up to two decimals (`"19.99"`); a JSON number with cents (`19.99`), a sign, `$`, commas, spaces, leading zeros or an exponent are refused. Currency: US dollars. Guardian reads one argument: by setting it, the owner states that this argument sets the charge, and Guardian can't see other arguments (a quantity, a tip) that change it; `allowedArguments` blocks calls that carry an argument the owner did not list. Without a `currencyArgument`, the owner also states that the tool charges in US dollars; Guardian can't check that. Every tool on the same connection needs an amount (or none does); put tools that spend money on their own connection. An invalid declaration throws when the tool is wrapped. The contracts (`@odingard/guardian-sdk/contracts`) add `ToolAmountDeclarationSchema` and `readToolAmount`, and `GuardianToolInvocation` takes `amountArgument` and `valueCents`.
- **`@odingard/guardian-mcp` 0.5.0.** `guardian-mcp proxy` takes `--amount-arg <tool>=<argument>:<minor|major>` (repeatable, one per tool), or `--amount-arg '<tool>=<JSON declaration>'` for a currency argument or an allowed-arguments list; in code, `createGovernedProxy({ amountArgs })`. Each call of a declared tool carries the declaration and the amount it reads, and Guardian decides on that amount: a held call is forwarded once after approval, and a call whose amount cannot be read, or whose declaration is not the owner's, is refused and nothing is forwarded. The upstream MCP server runs the tool, so the limit applies to Guardian's decision; the proxy forwards the arguments Guardian decided on. One upstream server is one connection, and every tool on it needs an amount (or none does): a server that also lists tools without an amount (a search, a list) can't get a dollar limit, so put tools that spend money on their own connection. Without a currency argument, the owner also states that the tool charges in US dollars; Guardian can't check that. A malformed or invalid `--amount-arg` is refused at start with a message that says what to fix. Works with stdio and remote upstreams. Needs `@odingard/guardian-sdk` `^0.6.0`.
- **`@odingard/guardian-langchain` 0.6.0.** Passes `amountArgs` to the SDK unchanged: each call of a declared tool carries the declaration and the amount, in `remote` mode (the default) and in `inProcess` mode, and an invalid declaration throws when the tool is wrapped. In `remote` mode Guardian sends the call, so the limit applies to what reaches the tool; in `inProcess` mode your code runs the tool, so the limit applies to Guardian's decision. Needs `@odingard/guardian-sdk` `^0.6.0`.
- **`@odingard/guardian-vercel-ai` 0.6.0.** Passes `amountArgs` to the SDK unchanged: each call of a declared tool carries the declaration and the amount, in `remote` mode (the default) and in `inProcess` mode, and an invalid declaration throws when the tools are wrapped. In `remote` mode Guardian sends the call, so the limit applies to what reaches the tool; in `inProcess` mode your `execute` runs the tool, so the limit applies to Guardian's decision. Needs `@odingard/guardian-sdk` `^0.6.0`.
- **`@odingard/guardian-openai-agents` 0.4.0.** Passes `amountArgs` to the SDK. In the default `inProcess` mode your `execute` runs the tool, so the limit applies to Guardian's decision, not to what your code runs. An entry keyed by the name you wrote is moved to the name the Agents SDK gives the tool (`buy-item` becomes `buy_item`); two entries that disagree for one tool are refused when the tool is built, as is an invalid declaration. A refused call tells the model it was denied and did not run. Needs `@odingard/guardian-sdk` `^0.6.0`.
- **Not changed: `@odingard/guardian-hook`, `@odingard/guardian-openclaw`, `@odingard/guardian-x402`, `@odingard/guardian-ap2` and the Python SDK (`odingard-guardian`).** They do not send amount declarations, so a tool the owner gave an amount in the console is refused through them, as it is through any earlier version of the packages above. In this repository the SDK version ranges of guardian-hook, guardian-steel, guardian-x402 and guardian-ap2 also accept `^0.6.0` so the workspace installs; their published versions are unchanged.
- **skill.md 1.0.4.** Pins these versions (hash in `skill/CHANGELOG.md`) and says the MCP package and the wrappers take the SDK as `^0.6.0`.

## guardian-openclaw 0.1.1, released 2026-11-12

### Changed: an OpenShell credential placeholder stays in the Gateway environment

- **`@odingard/guardian-openclaw` 0.1.1**: keep an OpenShell credential placeholder in the Gateway environment so NVIDIA NemoClaw in-place Gateway restarts keep Guardian configured. Raw credentials are still removed.
  - Kept only when `GUARDIAN_AGENT_CREDENTIAL` is exactly the placeholder OpenShell issues for that variable (`OPENSHELL_PLACEHOLDER_RE`: `openshell:resolve:env:` then `v<N>_` or `s<64 hex>_`, then `GUARDIAN_AGENT_CREDENTIAL`). The canonical form with no revision, another key's placeholder and anything with extra text are treated as raw and removed. A key named in `<cwd>/.env` is still ignored and removed, whatever its value.
  - The plugin logs once at registration that it kept an OpenShell placeholder; it never logs the value.
  - Every process the Gateway starts, `exec` commands included, now inherits the placeholder. OpenShell resolves it only on the provider profile's endpoints, and the network policy's binary allowlist decides which programs can reach them; the README's new "NVIDIA NemoClaw (OpenShell)" section says what that allows, and that NemoClaw needs the opt-out mode, which is not tamper-proof.
- **skill.md 1.0.3** pins `@odingard/guardian-openclaw` 0.1.1 (hash in `skill/CHANGELOG.md`).

### Docs: Guardian with NVIDIA NemoClaw (guide)

- **`examples/nemoclaw/`** (new): how to add `@odingard/guardian-openclaw` to an OpenClaw agent running in an NVIDIA NemoClaw sandbox, verified end to end on Guardian staging with NemoClaw `v0.0.143`, OpenShell `0.0.116`, OpenClaw `2026.10.5` and plugin 0.1.0: an allowed `shell` call ran, a destructive one waited for a person and ran once after approval, and one on a connection set to Off was refused with no prompt. Each left a receipt that verifies. The guide's files name the production host, which was not part of that run.
  - The Guardian agent credential is registered with `nemoclaw credentials add` and stays outside the sandbox; the Gateway sees only OpenShell's placeholder.
  - One egress rule (`guardian-api.yaml`, a NemoClaw custom policy preset): the Guardian API host on 443, the four agent API paths, binary `/usr/local/bin/node` (what OpenShell sees the Gateway as). The guide says what that allows: any Node.js process in the sandbox can reach those paths and propose actions as the agent, but cannot approve them.
  - The plugin runs in its opt-out mode (`GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1`), because NemoClaw keeps the OpenClaw config writable by the Gateway's user. In this mode the agent can switch Guardian off; the guide says plainly that this setup is not tamper-proof and that a protected install is not possible in NemoClaw today.
  - Covers the plugin install inside `nemoclaw <sandbox> connect` (no `--force`), the device scope approval by request id, restarts (0.1.0: stop then start), what a user sees for each outcome, the messages that can be ignored, and what is not governed.
- `packages/openclaw/README.md`, "NVIDIA NemoClaw (OpenShell)": updated with what the verified setup showed (the Gateway calls Guardian as `/usr/local/bin/node`; the state directory's `.env` route, the stop/start route on 0.1.0 and the `nemoclaw credentials add` route are confirmed; paths under `/sandbox` go to Ask).
- Root README: "NVIDIA NemoClaw (guide)" row.
- 2026-11-13: the setup was repeated by a second person on a fresh machine, and plugin 0.1.1 was verified on the same setup, including an in-place Gateway restart. The guide and the plugin README now say so.

## guardian-ap2 0.1.0

### Added: AP2 (Agent Payments Protocol v0.2) mandates

- **`@odingard/guardian-ap2` 0.1.0** (new; tested, not yet proven live): Guardian decides AP2 v0.2 closed Checkout and Payment Mandates before the agent key signs them, through the guard, with pinned merchant keys. Tested in USD.
  - Human not present (`pay`): reads and verifies the open mandates (pinned Trusted Surface keys, exact `vct`, known constraints only, `cnf` = the agent key, not expired) and the merchant-signed `checkout_jwt` (pinned merchant keys). The closed pair is built from verified data: payee = the checkout merchant, amount = the checkout total, `transaction_id` = SHA-256 of `checkout_jwt`.
  - Each pair is proposed as `tool.invoke` on `ap2.pay` (or `ap2.pay.above_cap`) with the full canonical terms and their JCS digest. ASK waits for a person; ALLOW is redeemed with `execute` before anything is signed. The guard builds each `kb+sd-jwt` hop itself and signs only bytes that decode to the approved hop, each hop once, within 30 s; each chain is presented once.
  - A person must approve above `askAbove`, for a currency with no cap, and for the first payment under an open mandate not approved through `delegate()`; a rule ALLOW is refused there. Above `max`: refused locally. Open-mandate `exp` and checkout `expires_at` are checked again after the decision, before signing.
  - Ledger per open mandate (developer-supplied compare-and-set store): single use, `agent_recurrence` frequency and `max_occurrences`, `budget` (only exact cents in an exponent-2 currency). A new pair is refused outright while an earlier pair from the same open mandate has no verified receipt (AP2 Autonomous mode). A pair is released only by a verified Error Payment Receipt, or a verified Error Checkout Receipt before the payment mandate was presented; receipt issuer keys are pinned per role (merchant, processor). A Success after a release counts and is flagged.
  - Does not conform to the AP2 v0.2 requirement to present only the needed open-mandate disclosures: chains carry every disclosure the Trusted Surface issued.
  - `delegate()` gates the request to the Trusted Surface for open mandates (`ap2.delegate`, `ap2.delegate.recurring`; always a person) and checks what the Trusted Surface returns. `payHumanPresent()` checks that what the user signed is what was approved. `recordReceipt()` verifies Checkout and Payment Receipts against pinned keys.
  - Refused, not ignored: AP2 v0.1 shapes, other `vct` versions, unknown constraints and fields, float or out-of-range amounts, unknown currencies, delegation chains deeper than Trusted Surface to agent.
  - Not the AP2 Trusted Surface and no substitute for it. Never holds or signs with a key. Decision-gated, not enforced outside the agent's process: signing with the agent key directly is not governed. Console USD caps and budgets do not apply to AP2.
- `examples/ap2/simulated-payments.mjs` (SIMULATED: stand-in Guardian, Trusted Surface, merchant and processor, throwaway keys, no network).

## guardian-x402 0.1.0

### Added: x402 payments

- **`@odingard/guardian-x402` 0.1.0** (new): Guardian decides x402 payments made through the guarded official x402 clients, before the wallet signs. The guard builds the official x402 TypeScript clients (`@x402/*` 2.30.x): `guardedFetch` (`wrapFetchWithPayment`), `guardedAxios` (`wrapAxiosWithPayment`) and `guardedMcpClient` (`x402MCPClient`).
  - Each payment is proposed as `tool.invoke` on `x402.pay` (or `x402.pay.above_cap`) with the exact terms: network, asset, amount in atomic units and as "0.01 USDC", `payTo`, `maxTimeoutSeconds`, EIP-712 domain, resource URL and the original request. ASK waits for a person inside the payment; ALLOW is redeemed with `execute` before anything is signed.
  - A wrapped signer signs only EIP-3009 `TransferWithAuthorization` typed data that matches the approved terms field by field, once, within 30 s. It refuses other typed data and all transactions.
  - Local `max`, `askAbove` and optional `payTo` allowlist per asset, in atomic units. Above `askAbove`, a repeat payment while an earlier authorization is still live, or an asset with no limit: a person must approve; a rule ALLOW is refused. Optional local budgets with a developer-supplied compare-and-set store.
  - Supported: scheme `exact`, `eip3009`, `authorization` flow, USDC on Base Sepolia; x402 v1 and v2 over HTTP, v2 over MCP. Base mainnet is off by default and unproven. Everything else is refused. x402's own `spendControls` stay on.
  - Built on `@odingard/guardian-sdk` ^0.4.1 (0.5.0 works too). While a person decides, a claim answered `RATE_LIMITED`, `DB_BUSY`, 429 or 5xx keeps the request held (nothing is signed) until it expires. An `execute` whose outcome is unknown (`outcomeUnknown`) refuses the payment and is recorded as "redeemed or unknown, not signed".
  - Decision-gated, not enforced outside the agent's process. Not governed: signing with the key directly, clients the guard did not build, payload-returning hooks added later, `callToolWithPayment` with an outside payload. Console USD caps and budgets do not apply to x402.
- `examples/x402/simulated-payments.mjs` (SIMULATED: stand-in Guardian, in-memory 402 server, throwaway test key, no network).

## sdk 0.5.0 / guardian-langchain 0.5.0 / guardian-vercel-ai 0.5.0 / guardian-openai-agents 0.3.0 / Python 0.3.0 (unreleased)

### Added: an opt-in file preview on approvals (`fileArgs` / `file_args` `preview: true`)

A content pin tells the approver the bytes cannot change after approval, not what they are. A file argument can now ask for a preview that the approval shows next to the file name: `fileArgs: { send_report: { attachmentPath: { mode: "bytes", preview: true } } }` (Python: `file_args={"attachment_path": {"mode": "bytes", "preview": True}}`). `mode` is optional in this object form and defaults to `bytes`.

- **What is sent.** The pin under `guardianContentPins` gets a `preview`, computed on your machine from the same bytes that are hashed (the file is read once). For a text file (valid UTF-8, no NUL byte, not a known binary type): `{ kind: "text", mediaType, size, text, truncated }` with the first 20 lines, at most 2,048 bytes, cut on a character boundary. Control characters other than tab and newline, direction-changing (bidi) characters and zero-width characters are replaced with U+FFFD, CRLF becomes LF and a leading byte-order mark is dropped. For pdf, images, archives, office files and anything else: `{ kind: "binary", mediaType, size }`, no content. For a file outside the argument's `previewRoots`: `{ kind: "withheld", size }`.
- **Opt-in, and privacy.** Only the object form with `preview: true` sends a preview; every existing form (a list of names, `true`, a mode string) is unchanged and sends none. With a preview, the first lines of the file leave your machine, are shown to the approver and are stored with the approval and in receipts like any other argument, also when the call is denied.
- **Preview folders (`previewRoots`).** The agent picks the path, so without a limit any file the agent process can read may be previewed if the agent names it in that argument. `previewRoots: ["/srv/reports"]` (only with `preview: true`; 1 to 16 absolute folders) previews only files whose resolved path is in one of them; any other file keeps its pin and gets `{ kind: "withheld", size }`.
- **Display only.** The preview is part of the approved arguments, so the approval and the receipt bind it, but nothing decides on it: the check just before the tool runs still compares size and SHA-256.
- **Refused when the tool is wrapped** (`CONTENT_PIN_INVALID_ARGUMENT`): a `preview` that is not a boolean, a `mode` other than `"bytes"`, `"copy"` or `"recheck"`, a `mode` of `null`, any key other than `mode`, `preview` and `previewRoots`, and `previewRoots` that are not 1 to 16 absolute folder paths without `.` or `..` segments. Previews that push a call over the 16 KB tool-arguments limit are refused (`CONTENT_PIN_TOO_MANY`), never cut silently.
- **sdk:** new exports `contentPreview`, `normalizeFileArgPreviews`, `normalizeFileArgPreviewRoots`, `PREVIEW_MAX_LINES` (20), `PREVIEW_MAX_BYTES` (2,048), `PREVIEW_MAX_ROOTS` (16) and the types `ContentPinPreview` and `FileArgOptions`; `ContentPin` has an optional `preview`. `normalizeFileArgs` / `normalizeFileArgsSpec` still return a mode per argument; `createGuardianContext` keeps `{ mode, preview: true }` (with its `previewRoots`) for an argument that asks for a preview.
- **Python:** the same option on `@guard(file_args=...)`, and on `Guard.run` with `"mode": "recheck"` (the only mode `Guard.run` takes). New exports `content_preview`, `normalize_file_arg_previews`, `normalize_file_arg_preview_roots`, `PREVIEW_MAX_LINES`, `PREVIEW_MAX_BYTES`, `PREVIEW_MAX_ROOTS`. Golden files generated from the TypeScript SDK (`npm run fixtures:python`) are checked by both test suites, so the two SDKs send the same preview for the same bytes and accept and refuse the same declarations (a `"mode": None` is refused, as TypeScript refuses `null`).
- **guardian-openai-agents:** when a renamed tool has entries under both names, entries that differ only in `preview` or `previewRoots` disagree and are refused when the tool is built.
- **guardian-langchain, guardian-vercel-ai:** pass the option through unchanged.
- langchain, vercel-ai and openai-agents now need `@odingard/guardian-sdk` `^0.5.0`. In this repository the hook and MCP packages also accept `^0.5.0` and Steel's peer range accepts it, so the workspace installs; their published versions are unchanged and not released here (their own declarations take no preview).
- **skill.md 1.0.2** pins these versions (hash in `skill/CHANGELOG.md`).

## sdk 0.4.1 / guardian-langchain 0.4.1 / guardian-vercel-ai 0.4.1 / guardian-openai-agents 0.2.1 / Python 0.2.1

### Changed: `bytes` is the default when you don't name a mode (`fileArgs`, Python `file_args`)

A file argument can now be declared without a mode, and that means `bytes`: `fileArgs: { send_report: ["attachmentPath"] }` or `fileArgs: { send_report: { attachmentPath: true } }` (Python: `file_args=["attachment_path"]` or `{"attachment_path": True}`). The reason: in `bytes` mode the tool receives the verified bytes themselves, not the path, so there is no gap between the check and the read. `copy` and `recheck` are still there when you name them.

- **No breaking change.** Explicit modes work exactly as before. The pin record (`guardianContentPins`), its fields and every reason code are unchanged, and the short form proposes the same arguments as `{ attachmentPath: "bytes" }`.
- **Refused when the tool is wrapped** (`CONTENT_PIN_INVALID_ARGUMENT`): `false` or any value other than `"bytes"`, `"copy"`, `"recheck"` or `true`; a name that is empty, dotted, the reserved key, not a string or listed twice; a declaration that is neither a list of names nor a map.
- **Where a surface cannot hand a tool bytes, the short form is never quietly downgraded:**
  - **guardian-langchain:** a tool reachable only through `invoke()` re-validates its input against its schema, so it cannot receive a `PinnedFile`. Declaring a file argument on it without a mode means `bytes` and is refused when the tool is wrapped, as an explicit `"bytes"` already was; the error names `"copy"`. Refusing is safer than switching to a weaker mode you did not choose. Tools the wrapper calls directly (`tool()`, `DynamicStructuredTool`) take the short form.
  - **Python:** `Guard.run` stays `recheck` only (its `fn` takes no arguments, so it cannot be handed bytes). A file argument declared there without a mode is refused with a message naming the `@guard` decorator and `"recheck"`, for the same reason.
  - **guardian-mcp (proxy):** unchanged. `--pin-file` / `pinFiles` take no mode and always mean `recheck`, because the upstream server opens the path itself. README only; no new release.
  - **guardian-hook:** unchanged. It pins Edit-type targets in `recheck` with nothing to declare. README only; no new release.
- **guardian-openai-agents:** when a renamed tool has entries under both names, they are compared with the default applied, so `["attachmentPath"]` and `{ attachmentPath: "bytes" }` agree; `["attachmentPath"]` and `{ attachmentPath: "recheck" }` are refused as disagreeing.
- **guardian-vercel-ai:** takes the short form (needs sdk 0.4.1).
- **sdk:** new exports `DEFAULT_FILE_ARG_MODE` (`"bytes"`), `normalizeFileArgs`, `normalizeFileArgsSpec` and the type `FileArgsDeclaration` (what `fileArgs` accepts per tool). `createGuardianContext` stores the declarations in the full form, a mode per argument. **Python:** new export `DEFAULT_FILE_ARG_MODE`.
- langchain, vercel-ai and openai-agents now need `@odingard/guardian-sdk` `^0.4.1`.
- **skill.md 1.0.1** pins these versions (hash in `skill/CHANGELOG.md`).

## Docs: setup file for coding agents (skill 1.0.0)

No package versions change.

- **New `skill.md`** at the repository root: the file a coding agent reads when the person pastes "Set up Guardian using https://odingard.com/guardian/skill.md". It detects the stack read-only, shows a plan and asks before each install, `npx` run and file write, sends the person to the console to create the agent and its credential, never handles the credential, installs pinned versions only, and runs one test that waits for an approval. Versions and SHA-256 hashes are in `skill/CHANGELOG.md`.
- **New `scripts/check-skill.mjs`**, run in CI: fails if a pinned version, environment variable, hook subcommand, hook tool name, hook matcher or status word in `skill.md` stops matching the packages and READMEs, if it names an unpinned package or a forbidden install pattern, or if a code block does not parse or type-check. `scripts/check-skill.test.mjs` feeds it mutated copies.
- Hosted agent credentials start with `gak_` and connection ids with `pcn_`; the READMEs, the MCP proxy's `--help` text and the examples now say so.
- "Set up for Claude Code" in the console creates the two coding-agent connections and allows their tools; the agent and its credential come first, from Agents → New agent. The hosted Claude Code and OpenClaw READMEs now say so, and say that a tool must be on a connection before it can be allowed, added when the connection is registered or later with "Add tools".
- The hook README's Claude Code example pins the hook version.
- The root README's OpenAI Agents SDK status now matches its package README: "Tested, but not yet proven against a live Guardian and a live model".

## sdk 0.4.0 / guardian-langchain 0.4.0 / guardian-vercel-ai 0.4.0 / guardian-openai-agents 0.2.0 / guardian-mcp 0.4.0 / guardian-hook 0.4.0 / Python 0.2.0

### Added: pin file contents in approvals (`fileArgs`, Python `file_args`)

Approval binds the exact arguments. A file path is an argument; the file's contents are not, unless you declare the argument in `fileArgs`. With `fileArgs`, the SDK on your machine reads the file, puts its SHA-256 in the approved arguments, and checks it again just before the tool runs. Guardian's servers never see the file.

- **sdk:** new option `fileArgs: { <tool>: { <argument>: "bytes" | "copy" | "recheck" } }` on `createGuard` and every adapter (plus `maxPinBytes`, default 25 MiB per file, and `maxPinTotalBytes`, default 64 MiB per call). A declared argument is a top-level argument holding an absolute path, or an array of them. The SDK adds one reserved key to the proposed arguments, `guardianContentPins`: one record per file with `arg`, `index`, `mode`, `name` (the basename, with control and bidi characters removed, at most 128 characters), `size` and `sha256`. The approval, the approval screen and the receipt bind it like any other argument. Just before the tool runs the SDK reads and hashes each file again. A changed file throws `GuardianExecutionFailed` with `reasonCode` `CONTENT_CHANGED_SINCE_APPROVAL` and `localEffectRan: false`: the tool does not run and the capability is not redeemed. A changed file needs a new proposal and a new approval. A declared, present argument with no matching pin is refused with `CONTENT_PIN_MISSING`, whoever calls `settle`.
- `bytes` passes your tool the verified bytes. `copy` passes a private copy; another process running as the same user could still change it, and the copy is deleted when your tool returns, so a tool that keeps using the path afterwards (for example a background upload) must use `bytes`. `recheck` checks the file and then lets your tool open it, so a short window remains. In `bytes` mode the tool receives a `PinnedFile` (`{ path, name, bytes, size, sha256 }`) whose `toString()` is a label, not the path.
- File paths must be absolute. The SDK does not resolve relative paths or `~`. A symlink as the last path component, a directory, FIFO, socket or device, a file under `/proc` or `/sys`, a file that changes size while it is read, an unreadable file and a file over the caps are refused before anything is proposed (`CONTENT_PIN_NOT_REGULAR_FILE`, `CONTENT_PIN_UNSTABLE`, `CONTENT_PIN_UNREADABLE`, `CONTENT_PIN_TOO_LARGE`; more than 16 pins, or arguments over the tool arguments limit with the pins, `CONTENT_PIN_TOO_MANY`; a relative path, `CONTENT_PIN_INVALID_ARGUMENT`). No request is sent, record-transport registration included.
- `fileArgs` needs `inProcess` mode. The LangChain and Vercel AI wrappers default to `remote`, where Guardian runs the tool and cannot read your files. `fileArgs` for a tool in `remote` mode is a configuration error (`CONTENT_PIN_REMOTE_MODE`) when the tool is wrapped.
- Content pinning is supported on Linux and macOS. On Windows a declared file argument is refused (`CONTENT_PIN_UNSUPPORTED_PLATFORM`).
- **Digest privacy:** the SHA-256 of each pinned file is sent to Guardian, shown to the approver and kept in receipts. For a small or low-entropy file (a token, a PIN, a short config value), anyone who sees the digest can guess the contents offline by hashing candidates. Do not pin files like that, or treat the digest as sensitive as the file.
- This stops a changed file from running under an approval given for different contents. It does not protect against code that bypasses the SDK.
- **sdk (behaviour change for every tool):** a call whose own arguments contain the key `guardianContentPins` is refused before anything is proposed (`CONTENT_PIN_KEY_RESERVED`), whether or not the tool declares `fileArgs`, so an agent cannot supply a pin of its own. Tools without `fileArgs` otherwise propose exactly the same arguments as before.
- **sdk:** `GuardianApprovalPending.input` stays the caller's input without pins (retrying with it pins the files again); the new `proposedInput` holds what was proposed, pins included. New exports: `CONTENT_PIN_KEY`, the reason-code constants, `pinFile`, `verifyPin`, and the types `PinnedFile`, `FileArgMode`, `FileArgsSpec`, `ContentPin`, `FileDigest`, `PinFileOptions`, `ContentPinReasonCode`. `GuardianContext` has a new opt-in `proposedInputs` map (used by the MCP proxy). A plain `GuardianExecutionFailed` message now ends with its `detail` when there is one.
- **guardian-langchain:** passes `fileArgs` through. `"bytes"` needs a tool the wrapper can call directly (`func` or `_call`, as `tool()` and `DynamicStructuredTool` are); a tool reachable only through `invoke()` re-validates its input against its schema, so wrapping it with `"bytes"` throws and names `"copy"` as the option.
- **guardian-vercel-ai:** passes `fileArgs` through; `execute(input, options)` receives the substituted value.
- **guardian-openai-agents:** passes `fileArgs` through. An entry keyed by the name you wrote is moved to the name the Agents SDK gives the tool (as `modes` already was), and two entries that disagree are refused. Retrying the same held call now claims the held request (the held-invocation map is shared across calls, as in the other adapters). A content-pin refusal is reported to the model as "did not run".
- **guardian-mcp (proxy):** new `--pin-file <tool>:<argument>` (repeatable; `pinFiles` in `createGovernedProxy`) declares file arguments in `recheck` mode: the upstream server opens the path itself, so a short window remains between the check and its open. Allowed only for a stdio upstream; with `--url` (HTTP/SSE) it is refused at start (`CONTENT_PIN_REMOTE_UPSTREAM`). A held call now stores the input that was proposed, pins included, and `guardian_claim` settles exactly that, so a file changed while the call was held is refused and nothing is forwarded. The upstream receives the approved copy of the arguments, without the reserved key. After a proxy restart a claim finds nothing and the agent must call again, which pins the file again.
- **guardian-hook:** for Edit, MultiEdit, NotebookEdit and DeepSeek Harness `edit`, the hook pins the target file as it is when the call is proposed (`guardianContentPins` with `arg: "path"` and mode `recheck`, or `absent: true` for a file that does not exist yet) and checks it again just before it releases the approved call. If the file changed (including created or deleted) the call is denied with `CONTENT_CHANGED_SINCE_APPROVAL` and the capability is not redeemed. The agent's own tool reads the file again after the hook returns, so a short window remains. An Edit-type call whose target path is not absolute is denied (`CONTENT_PIN_INVALID_ARGUMENT`). Write and DeepSeek `write` are not pinned; shell commands are not pinned (the command text is bound, the files it names are not). The same applies through the Claude Agent SDK entry. No tool tier changes.
- **Python:** `@guard(name, file_args={...})` with all three modes (`bytes` passes a frozen `PinnedFile` dataclass with `path`, `name`, `data`, `size`, `sha256`; `data` is left out of `repr` and there is no `__fspath__`), and `Guard.run(..., file_args={...})`, which deep-copies the `arguments` it is given. `Guard.run` supports `recheck` only; use the `@guard` decorator for `bytes` and `copy`. For a decorated tool with `file_args`, the bound arguments are deep-copied when the call is proposed and the function is called on that copy, so a mutable argument changed while the call waits does not reach it; an argument `copy.deepcopy` cannot copy is refused before proposal (`CONTENT_PIN_INVALID_ARGUMENT`). `GuardianApprovalPending.arguments` stays without pins; new `proposed_arguments` (alias `proposed_args`). For a tool with `file_args` both are copies: changing them does not change what is checked or what the function receives. A declared argument passed as `None` is refused before proposal (`CONTENT_PIN_INVALID_ARGUMENT`), as `null` is in TypeScript; a declared argument left out (a key missing from `Guard.run` arguments, or a decorated parameter not passed whose default is `None`) is not pinned and not proposed, and the function gets its default; a declared parameter with any other default is pinned like a passed value. New `Guard` options `max_pin_bytes` and `max_pin_total_bytes`; new exports `CONTENT_PIN_KEY`, the reason codes, `ContentPinError`, `PinnedFile`, `pin_file` and `verify_pin`. The OpenAI Agents helper works with `@guard(file_args=...)` tools unchanged, and reports a content-pin refusal as "did not run".
- **Not pinned:** URLs, provider file ids, paths on a remote MCP server, files named inside shell commands, and files a tool opens without naming them in a declared argument. The Steel integration, the OpenClaw plugin and the Hermes adapter do not pin the contents of files; the path is bound, the file's bytes are not.
- **guardian-steel / guardian-openclaw:** not released in this version. Steel 0.1.1 and OpenClaw 0.1.0 stay on SDK 0.3.x. In this repository Steel's peer range now also accepts `^0.4.0` so the workspace installs; its published 0.1.1 is unchanged. An app that installs Steel or OpenClaw next to a 0.4.0 package may get two copies of the SDK.

## guardian-openclaw 0.1.0

### Added: OpenClaw plugin on npm

- **`@odingard/guardian-openclaw` 0.1.0** is published to npm. Install it with `openclaw plugins install npm:@odingard/guardian-openclaw@0.1.0 --pin` and follow the README, including "Required: protect the install".
- Proven live on hosted Guardian for shell commands, on OpenClaw 2026.7.1 with a protected install: an everyday command is allowed, runs and leaves a receipt that verifies offline; a deploy command waits for approval and, once approved, runs once with the approved parameters. On staging, a denied approval, a tool set to off and an unreachable Guardian each block the call. Outbound messages, MCP tools and the other Ask-tier tools have not yet been run live.

### Changed: rate-limited and busy answers (sdk; every TypeScript adapter built on it)

These changes are in sdk 0.4.0 too, so every adapter that moves to it gets them. Python is unchanged.

- **sdk:** a claim of a held request refused with `RATE_LIMITED`, `DB_BUSY`, `HTTP_429` or `HTTP_503` now counts as not definitive, as `SERVICE_UNAVAILABLE` already did: Guardian decided nothing about the request, so it stays held, the call is refused with that reason code, and the next retry with the same arguments claims the same request instead of proposing a new one that would need a second approval. This applies to a retry of a held call with the same arguments, to `GuardianApprovalPending.resume()` (the held entry is kept for the next retry), and to held record-transport registration steps (their retry and their `resume()`). Before, any of these four answers was treated as final and the held request was forgotten.
- **sdk:** the denial message (`onDeny: "result"` output) for `RATE_LIMITED` or `DB_BUSY` now says "It can be retried after a short wait." where it said "Do not retry the same call." Every other reason code still says "Do not retry the same call."
- **sdk:** a new `hint` (on `GuardianDenied` and in the denial message) for `RATE_LIMITED` ("Guardian is rate limiting this agent. Nothing was run; retry after a short wait."), and new wording for the `PLAN_LIMIT_EXCEEDED` hint, which now names both the Free plan's monthly protected actions and the spending cap on a paid plan.

## guardian-langchain 0.3.4 / guardian-vercel-ai 0.3.4 / guardian-openai-agents 0.1.2

### Fixed: the tool runs on the arguments Guardian approved

- **guardian-langchain, guardian-vercel-ai, guardian-openai-agents:** in `inProcess` mode the wrapped tool now receives the SDK's copy of the approved input, as `createGuard` already did. Before, these three wrappers passed the tool the original arguments object. If other code holding that object (application code, middleware or a hook) changed it while the call waited for a decision or an approval, the tool ran with the changed values while Guardian's record and receipt showed the approved ones. The model could not do this through a tool call, because each call's arguments are parsed afresh; it took code in the same process holding the object. No change is needed in your code.

## sdk 0.3.9 / guardian-mcp 0.3.4 / guardian-hook 0.3.1 / guardian-langchain, guardian-vercel-ai 0.3.3 / guardian-openai-agents 0.1.1 / guardian-steel 0.1.1 / Python 0.1.6

### Changed: in-process auto-registration is off by default (read before upgrading)

- **guardian-langchain, guardian-vercel-ai and `createGuardianContext` (sdk):** `installRecordTransport` now defaults to `false`, the same as `createGuard`, guardian-openai-agents, guardian-mcp (`--auto-register` / `GUARDIAN_AUTO_REGISTER`) and Python's `Guard` (`install_record_transport`). In `inProcess` mode the adapter no longer proposes `mcp.install` on first use. Register each in-process tool once in the Guardian console as "My own code (record-only)" and allow it for the agent. If you relied on the old default, pass `installRecordTransport: true`.
- Auto-registration stays available as an opt-in, but **it only works for a tool that has no entry yet**. Which entries the SDK registered is kept in the process's memory. After a restart, in another worker or on a cold start, Guardian answers that the tool is already registered, and the call is refused with `RECORD_TRANSPORT_UNVERIFIED` and nothing runs, even for an entry the SDK created itself. Such a process must use the console-registered tool with the option off. The denial's `hint` says so.
- **Python:** with `install_record_transport=True`, an `mcp.install` answer of `TOOL_ALREADY_INSTALLED` or `INVALID_REQUEST` is now refused with `GuardianDenied` and `reason_code` `RECORD_TRANSPORT_UNVERIFIED`, with the same `hint`. Your function does not run and Guardian is not asked to perform anything. Before, `TOOL_ALREADY_INSTALLED` was treated as registered and the call went ahead, so if the existing entry made an HTTP call, your function ran and Guardian made the call too. `INVALID_REQUEST` was refused before with its own reason code. A tool a `Guard` registered itself keeps working for the life of that `Guard`.

### Changed: a failed remote call is no longer reported as success (read before upgrading)

- **sdk** (and every adapter built on it): in `remote` mode, when Guardian performs the call but the receipt status is anything other than `sent-verified` (for example the upstream answered 5xx, or the outcome is still pending), the call now throws `GuardianExecutionFailed` instead of resolving to an `ALLOW` result. The error carries the `requestId`, the receipt (`receipt`) and `localEffectRan: false`. A `not-sent` receipt has `reasonCode` `EXECUTION_NOT_SENT`; `outcome-pending`, `outcome-unconfirmed` or a missing status is an unknown outcome, `EXECUTION_OUTCOME_UNKNOWN` (see below). `onReceipt` is not called. Code that treated every resolved remote call as done will now see these calls reject.
- **sdk** (and every adapter built on it): one way to report an action that may have happened. When the execute call was sent but no usable answer came back (the connection failed, Guardian answered 5xx, or an `ok: true` answer's receipt could not be read), or the receipt is `outcome-pending` / `outcome-unconfirmed`, the SDK first looks the request up (`client.receipts(requestId)`). A verified attempt is reported as success; an attempt Guardian aborted is `EXECUTION_NOT_SENT`. Otherwise the call throws `GuardianExecutionFailed` with `reasonCode` `EXECUTION_OUTCOME_UNKNOWN`, `outcomeUnknown: true`, what was observed in `detail` (such as `SERVICE_UNAVAILABLE` or `outcome-pending`), and the message "… may have happened; do not retry; check requestId …". Before, a lost answer was the same plain failure as a refusal (`SERVICE_UNAVAILABLE`, `HTTP_200`), and a retry could repeat the action. `client.execute` now returns `outcomeUnknown: true` on such failures.
- **Python:** the same change in `remote` mode. A receipt status other than `sent-verified` raises `GuardianExecutionFailed` with `reason_code` `EXECUTION_<STATUS>` (such as `EXECUTION_OUTCOME_PENDING`) and the receipt on `.receipt`, instead of returning an `ALLOW` result. `on_receipt` is not called.
- **sdk** (and the LangChain, Vercel AI, OpenAI Agents and MCP adapters): in `inProcess` mode with record-transport registration on (`installRecordTransport: true`, or `--auto-register` for guardian-mcp), when Guardian answers `mcp.install` with `TOOL_ALREADY_INSTALLED` or `INVALID_REQUEST` (how hosted Guardian answers for a tool already registered in the console), the call is now refused with `GuardianDenied` and `reasonCode` `RECORD_TRANSPORT_UNVERIFIED`. Your code does not run and Guardian is not asked to perform anything. Before, the call went ahead. Guardian does not tell the SDK whether the existing entry is record-only, and if it is a tool that makes an HTTP call, your code ran and then Guardian made the HTTP call too, so one call acted twice. The denial's `hint` says what to do: for a tool registered in the console as record-only ("My own code (record-only)"), keep `installRecordTransport` off (now the default everywhere, see below); for a tool Guardian should perform, use `mode: "remote"`. A record entry the adapter registered itself in the same process still works: later calls only switch it on (`mcp.enable`). The same entry is refused after a restart, in another worker or on a cold start, because which entries the adapter registered is kept in memory only.
- **guardian-steel:** `submitOrder` can now return `status: "outcome-unknown"`. It means the order may have been placed: Guardian's receipt is `outcome-pending` or `outcome-unconfirmed`, or the signed receipt could not be fetched (`reasonCode: "RECEIPT_UNVERIFIED"`). Do not retry the order; check the merchant or the Guardian receipt first. Before, these cases were reported as `not-executed` (or, for an unreadable receipt, `executed`). `not-executed` without a reason code now always means the receipt is `not-sent`. Code that switches on `status` exhaustively needs the new case.
- **guardian-steel:** once the execute call has been sent, a lost, 5xx or unreadable answer (or a client that throws) is reported as `status: "outcome-unknown"` with `reasonCode: "EXECUTE_RESPONSE_LOST"` and the observed code in `detail`, instead of `failed`. The order may have been placed: do not retry it. `failed` now always means Guardian refused the redemption.
- **sdk:** the input of a governed call is copied (`structuredClone`) and deep-frozen before it is proposed. That frozen copy is what Guardian approves and what `GuardianApprovalPending.input` holds, so changing the original object, or the pending input, can no longer change what runs after approval. Your function receives its own unfrozen clone of the approved copy, made just before it runs: it may still change its input as before, and nothing outside can reach the object it runs on. Guarded inputs must be plain data: an input that cannot be cloned (for example one holding a function), or that holds a class instance whose methods a copy would lose, is refused with a `TypeError` before anything is proposed.
- **sdk** (and every adapter built on it): in `inProcess` mode, when your function has run and the execute answer's receipt is `not-sent`, the call now throws `GuardianExecutionFailed` with `reasonCode` `EXECUTION_NOT_SENT`, `localEffectRan: true`, the receipt, and the message `"<tool>" ran, but Guardian could not record it; do not retry; check requestId …`. Before, it was returned as the function's output, as if Guardian had recorded the call. `onReceipt` is not called. (`outcome-pending` / `outcome-unconfirmed` were already reported as an unknown outcome.)
- **guardian-steel:** the record port refuses a second invocation for an attempt that already reached the executor as unknown (`ATTEMPT_ALREADY_EXECUTED`, `unknown: true`), so the receipt is never `not-sent` and the agent is never told to retry an order that may exist. Nothing runs a second time.
- **sdk:** an `ok: true` request or claim answer counts as ALLOW only when `decision` is missing or exactly `"ALLOW"` and a non-empty capability token (`capabilityToken` or `token`) is present. Any other decision value (such as `"ask"` or an unknown one), or an ALLOW with no token, is a denial with `reasonCode` `MALFORMED_RESPONSE`, and nothing runs.

### Changed: a call that ran is never reported as "try again" (read before upgrading)

- **Python:** a `Guard` with `on_deny="result"` now also returns an execution failure as data instead of raising `GuardianExecutionFailed`: `{"guardian": {"decision": "ALLOW", "outcome": "ran_unrecorded" | "unknown", "reason_code": …, "local_effect_ran": …, "message": …}}`. This covers an in-process call whose receipt could not be recorded after your function ran (`outcome: "ran_unrecorded"`, the message says it ran and must not be called again) and a `remote` call whose receipt status is not `sent-verified` or whose execute answer was lost (`outcome: "unknown"`, the message says it may have run and must not be called again). The new `on_execution_failed="raise" | "result"` option sets this separately from `on_deny`, and the new `on_execution_error=callback(error)` hook receives every such `GuardianExecutionFailed` in either mode. Before, these raised, and in the OpenAI Agents SDK recipe the SDK's default `failure_error_function` told the model "Please try again", so a retry could repeat the action (for example pay an invoice twice).
- **Python:** new `odingard_guardian.openai_agents.guardian_failure_error_function` (and `make_guardian_failure_error_function(on_execution_failed=…, fallback=…)`) for `function_tool(..., failure_error_function=…)`. It tells the model that a call ran or may have run and must not be called again, that a denied call did not run, and re-raises `GuardianApprovalPending`. Other errors keep the Agents SDK's message. The README recipe uses it. `execution_failed_message(error)` gives the same text for other frameworks.
- **Python:** an HTTP 5xx answer to a request or claim is reported as `SERVICE_UNAVAILABLE` ("could not be reached … did not run"), not as a denial; it is still refused. An `ok: true` answer whose `decision` is present and is not `ALLOW`, `ASK` or `DENY` is refused as `MALFORMED_RESPONSE` and nothing runs (before, it counted as ALLOW). The hosted gateway's ALLOW answer, which carries a token and no `decision`, still allows.
- **guardian-mcp (dispatch, bare `guardian-mcp`):** only a receipt with status `sent-verified` is a plain result. `not-sent` is a tool error (`isError: true`, `outcome: "not-done"`). `outcome-pending`, `outcome-unconfirmed`, a missing status, and a refused or lost execute answer are tool errors with `outcome: "unknown"` and a message to check (`guardian_receipt`) before retrying. DENY and outages are tool errors too. Before, all of these were plain results with `decision: "ALLOW"` or `"DENY"`.
- **guardian-mcp (`guardian-mcp tools`):** a tool whose name contains a verb that changes something or sends data out, anywhere in the name (`get_or_create_customer`, `find_and_replace`, `list_and_delete_old_files`), is suggested Ask, even when the server marks it read-only. `fetch` and `status` are no longer read verbs. The README now describes the rules the code uses.

### Fixed

- **sdk:** in `inProcess` mode, a tool written as a generator (such as an AI SDK streaming tool written as an `async function*`) is run to completion before Guardian records the call, and its last value is the result. Before, the generator body never ran but the call was recorded and reported as done. A throw while it runs is reported as the tool's error and nothing is recorded. Intermediate values are not streamed. Other async iterables a tool returns, such as a `ReadableStream`, are passed back unchanged.
- **sdk:** an `onReceipt` callback that throws no longer turns a completed call into a failure (which invited a retry that repeated the action). The output is returned; the error goes to the new `onReceiptError` option, or to `console.warn` when it is not set.
- **sdk:** with `onAsk: "result"`, calling the tool again with the same arguments after a person approves now claims the approved request and runs it, instead of opening a new approval. Before approval it returns the same ASK; an outage during the claim keeps the request held. The ASK message now says to call the tool again with the same arguments.
- **sdk:** the execution receipt is read leniently: a field the client does not know no longer makes a successful execute unreadable.
- **sdk:** when an `inProcess` call ran but Guardian refused to record it, the `GuardianExecutionFailed` message now reads `"<tool>" ran, but Guardian could not record it; do not retry; check requestId …` instead of `Guardian execution of "<tool>" failed`, so a model shown the error is not invited to repeat the action. `reasonCode` and `localEffectRan` are unchanged.
- **guardian-openai-agents:** a call whose outcome Guardian could not confirm (`outcomeUnknown`) tells the model `Guardian could not confirm that <tool> completed (…). It may have run. Do not call it again…` instead of `Guardian could not complete <tool>`.
- **guardian-mcp (`proxy`):** a call that was forwarded but whose record Guardian could not confirm carries `outcomeUnknown: true` and tells the agent not to call it again and to check the requestId with `guardian_receipt`, instead of saying Guardian refused to redeem the capability.
- **guardian-steel:** the executor accepts an order confirmation only if it shows the authorized merchant, SKU, quantity, total and currency. Anything else is `ORDER_NOT_CONFIRMED` (possibly placed, reported as unknown). The result is built from the values the merchant confirmed, and the checkout form is now also filled with the SKU and quantity.
- **guardian-hook:** shell commands are now parsed before they are routed, and the riskiest command inside decides. The hook removes quotes and escapes, splits on `;`, `&&`, `||`, `|`, newlines and subshells, and looks inside `$( )`, backticks, `<( )`, `sh -c`/`bash -c` strings, `eval`, `su -c`, `env -S` and `find -exec`. It also looks past wrappers (`sudo`, `doas`, `env`, `xargs`, `nice`, `nohup`, `time`, `timeout`, `stdbuf`, `exec`, `command`, `watch`, `npx`), git global options (`-C`, `-c`, `--git-dir`, `--work-tree`) and git aliases given with `-c alias.*`. As a result:
  - `rm -rf` reached through `xargs` (`find . | xargs rm -rf`, `xargs -0 rm -rf`) and `rm -rf` with no operands are `shell_destructive`. So is any `rm` run by `find -exec`/`-ok` or `xargs`.
  - Force pushes written with global options (`git -C dir push -f`), `-fu`, `--mirror`, `--prune`, and remote branch deletes (`git push origin :branch`, `--delete`, `-d`) are `shell_destructive` (they were `shell` or `git_push`). `git branch -d -f`, `git checkout -f`, `git switch --discard-changes`, `git stash drop`/`clear`, `git reset --merge`, `git update-ref -d`, `git reflog expire` and `git filter-branch` are now included. `git -c core.pager=…` and other config values that git runs as commands are routed by their command.
  - `dd … of=`, `rsync --delete` (and `--delete-*`, `--remove-source-files`) and `truncate` to size 0 are `shell_destructive`.
  - `chmod -R` to a world-writable mode (`777`, `a+rwx`), and a download piped or substituted into a shell or interpreter (`curl … | sh`, `bash <(curl …)`, `sh -c "$(curl …)"`), are `shell_destructive`.
  - Changes to the agent's own MCP servers, hooks or permissions are `shell_destructive` (Ask tier): `claude mcp add`, `add-json`, `add-from-claude-desktop`, `remove` and other non-read `claude`/`codex`/`gemini` `mcp`, `plugin` and `config` subcommands; a nested `claude` or `codex` run with options that widen its tools or permissions (`--mcp-config`, `--settings`, `--dangerously-skip-permissions`, `--permission-mode` other than `default` or `plan`); and writes to `.mcp.json`, `mcp.json`, `~/.claude.json`, `settings.local.json`, `.claude/settings*.json`, `.claude/hooks|agents|commands|skills|plugins`, `.codex/`, `.cursor/`, `.gemini/`, `guardian-hooks.json` and similar files, by shell redirection, by commands such as `cp`, `mv`, `tee`, `sed -i` or `ln`, or by the `Write`, `Edit`, `MultiEdit`, `write`, `edit`, `str_replace_editor` and `apply_patch` tools. Those file-tool calls carry `touches: "agent-config"`. Reading these files (`cat`, `jq`, `grep`, `git diff`) stays `shell`.
  - Commands the hook cannot follow go to `shell_destructive` (Ask tier) instead of `shell`: an unterminated quote or substitution, a command name known only at run time (`$CMD …`, `$(…) …`), `eval` or `sh -c` of run-time text (including `eval "$(tool init)"`), `case` statements, and nesting deeper than 12 levels.
  - Commands routed before are routed the same way, except that some move from `git_push` or `shell_session` to `shell_destructive`, which is also Ask tier.
- **sdk:** a refusal keeps Guardian's `requestId`, on the thrown `GuardianDenied` and in `onDeny: "result"` output, so a denial can be traced to Guardian's record of it.
- **sdk:** after a fresh registration, the adapter now also proposes `mcp.enable` through the same ALLOW/ASK/DENY gate, so the next call is no longer refused because the tool was never switched on. `TOOL_ALREADY_ENABLED` or `INVALID_REQUEST` goes on to the tool call.
- **sdk:** a registration step (`mcp.install` or `mcp.enable`) held for approval is claimed when the tool call is retried, with `onAsk: "result"` or when a caller retries instead of calling `resume()`. After the person approves, the retry uses that approval and runs the call; before then it returns the same ASK and creates no second approval. An outage while claiming, or a claim that throws, keeps the step held, whether the claim came from a retry or from `resume()`, so the next try claims the same approved request instead of asking for a new one.
- **guardian-langchain:** `guardianTools` now keeps each tool's `returnDirect` setting, as `guardianTool` already did.
- **guardian-vercel-ai:** the AI SDK's `abortSignal` is honoured. An aborted call rejects at once instead of waiting for a Guardian that never answers. If an ALLOW arrives afterwards, the local tool does not run (`inProcess`) and Guardian is not asked to perform the call (`remote`). Once the tool has started (the local tool runs, or Guardian has been asked to perform the call), an abort no longer rejects early: the call waits for the real outcome, so a started action is never reported as not done.
- **guardian-openai-agents:** when Guardian cannot be reached (the SDK client reports `SERVICE_UNAVAILABLE`), the model is told `Guardian could not check <tool>, so it did not run. Try again later.` instead of "denied, do not retry", and `onGuardianError` is called.
- **guardian-openai-agents:** executing a record-transport `mcp.enable` step no longer counts as the tool starting, so the decision timeout and the abort signal still apply to the tool call after it (as they already did after `mcp.install`).
- **guardian-mcp (proxy):**
  - An outage is reported as "Guardian could not be reached … Try again later", not as "Guardian denied … Do not retry". `decision` stays `DENY` and `reasonCode` stays `SERVICE_UNAVAILABLE`, so nothing is forwarded.
  - Refusals and outages are now MCP tool errors (`isError: true`), so the client and the model see that the call did not happen.
  - A refusal keeps Guardian's `requestId`.
  - An outage while calling `guardian_claim` keeps the call held, so the claim can be retried.
  - An allowed call's result now carries Guardian's `requestId` under `_meta["com.odingard/guardian"]`. The upstream's `content` is unchanged.
  - With `--auto-register`, after `guardian_claim` completes a held first-use registration, the retry switches the tool on for the agent (`mcp.enable`, which may need its own approval) before the call, instead of skipping that step and being refused. It does not propose the registration again.
- **guardian-steel:**
  - On a Guardian with no protected Steel executor (standard hosted Guardian today), a recorded call is reported as `not-executed` with `NO_PROTECTED_EXECUTOR`, never as `executed`.
  - In the executor's evidence, a page failure after the buy button was clicked is reported as `SUBMIT_OUTCOME_UNKNOWN` (the order may exist), not as "not submitted". The evidence's `outcome` field has a new value, `"unknown"`, used for this case and for an order the merchant did not confirm (`ORDER_NOT_CONFIRMED`, previously `"refused"`). The dispatcher reports these as `outcome-unknown` (see above). `createSteelToolRecordPort` now returns `{ ok: false, reason, unknown: true }` for these, so a Guardian host records an unknown outcome instead of a rejection.
  - A browser setup failure after connecting now closes the socket and releases the Steel session.
  - The peer dependency is now `@odingard/guardian-sdk ^0.3.9`; 0.1.0 could not be installed alongside the current SDK.
- **Python:** with `on_ask="result"`, calling the tool again with the same arguments after a person approves now runs the approved request, instead of proposing a new one that needs another approval. Calling it again before then returns the same ASK and creates no second approval; a Guardian outage during that check keeps the request held. The same holds for a registration (`install_record_transport`) held for approval. With `on_deny="result"`, an outage says Guardian could not be reached and to try again later, instead of "denied, do not retry". A refusal keeps Guardian's `request_id`.

- **guardian-langchain:** the call's input is parsed once. The wrapper sends the parsed value to Guardian and calls the wrapped tool's own function (`func` / `_call`) with that same value, instead of `invoke`, which parsed it again. A schema that transforms its input (for example dollars to cents) ran the tool with different arguments than Guardian approved. A streaming tool is run to completion before the evidence is recorded. The wrapper now reports to LangChain callbacks as one tool run.
- **guardian-langchain:** `config.signal` (and `config.timeout`) is honoured, as in guardian-vercel-ai. An abort before the tool starts rejects at once, and a late ALLOW neither runs the local tool (`inProcess`) nor asks Guardian to perform the call (`remote`). Once the tool has started, an abort no longer rejects early or leaves the call hanging: it waits for the real outcome and records it. The wrapped tool does not receive the signal.
- **guardian-mcp (proxy):**
  - A cancelled or timed-out `tools/call` is not forwarded if the cancel arrives before the call is sent upstream, for example while Guardian is still deciding, and its capability is not redeemed. A cancelled `guardian_claim` keeps the call held together with the approval it claimed, so the next `guardian_claim` forwards it without a second approval. Once sent upstream, a call runs to its real outcome.
  - A second `guardian_claim` of a `requestId` that was already forwarded is answered "already forwarded, do not propose it again", with the earlier result when the first claim has finished, instead of "Nothing was forwarded". The proxy remembers the last 1000 claims. An unknown `requestId` is answered "this claim forwarded nothing", with a reminder to check `guardian_receipt` if it was claimed before.
  - An unexpected proxy error after the call was forwarded says it may have run, not that it was not forwarded.
  - Diagnostics scrub each query value of a remote upstream URL as typed (with its `+`), percent-decoded and with `+` read as a space. Before, a key containing `+` could reach stderr.
- **guardian-openclaw:** `apply_patch` classifies every file header, not only the first 50, so a config or state path after the 50th sends the call to the Ask tier. The arguments still list the first 50 files and add `morePaths` (the count of the rest) and `controlPlanePaths`.
- **guardian-openclaw:** a `read` of a start-up env file (`.env`, `.env.*`, `gateway.env`) in the state directory, a control root, `~/.config/openclaw` or above the workspace goes to the Ask tier as `shell_destructive` (`touches: "openclaw-env-file"`).

### Docs

- README: a "Works with" table with one status per integration (proven on production, tested against Guardian with production proof pending, example not yet tested, not yet available on hosted Guardian, unpublished), and the three ways any agent can use Guardian.
- guardian-mcp: the remote (`--url`) mode is documented as shipped in 0.3.3 and tested against a real Guardian, with production proof pending. The package description no longer says every outcome carries a receipt (a plain refusal does not).
- guardian-langchain and guardian-vercel-ai: the examples register the tool in the console and pass `installRecordTransport: false`. LangChain explains how to keep approvals with LangGraph's `ToolNode`; Vercel AI shows how errors arrive as `tool-error` parts with ai v5 and later.
- guardian-steel: the live tests are described as in-process (a real Steel browser with Guardian's test code in the same process), Steel is marked as not yet available on hosted Guardian, and the outage reason code is documented as `SERVICE_UNAVAILABLE`.
- Python: framework recipes are labelled by test status, the OpenAI Agents recipe uses `on_ask`/`on_deny="result"` or `failure_error_function=None`, and the Hermes install step is marked unverified.
- guardian-openclaw: `GUARDIAN_*` settings, the credential included, belong in the Gateway's service or container environment only. The README no longer suggests `<state dir>/.env`, which the agent can read; the protection recipe keeps those files empty.

## sdk 0.3.8 / guardian-mcp 0.3.3 / guardian-hook 0.3.0 / guardian-langchain, guardian-vercel-ai 0.3.2 / guardian-openai-agents 0.1.0 / Python 0.1.5, released 2026-11-09

### Added: OpenAI Agents SDK

- **`@odingard/guardian-openai-agents` 0.1.0** (new; tested, not yet proven live): an adapter for the OpenAI Agents SDK (TypeScript, `@openai/agents` 0.21.x; tested against 0.21.0). `guardianTool` / `createGuardianTool` take the same options as the SDK's `tool()` and send every call to Guardian before `execute` runs.
  - ALLOW runs `execute` once with the arguments Guardian saw, then redeems the capability and records the receipt. ASK does not run the tool: by default the run ends with `GuardianApprovalPending` (found with `findApprovalPending`), and `pending.resume()` runs it once after a person approves; `onAsk: "result"` keeps the run going instead. DENY never runs the tool and tells the model plainly.
  - Fails closed: a Guardian error, network failure, timeout or cancelled call never runs the tool, and a late answer is ignored. Text the model writes is never read as a decision.
  - Two modes: `inProcess` (default, your `execute` runs after ALLOW) and `remote` (Guardian performs the call itself).
  - Not governed: hosted tools, computer, shell and apply-patch tools, handoffs and agents used as tools.
  - Tested against the real Agents SDK runner with a scripted model and a stubbed Guardian client. **Not yet proven against a live Guardian and a live model.**

### Added: Codex and DeepSeek Harness

### Not governed by the Codex and DeepSeek Harness hooks (read before relying on it)

- **Codex `write_stdin`**: Codex runs no hook for input typed into an open unified-exec session, so commands typed into a `bash` started with `exec_command` skip Guardian. Starting the session is Ask tier (`shell_session`); turn unified exec off (`[features] unified_exec = false` in a managed `requirements.toml`) to close the gap.
- The shell routing is a local pattern match: an obfuscated command (quoting, `git -C . push -f`, escapes, base64) can land in the Allow tier.
- A missing or unparseable hook config (Codex `hooks.json`, dsh `guardian-hooks.json`) governs nothing; an Allow-tier file edit can rewrite it unless it is managed or read-only.
- Codex and the dsh bridge both **let a call run when the hook process fails** (crash, timeout, cannot start). The hook turns every failure it sees into a deny, and the documented command ends in `|| … exit 2` so a hook that cannot start blocks; a hook killed from outside still fails open.
- Codex: hosted tools (`WebSearch`), other local tools, and tool paths Codex runs without hooks. dsh: every tool the matcher does not name, including `run_code` itself, `subagent`, `workflow`, `plugin_manager`, `load_workspace_dependencies`, `stagehand_act`/`stagehand_navigate`, `send_message`, `job_*`, `schedule_*`, `web_search`, read-only tools; `terminal_send` is checked per message.
- Not yet confirmed live: hooks under Codex's `--dangerously-bypass-approvals-and-sandbox`; the dsh bridge in a hosted dsh image and its tool names as passed to hooks.

### Added: OpenClaw

- **`@odingard/guardian-openclaw` 0.1.0** (new, unpublished): a native OpenClaw plugin. Its `before_tool_call` hook, registered with no matcher, sends every consequential tool call to Guardian before it runs.
  - Shell commands use guardian-hook's classifier (`shell`, `shell_deploy`, `shell_destructive`, `git_push`). File edits become `file_write` with a digest. `web_fetch` maps directly, MCP tools become `mcp.<server>.<tool>` (Composio included), and every other tool becomes `openclaw.<tool>` on the Ask tier. Only a short list of read-only tools is skipped.
  - ALLOW redeems the capability, then runs the call with exactly the parameters Guardian saw. ASK waits for a person in Guardian; OpenClaw's own `/approve` is never the authority. DENY and every failure return `block: true`.
  - Fails closed on missing config, an unreachable Guardian, a crash, a timeout, a cancelled call, or a non-string command, path or URL. It never claims or redeems after OpenClaw's hook timeout, and it reads the operator's `hooks.timeouts.before_tool_call` (set it to 330000 ms).
  - The credential comes only from the Gateway environment, is removed from `process.env` so `exec` children do not inherit it, and is never logged.
  - Loaded by OpenClaw 2026.7.1's plugin loader (`npm-pack:` install, `plugins inspect --runtime`) and run through its real tool-hook wrapper. **Not yet proven live on a hosted agent.** The README lists what is not governed.
  - Security review fixes: `process` input is classified from the exact bytes OpenClaw writes (`data`, `text`, `literal` + `hex` + `keys`), a decoy field blocks the call, and process input is never on the everyday tier (`openclaw.process_input`). Calls that drive the `openclaw` CLI or change `openclaw.json`, the OpenClaw state directory or the plugin's files go to the Ask tier as `shell_destructive`, because OpenClaw hot-reloads its config and one everyday call could otherwise switch Guardian off. An `exec` with env overrides is never everyday. Code Mode's `exec` is governed as `openclaw.code_mode_exec`. Obfuscated commands can still get past these patterns; the README says how to close that (make the config unwritable by the user exec runs as).
  - Path fixes: `write`, `edit`, `apply_patch`, `read` paths and the `exec` `workdir` are matched both raw and normalised as OpenClaw 2026.7.1's file tools resolve them (leading `@` dropped, unicode spaces, `file://` URLs decoded with percent-escapes, `~` expanded, `.`/`..` collapsed), with a segment-wise, case-insensitive state-directory match. A path that cannot be normalised (a bad `file://` URL, a `file://` URL with a host other than `localhost` or an encoded `/`, any other `scheme://`, a NUL byte) fails closed to the Ask tier and is flagged `pathUnresolved`, for `read` too. An `exec` whose `workdir` is in the state directory or a control root is Ask tier. The `openclaw` CLI is recognised quoted or escaped (`"openclaw"`, `o'p'enclaw`), and `plugins.entries.guardian` and `plugins disable|uninstall|remove …guardian` are Ask tier whatever runs them. Control roots from the environment expand `~`, are normalised and are matched case-insensitively (macOS APFS). The legacy `~/.clawdbot` state directory and `clawdbot.json` are control plane too. `apply_patch` headers with leading whitespace are read, as OpenClaw trims header lines. Any `exec` that creates a symbolic or hard link (`ln`, `link`, `cp -s`/`-l`, `mklink`, `-ItemType SymbolicLink`, `symlink`/`link` calls in Python, Node, Perl, Ruby) is Ask tier, so `ln -s .. s` then `write s/extensions/guardian/index.js` is no longer two everyday calls.
  - **Install integrity (new primary defence, fail closed).** Security review kept finding everyday ways for the agent to disable Guardian by changing OpenClaw's state directory, because its default workspace is inside it (`mv ../extensions/guardian x`, `cp -r evil/. ..`, `tar -C ..`, `git --work-tree=..`, pathlib `symlink_to`, `cp --sym`, `FileUtils.ln_s`, `perl -e 'symlink …'`). Pattern matching cannot close that class, so tamper-resistance is now a deployment precondition the plugin enforces: on load and before every tool call (cached at most 5 s) it checks whether the OpenClaw process user can change the plugin's own directory (real path, every file), `<state>/extensions/guardian`, the OpenClaw config OpenClaw would load (`OPENCLAW_CONFIG_PATH`, or the candidates up to the first existing one, `openclaw.json5` beside it), `<state>/extensions/`, the start-up dotenv files (`<config dir>/.env`, `~/.config/openclaw/gateway.env`), and every parent directory that would let it rename them. Owned entries count as writable (the owner can `chmod`) unless immutable or on a read-only mount; a Gateway running as root always fails; errors count as writable. While any is writable, every tool call is blocked and Guardian is never asked; the message says how to fix it. The README has a "Required: protect the install" section with the commands for the official OpenClaw container image.
  - Opt-out: `GUARDIAN_OPENCLAW_ALLOW_WRITABLE_INSTALL=1`, read once from the Gateway's environment at load, keeps the pattern-based behaviour and logs one warning. In that mode the agent can switch Guardian off; the README says not to claim it as tamper-proof.
  - Pattern backstops added for the misses above: pathlib `symlink_to` / `hardlink_to`, `cp --s…` / `--l…` abbreviations, `FileUtils.ln*`, any `symlink` / `link` / `ln_s` word in inline interpreter code, and `..` path operands in `exec` commands whose cwd may be the workspace (Ask tier).
  - Install integrity, second pass. **The plugin is now self-contained:** `dist/index.js` bundles the Guardian SDK and zod (no `--external`; the SDK moved to `devDependencies`) and imports only Node.js builtins, so nothing it loads sits outside the checked plugin directory (an `npm:` install used to put the SDK in a sibling `node_modules/@odingard/guardian-sdk` the agent could rewrite). A test builds with the real build command and fails if the output imports anything else. As a second line, the check resolves every non-builtin import in the plugin's entry files and `package.json` dependencies from the plugin's real path as Node.js would, and checks the package found, its parents, and every nearer `node_modules` where a shadowing copy could be created; an import it cannot find blocks. **The real install locations are covered:** OpenClaw 2026.7.1 puts `npm:` / `npm-pack:` installs in `<state>/npm/projects/<name>/node_modules/@odingard/guardian-openclaw` and local-path installs in `<state>/extensions/guardian`; the check now requires the whole `<state>/npm` tree and `<state>/hooks` (managed hooks, imported into the Gateway) to be unwritable, or impossible to create. The README's official-image recipe now protects `npm/` and `hooks/` too, and was run end to end on a real 2026.7.1 layout as uid 1000 (install, check failing, recipe as root, check passing, `plugins inspect --runtime` loading the hook, tamper attempts refused); not on a hosted deployment. **The Gateway's working-directory `.env`** (which OpenClaw loads, without filtering `GUARDIAN_*`) is now checked like the other start-up env files, and any `GUARDIAN_*` key named in it (the opt-out, the credential, the connection ids and the other settings) is ignored with a warning: Guardian settings are honoured only from the Gateway's real start-up environment or the protected `<state>/.env`. **Not governed, now documented:** OpenClaw's state database `<state>/state/openclaw.sqlite`, which the Gateway must write, holds the installed-plugin index; rewriting the `guardian` entry there made OpenClaw 2026.7.1 load a different directory as `guardian` (checked by running it), so an agent that can write it and get the Gateway restarted can swap Guardian out. The mitigation is to run the agent's tools as a different user or in OpenClaw's sandbox. Workspace-origin plugins and hooks (disabled by default) are listed as not checked.
  - Install integrity, third pass (root upkeep and npm). The official-image recipe left `$HOME` (`/data`) group-writable for `node`, so the Gateway user could create `/data/.npmrc` and owned `/data/.npm`; the documented upkeep ran `HOME=/data openclaw plugins install/update` as root, and OpenClaw 2026.7.1 runs npm with the caller's environment and no `--userconfig` (and drops any `npm_config_cache` it is given), so root would install from a registry `node` chose and the re-lock would make the result root-owned. The check now also covers the npm user config (`$HOME/.npmrc` or `npm_config_userconfig`) and global config (`<node prefix>/etc/npmrc`, `npm_config_globalconfig`, `npm_config_prefix`), `<state>/mpm/` and `<state>/plugins/` (plugin catalogs, the legacy `plugins/installs.json`), and `openclaw.json.bak` / `.bak.*` (OpenClaw restores the config from `.bak`): each must exist read-only or be impossible to create. The recipe refuses linked paths before it `chown`s anything, writes an empty root-owned `/data/.npmrc`, removes `/data/.npm`, creates `mpm/`, `plugins/` and `openclaw.json.bak` root-owned. A new Upkeep section: as root, `HOME=/root` from `/root` with `NPM_CONFIG_USERCONFIG=/dev/null`, an empty root-owned global config (npm refuses `/dev/null` for both), `NPM_CONFIG_CACHE=/root/.npm` and an explicit registry; edit `openclaw.json` directly instead of running the `openclaw` CLI as root (it would run OpenClaw, and the plugin code the Gateway-writable state database names, as root); update Guardian by unpacking the published tarball into the plugin directory; after every upkeep compare the installed `dist/index.js` sha256 (and `diff -r`) with the tarball, then re-lock. The README says a Gateway started from a writable working directory is blocked, and lists what stays unchecked (npm's cache, builtin `npmrc`, `.npmrc` in another command's cwd, catalog paths from the environment, running the CLI as root). Recipe and upkeep re-run end to end as uid 1000 on a real 2026.7.1 layout, with a planted `.npmrc` naming another registry.
- `examples/openclaw/`: a SIMULATED run inside OpenClaw's real hook runtime (step 0 now shows a writable install blocked; the rest uses the opt-out), and the LIVE official-image recipe (`/data/.openclaw/openclaw.json`, with the new "protect the install" step).

### Added: Hermes Agent

- **Python `odingard_guardian.hermes`**: a Hermes Agent (Nous Research) plugin. `pip install odingard-guardian` registers it with Hermes as `guardian` (entry point `hermes_agent.plugins`); it stays off until listed in Hermes' `plugins.enabled`.
  - It is Hermes' `pre_tool_call` hook, which runs before every tool call. Terminal commands are split like `@odingard/guardian-hook` (`shell`, `shell_deploy`, `shell_destructive`, `git_push`); `write_file`/`patch`, `web_extract`, `execute_code`, browser tools, `computer_use`, cron changes, `delegate_task` and `mcp__<server>__<tool>` each map to a Guardian tool; any tool it does not know is governed as `hermes_other`. Read-only tools are not routed.
  - ALLOW redeems the capability, then Hermes runs the tool. ASK waits for a person, with the same final check before the window closes as guardian-hook. Every Guardian call, the redeem included, is started only if it can finish inside Hermes' `plugins.hook_callback_timeout`, so no receipt is recorded for a call Hermes already gave up on. A retry of the same call in the same Hermes process claims the open request; open requests are kept in memory only, never in a file the agent could rewrite to spend one approval on a different call.
  - Writes to Hermes' own home (`config.yaml`, `.env`, `plugins/`) or to the plugin, reading `$HERMES_HOME/.env`, and commands naming them or `GUARDIAN_*` are routed as `hermes_config` (needs approval), so the agent cannot switch Guardian off through an everyday edit. This is pattern-based; the README says what it misses.
  - The credential is moved out of `os.environ` when the plugin loads and before each call, so Hermes' tool subprocesses do not inherit it. Arguments Hermes coerces after the hook (a non-string `command`, a bare-string `urls`) are governed as their raw value, and every terminal argument (`timeout`, `pty`, …) is part of the proposal.
  - It fails closed: missing settings, a non-https URL, Guardian unreachable, a crash, a timeout or an unapproved ASK all block. Messages never include the credential or the error text.
  - Not governed: read-only tools, anything outside Hermes' tool dispatch, `HERMES_SAFE_MODE`, a failure in Hermes' own dispatcher (which Hermes treats as no block), other plugins' `modify` directives, shell commands the patterns miss (they run as `shell`), config edits through a path built at run time, a credential read from `.env` or `/proc`, and in `GUARDIAN_HERMES_MCP=proxy` mode every `mcp__*`/`mcp_*` tool not behind guardian-mcp. Not yet proven live.
- `examples/hermes/`: setup for Hermes, locally and on a host that runs one `hermes chat -q` per message, a `config.yaml` (plugin plus the `guardian-mcp proxy` recipe for MCP servers), and `hermes_hook_demo.py` (SIMULATED unless Guardian settings are set; Hermes itself is simulated).

- **guardian-hook: OpenAI Codex CLI** (`guardian-hook codex`). Governs Codex's `Bash` (shell and unified exec), every `apply_patch` file edit and MCP tools. A patch is decided on its target paths and operations (`add`, `update`, `delete`, `move`) plus a size and SHA-256 digest; the patch text is never sent. Allow prints nothing; deny prints the deny JSON, writes the reason to stderr and exits 2. `guardian-hook codex setup` prints the `hooks.json`. A headless host that runs `codex exec` needs `--dangerously-bypass-hook-trust` on it (or a managed `requirements.toml` hook), or Codex skips the hook.
- **guardian-hook: DeepSeek Harness** (`guardian-hook dsh`), through dsh's `@deepseek-ai/dsh-hooks-claude-code` bridge. Knows dsh's tool names: `bash`, `pwsh`, `terminal_send`, `write`, `edit`, `apply_patch`, `str_replace_editor` (all but `view`), `web_fetch`, `mcp__*`; the shipped matcher names all of them plus Claude Code's names. A deny also exits 2.
- New Ask-tier tool **`shell_session`**: starting an interactive shell, interpreter, database client, `ssh` or `docker exec -it` session (what is typed into it later is not seen). Register it on the needs-approval connection; until then such calls are denied.
- The hook's deadline now also covers reading stdin, and the hook answers as soon as a complete JSON object arrives, so an agent that leaves stdin open gets an answer rather than a hang. Patch headers that are indented or CRLF-terminated are read.
- The hook has its own hard deadline (`GUARDIAN_HOOK_DEADLINE_MS`, default and maximum 540 s): past it, it denies, so it never reaches the agent's 600 s hook timeout. Crashes, uncaught errors and unparseable input deny in the agent's format. Applies to Claude Code too; Claude Code's output is otherwise unchanged.
- `examples/agent-hooks.mjs` (SIMULATED), `examples/codex/` and `examples/deepseek-harness/` (LIVE recipes, including hosted agents).

### Added: remote MCP upstreams

- **guardian-mcp:** `guardian-mcp proxy --url <https-url> [--transport streamable-http|sse] [--header "Name: ${ENV_VAR}"]` fronts a remote MCP server, such as Composio, over Streamable HTTP (default) or SSE. Not yet proven live: tested against local MCP servers and a fake Guardian only. The agent still talks stdio. Every `tools/call` is decided by Guardian exactly as for a stdio server; `tools/list` passes through with `guardian_claim` and `guardian_receipt` added. Stdio proxying is unchanged.
  - Header and URL values are expanded from `${ENV_VAR}` by guardian-mcp itself, are never printed, and stay in the proxy. Expanding a missing variable or any `GUARDIAN_*` variable is refused, so the agent credential cannot reach the remote server.
  - `https://` only (plain `http://` for localhost), no user name or password in the URL, and no redirects to another origin.
  - Fails closed: an unreachable server or a rejected key at startup exits with a scrubbed one-line message and serves no tools. A remote failure after ALLOW is reported as "may or may not have run", and the capability is not redeemed.
  - `guardian-mcp tools --url …` lists a remote server's tools with suggested modes.
  - An upstream result is never read as a Guardian decision, so a remote server cannot hold, swap or hide a call by returning a `guardian` field. A `tools/list` failure shows the agent a generic message, never the upstream's error text. Two concurrent `guardian_claim` calls for one request forward it once. Error messages also scrub identifier-like URL path segments.
  - Not governed: a call that may have run after ALLOW but whose result was lost (timeout, dropped session) has no receipt; code in the same container can read the upstream key from its own environment.
  - Not supported: OAuth sign-in flows (use an API key or bearer header).
- **guardian-mcp:** a tool call made while the upstream's tool list cannot be fetched now returns a "nothing was forwarded" error instead of an MCP protocol error.
- `examples/remote-mcp.mjs`: the real CLI in front of a local Streamable HTTP server. SIMULATED by default (fail closed); LIVE with Guardian settings.
- `examples/zeroclaw/`: recipe that wraps ZeroClaw's MCP servers in guardian-mcp and switches off its built-in tools. ZeroClaw's built-ins (shell, file writes, HTTP, browser, cron, delegation) cannot be governed from outside; its images ship no Node.js.
- `examples/byo/`: CrewAI, LangGraph and AutoGen recipes. Each must keep one MCP session open (`MCPServerAdapter`, `client.session(...)`, `McpWorkbench`), because their default per-call sessions drop a held ASK.
- `packages/mcp` has a `typecheck` script.

### Fixed

- **guardian-hook:** an approval made in the last seconds of the 5-minute window was missed, because checks backed off to every 10 s on the hook's own clock (seen in a live run). The hook now times the window from when the request was created and always checks once more 1.5 s before it closes.

## guardian-hook 0.2.0, released 2026-11-06

### Added

- **`@odingard/guardian-hook/agent-sdk`**: Guardian for agents built on the Claude Agent SDK.
  - `guardianHookMatcher()` and `guardianPreToolUse()` give a `PreToolUse` hook with the same decisions as the Claude Code hook: everyday commands run, and deploys, destructive commands and pushes wait for a person.
  - It fails closed.
  - The matcher sets `onFailure: "block"` and a timeout longer than the 5-minute approval window.
  - It type-checks against `@anthropic-ai/claude-agent-sdk` 0.3.318.
- `examples/claude-agent-sdk.mjs`: a Claude agent governed by Guardian. It is LIVE: it needs a real Claude key and Guardian agent.
- The Claude Code command line is unchanged. Its logic moved to `src/run.ts` so the new entry point can reuse it without running the CLI.

## sdk 0.3.7 / Python 0.1.4, released 2026-11-06

### Added

- `verifyBeforeActing(..., { amountField })`, and in Python `amount_field`, read the amount from the signed request body (e.g. Stripe's `amount`) when the receipt declares no value. With no declared value the amount is accepted only when a person approved the request; Python matches TypeScript on the new golden cases.
- `fetchReceiptVerificationKeys(baseUrl, { forReceipt })` (or `{ kid }`), and in Python `fetch_receipt_verification_keys(base_url, for_receipt=...)`. Guardian publishes at most 8 keys, its newest. This option returns a set that contains an older receipt's own signing key, so receipts signed by long-retired keys still verify offline.

### Fixed

- `verifyBeforeActing` and Python `verify_before_acting` read the request body only for a known JSON or form content type; anything else (missing, repeated, unknown) is refused. Before, a JSON body sent as `text/json` or `application/merge-patch+json` was read as a form, so a smuggled `amount=` could pass. Python also refuses `NaN` and `Infinity` in a JSON body, reads deeply nested JSON as JavaScript does, drops one leading `?` from a form body, and now needs Python 3.9.2+ so `;` never splits a form.
- The body is read only as UTF-8: a `charset` other than `utf-8`, or any other content-type parameter, is refused, because a receiver honouring it could decode different keys. A form key that is the field with spaces around it (`& amount=`, which Rack reads as a second `amount`) is refused as ambiguous. TypeScript no longer reads inherited names such as `constructor` as fields, and Python trims the currency exactly as JavaScript does.

### Added, Python 0.1.4: "verify, don't trust"

- `verify_before_acting(receipt, keys, expected, ...)` and `fetch_receipt_status(base_url, receipt)`, the Python port of the TypeScript helpers.
- `fetch_receipt_verification_keys(..., for_receipt=receipt)` for receipts signed by older keys.
- Its verdicts match the TypeScript SDK on 35 golden cases: genuinely signed receipts covering every refusal and success, generated by `scripts/gen-vba-fixtures.ts`.

## sdk 0.3.6, released 2026-11-05

### Added: "verify, don't trust"

- **`verifyBeforeActing(receipt, keys, expected, options)`**, for the side that receives an agent's request (a bank, a merchant, another agent). It returns OK only if all of these hold:
  - the receipt is valid offline;
  - the received request equals the authorized action field for field;
  - Guardian allowed it, or a person approved it;
  - it is not revoked, expired or already used;
  - amount, destination and currency match;
  - it is fresh;
  - it was not already acted on (optional);
  - Guardian still reports it active (optional).
- **`fetchReceiptStatus(baseUrl, receipt)`** calls the public `POST /v1/receipts/status`. The reply is only a status.
- A receipt with no issued capability is refused (`NOT_ISSUED`), and so is one whose capability expired (`EXPIRED`), even while the action's window is still open.
- 15 tests on genuinely signed receipts.

## sdk 0.3.5 / guardian-hook 0.1.1, released 2026-11-05

### Fixed

- **An ASK expired after 2 minutes while the hook waited 9.** The SDK always asked Guardian to keep a request open for 120 s, so an approval that came later found the request already expired.
  - SDK: new `ttlMs` on `request()`, a whole number from 1 to `GUARDIAN_MAX_REQUEST_TTL_MS` (300000, Guardian's limit). The default is still 120000. Invalid values are refused before anything is sent.
  - guardian-hook: asks for the full 5 minutes and waits up to that long (`GUARDIAN_HOOK_APPROVAL_TIMEOUT_MS`, default and maximum 300000). It needs sdk ^0.3.5.

## sdk 0.3.4 / Python 0.1.3, released 2026-11-05

### Added

- **Money fields on governed actions:**
  - TypeScript: `valueCents`, `merchantId`, `merchantCategory`, `recurring` on `api.request` and other governed invocations.
  - Python: `value_cents`, `merchant_id`, `merchant_category`, `recurring`.
  - The amount is bound into the action, so grant caps, "ask above" and approvals apply to it. Guardian's executor refuses a request that moves more money than this.
  - Money-moving endpoints (for example Stripe refunds) **require** it. Without it the request is refused.
  - Invalid values are rejected before any network call.

## sdk 0.3.3, released 2026-11-05

### Security

- `@odingard/guardian-sdk` no longer pins `zod` to 4.6.5, which is
  affected by GHSA-mrhx-c7xc-m3w5 (memory exhaustion while validating
  oversized constrained collections, high). It now depends on `^4.6.7`.
  No API change.
- Dev-only: updates Vitest 3.x to `^5.1.0` across all workspaces, clearing
  the critical Vitest and `tinypool` advisories and the moderate
  `@vitest/mocker` advisory. These testing dependencies are never shipped
  to users.

## guardian-hook 0.1.0 (new package), released 2026-11-05

A Claude Code `PreToolUse` hook that routes shell
commands, file writes, web fetches and MCP tool calls through Guardian.

- Shell commands are routed by consequence: `shell`, `shell_deploy`,
  `shell_destructive` and `git_push`. That routing is what lets deploys
  wait for a phone approval while ordinary commands run under Allow.
- ALLOW redeems the capability before the agent runs the call.
- ASK waits for a human (never auto-approved).
- DENY, timeouts and an unreachable Guardian all fail closed.
- `guardian-hook setup` prints the console steps and the `settings.json`
  snippet; `guardian-hook classify <cmd>` shows the routing.
- Claude Code only. Cursor and Codex follow once their hook contracts are
  verified.
- **Two connections, one per risk tier.** Guardian modes are per
  connection, so Allow-tier tools go to `GUARDIAN_CONNECTION_ID` and
  Ask-tier tools go to `GUARDIAN_HOOK_ASK_CONNECTION_ID`. Found in a live
  run, where a read-only `ls` waited for approval.

## 0.3.2 (TypeScript: sdk, mcp) / 0.1.2 (Python), released 2026-11-05

### Fixed

- **`verifyReceiptOffline` / `verify_receipt_offline`** now accept the
  result of `fetchReceiptVerificationKeys()` /
  `fetch_receipt_verification_keys()` as returned (`{ ok: true, keys }`),
  as well as the key set itself. Before, passing the fetch result
  straight in returned `MALFORMED_RECEIPT`. A failed fetch result never
  verifies.

## guardian-mcp: `tools` command, released in 0.3.2 on 2026-11-05

- `guardian-mcp tools [--json] -- <server command>` lists an MCP server's
  real tools with a suggested Guardian mode for each. It uses the
  server's `readOnlyHint` and `destructiveHint` annotations first, then
  the tool's verb, and anything unclear is Ask.
- It flags tool names Guardian would reject. No credential is needed.

## guardian-langchain / guardian-vercel-ai 0.3.1, released 2026-11-05

sdk 0.3.1, guardian-mcp 0.3.1 and Python 0.1.1 were never published; these changes first shipped in sdk and guardian-mcp 0.3.2 and Python 0.1.2.

First-run fixes found in a production run.

### Changed

- **`createGuard` (TypeScript) and `Guard` (Python)** no longer propose a
  first-use `mcp.install` registration by default
  (`installRecordTransport` / `install_record_transport` default to
  `false`).
  - Production denies that registration unless the agent's grant pins
    `mcp.install`, so the default made the first call fail.
  - Register the tool once in the console as "My own code (record-only)".
- **`guardian-mcp proxy`** does the same: auto-registration is now opt-in
  with `GUARDIAN_AUTO_REGISTER=true`.

### Added

- **`GuardianDenied.hint`** (Python: `GuardianDenied.hint`) and
  **`denialHint()`** / **`denial_hint()`** give the developer's next step
  for:
  - a denied registration;
  - an `INVALID_REQUEST` tool denial (the tool is not registered or not
    allowed for the agent);
  - `PLAN_LIMIT_EXCEEDED`.

  In `onDeny: "result"` mode the hint is included in the message returned
  to the model. Decisions and reason codes are unchanged.

### Fixed

- Structured denials that carry `code` instead of `reasonCode` (for
  example `PLAN_LIMIT_EXCEEDED`) are reported with their real code, not
  `HTTP_403`.

The LangChain and Vercel AI adapters keep their auto-registration default
and gain the same hints.

## 0.3.0 (TypeScript) / 0.1.0 (Python), released 2026-11-04

- `createGuard` / `guard`: govern your own action code from any framework.
- `guardian-mcp proxy`: put Guardian in front of any stdio MCP server.
- LangChain and Vercel AI adapters share the core triad.
- Python SDK `odingard-guardian`: sync and async client, `Guard` decorator,
  offline receipt verification.
