# Contributing to Guardian SDK

Thanks for helping build Human Authority Infrastructure for Autonomous AI.

## Ways to help

- **Bug reports & feature requests** — open an issue. For security issues, do
  not post publicly; email security@odingard.com instead.
- **Framework adapters** — the highest-leverage contribution: a wrapper that
  routes a framework's tool calls through Guardian (`ALLOW`/`ASK`/`DENY` →
  capability-gated execution). Build it on `createGuardianContext` /
  `runThroughGuardian` from `@odingard/guardian-sdk` (the shared triad in
  `packages/sdk/src/guard.ts`). Don't copy the semantics.
- **Docs, examples, fixes** — pull requests welcome.

### Payment guards (exception)

`packages/x402`, `packages/ap2`, `packages/link` and `packages/opencommerce` call `request` /
`claim` / `execute` themselves instead of `runThroughGuardian`, because the
shared triad cannot give them these guarantees today:

- **Redeem before the payment.** In `inProcess` mode the triad runs the
  action, then redeems the capability. A payment guard redeems first, so
  revocation, expiry and single use land before money moves. `remote` mode
  would need Guardian to make the payment, but these guards sign or log in
  locally.
- **Wait for the person.** In `result` mode an ASK comes back as a held
  request, to be retried later. A payment guard blocks until the person
  decides, within the request's TTL. It also refuses a rule ALLOW on a tool
  that needs a person, before redeeming.
- **Request fields.** The triad sends no `ttlMs` (the guards bound the wait
  with it) and no `amountArgument` (the link guard sends it so console dollar
  limits apply).
- **Record binding.** After a person approves, the guard reads the portable
  signed record. It refuses unless the record names that request, tool,
  connection and the exact arguments. It also refuses a claim answer that
  names another request. The triad has neither check.
- **Bounded calls.** Each Guardian call has a timeout.

A payment guard must still keep the triad's conventions. The link guard
sends `adapterId` when set and refuses the reserved `guardianContentPins`
argument. The opencommerce guard sends `adapterId` when set, builds its
arguments itself (so never carries the content-pin argument), and after a
lost redemption answer looks the request up with the same rules as the
triad (`executeOutcomeUnknown` and `lookUpExecution`). x402 and ap2 do not do either yet. Move a guard onto the triad
once it covers these points.

### Coding-agent hooks (exception)

`packages/hook` (and `packages/openclaw`, which uses the hook's decision
code) also call `request` / `claim` / `execute` themselves. The agent runs
the tool itself after the hook answers, so the hook redeems the capability
before the call runs and waits for the person within the request's TTL,
like a payment guard. After a lost redemption answer it looks the request
up with the same rules as the triad (`executeOutcomeUnknown` and
`lookUpExecution` in `packages/sdk/src/guard.ts`); change both together.
The Python Hermes plugin (`packages/python/src/odingard_guardian/hermes.py`)
works the same way and reuses the Python guard's rules (`_outcome_unknown`
and `_lookup_answer` in `guard.py`). So does the Python Claude Agent SDK hook
(`claude_agent_sdk.py`); the two share their decision code (`_hook.py`).

### Watch mode (exception, opt-in)

With `watchMode: true` (Python: `watch_mode=True`), the triad runs an `inProcess` tool on a watched answer: a `DENY` with reasonCode `WATCHED` and `watch.wouldDecision`, given while the agent's owner has it in watch mode, for a call Guardian would have asked about or denied. Guardian issues no capability for such a call and performs nothing for it, so there is nothing to redeem or record. The rule below does not hold for these calls, and that is why the option is off by default. Without it, a watched answer is a denial like any other. Keep these limits:

- the triad asks for the watched answer (`x-guardian-watch-aware: 1`) for `inProcess` tools only, and only with the option on;
- the client keeps `watched` only on an answer to a request that asked for it, never on a claim;
- content pins are still checked before the tool runs;
- a `remote` tool never runs on a watched answer.
- guardian-hook (`GUARDIAN_HOOK_WATCH_MODE=on`) and the OpenClaw plugin (`watchMode`) ask for it only with their option on; on a watched answer the hook gives no permission decision (the agent's own permissions apply) and OpenClaw lets the call run. An Edit-type call's pin is still checked. Nothing is redeemed.

## Development

```bash
npm install     # one install for every package (npm workspaces)
npm run build   # builds packages/sdk first, then the rest
npm test        # vitest — no network calls; stub the Guardian client
npm run test:python      # Python SDK (after: cd packages/python && uv venv && uv pip install -e ".[test]")
npm run fixtures:python  # regenerate the Python SDK's cross-language golden fixtures
```

`packages/sdk/src/contracts/`, `packages/sdk/src/evidence/`, each
`packages/sdk/src/*.ts` file that starts with `// Generated file — do not edit.`,
the catalog JSON and the Steel adapter sources are generated. Don't edit them here; open an issue
instead.

Rules that matter:

- `ALLOW` executes only via the issued single-use capability — never run the
  underlying action without one. The one exception is opt-in watch mode,
  described above.
- `ASK` never auto-resolves — surface the requestId to the human layer.
- No model calls in the decision path. No credentials in tests or commits.

## Releasing the Python package

From `packages/python`, use a virtual environment with `build` and `twine`
installed. Build, then check the archives before uploading:

```bash
python -m build
python scripts/check-dist.py
python -m twine check dist/*
```

Only after all checks pass and the release is approved, run
`python -m twine upload dist/*`. The distribution check restricts archive
contents and limits each archive to 1 MB; do not upload if it fails.

## License

Apache-2.0. By contributing you agree your changes ship under it.
