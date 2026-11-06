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
