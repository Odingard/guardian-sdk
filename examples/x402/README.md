# x402 payments, decided by Guardian

| What                     | Label         | Needs                                         |
| ------------------------ | ------------- | --------------------------------------------- |
| `simulated-payments.mjs` | **SIMULATED** | Node 22 and a build of this repo. No network. |

```bash
npm install && npm run build     # from the repo root
node examples/x402/simulated-payments.mjs
```

What is real: the official x402 client, its fetch wrapper, the exact EVM
scheme and `@odingard/guardian-x402`. What is fake: Guardian is an in-memory
stand-in (no real receipts), the paid API is an in-memory 402 server, and the
wallet is a throwaway Base Sepolia test key made on each run. Nothing leaves
the process and no money moves.

It makes three payments:

1. `/weather`, 0.01 USDC: a rule allows `x402.pay`; Guardian redeems it, then
   the wallet signs.
2. `/report`, 0.25 USDC: above `askAbove`, so it goes to `x402.pay.above_cap`
   and waits for a (simulated) person.
3. `/scam`: Guardian denies it; nothing is signed.

Expected output (request ids and nonces differ):

```
GET https://api.example.test/weather
  200: paid content for /weather

GET https://api.example.test/report
  Guardian: held for a person (0.25 USDC to 0x1111111111111111111111111111111111111111)
  person: approved
  200: paid content for /report

GET https://api.example.test/scam
  not paid: Failed to create payment payload: [guardian-x402 GUARDIAN_DENIED:POLICY_DENIED] Guardian denied this payment.
```

The guard is decision-gated, not enforced outside the agent's process: see
[packages/x402](../../packages/x402/README.md#not-governed).
