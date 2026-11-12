# AP2 payments, decided by Guardian

| What                     | Label         | Needs                                         |
| ------------------------ | ------------- | --------------------------------------------- |
| `simulated-payments.mjs` | **SIMULATED** | Node 22 and a build of this repo. No network. |

**Not yet proven live.** AP2 has no public sandbox; a run against the AP2
reference merchant, credential provider and processor has not been done yet.

```bash
npm install && npm run build     # from the repo root
node examples/ap2/simulated-payments.mjs
```

What is real: `@odingard/guardian-ap2`, its SD-JWT and ES256 code, and the
AP2 v0.2 mandate formats. What is fake: Guardian is an in-memory stand-in (no
real receipts), and the Trusted Surface, merchant and payment processor are
stand-ins with throwaway P-256 keys made on each run. Nothing leaves the
process and no money moves.

It does four things:

1. **Delegation.** The agent asks for open mandates (up to 40.00 USD a
   payment, at most 5 payments, 100.00 USD in all). Guardian holds
   `ap2.delegate.recurring` for a (simulated) person; only then does the
   Trusted Surface sign.
2. **19.99 USD mug.** Below `askAbove` and under an open mandate a person
   approved here, so a rule allows `ap2.pay`; Guardian redeems it, then the
   agent key signs the closed Checkout and Payment Mandates. A processor
   receipt is verified.
3. **30.00 USD for two mugs.** Above `askAbove`, so it goes to
   `ap2.pay.above_cap` and waits for a person.
4. **Gift card.** Guardian denies it; nothing is signed.

Expected output:

```
delegate: open mandates for the agent key
  Guardian: ap2.delegate.recurring held for a person (up to 40.00 USD per payment)
  person: approved
  Trusted Surface signed both open mandates

pay: mug
  signed: 19.99 USD to Example Store
  receipt: payment Success

pay: two-mugs
  Guardian: ap2.pay.above_cap held for a person (30.00 USD)
  person: approved
  signed: 30.00 USD to Example Store
  receipt: payment Success

pay: scam
  not signed: [guardian-ap2 GUARDIAN_DENIED:POLICY_DENIED] Guardian denied this.
```

The guard is decision-gated, not enforced outside the agent's process, and
it is not the AP2 Trusted Surface: see
[packages/ap2](../../packages/ap2/README.md#not-governed).
