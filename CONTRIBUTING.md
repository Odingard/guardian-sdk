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

`packages/x402`, `packages/ap2` and `packages/link` call `request` /
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
- **Receipt binding.** After a person approves, the guard reads the portable
  receipt. It refuses unless the receipt names that request, tool,
  connection and the exact arguments. It also refuses a claim answer that
  names another request. The triad has neither check.
- **Bounded calls.** Each Guardian call has a timeout.

A payment guard must still keep the triad's conventions. The link guard
sends `adapterId` when set and refuses the reserved `guardianContentPins`
argument. x402 and ap2 do not do either yet. Move a guard onto the triad
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
and `_lookup_answer` in `guard.py`).

## Development

```bash
npm install     # one install for every package (npm workspaces)
npm run build   # builds packages/sdk first, then the rest
npm test        # vitest — no network calls; stub the Guardian client
npm run test:python      # Python SDK (after: cd packages/python && uv venv && uv pip install -e ".[test]")
npm run fixtures:python  # regenerate the Python SDK's cross-language golden fixtures
```

`packages/sdk/src/contracts/`, `packages/sdk/src/evidence/`, the SDK client,
guard, lifecycle, receipts and embedded-approval sources, the catalog JSON and the
Steel adapter sources are generated. Don't edit them here; open an issue
instead.

Rules that matter:

- `ALLOW` executes only via the issued single-use capability — never run the
  underlying action without one.
- `ASK` never auto-resolves — surface the requestId to the human layer.
- No model calls in the decision path. No credentials in tests or commits.

## License

Apache-2.0. By contributing you agree your changes ship under it.
