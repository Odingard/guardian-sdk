# Guardian portable authority receipt: `greceipt.v1`

**Status:** published specification of the format Guardian issues today. It documents the existing implementation and introduces nothing new. License: Apache-2.0.

**Normative sources:**

- `packages/sdk/src/contracts/receipt.ts` (schema);
- `packages/sdk/src/contracts/canonical-json.ts` (canonicalization);
- `packages/sdk/src/evidence/receipt.ts` (verification).

**Reference verifiers:**

- TypeScript: `verifyReceiptOffline` in `@odingard/guardian-sdk`;
- Python: `verify_receipt_offline` in `odingard-guardian`.

## 1. Purpose

A receipt is a self-contained, signed record of one governed request. It contains:

- the exact action an agent proposed;
- Guardian's decision (ALLOW, ASK or DENY);
- the human approval, when one was required;
- the single-use capability that was issued;
- the execution record and its verified effect;
- the complete evidence chain.

Anyone holding the receipt and Guardian's published public keys can verify it **offline**. No Guardian account, credential, database or network call is needed.

A receipt answers: **who was allowed to cause this exact effect, under whose authority, and what happened.**

## 2. Document structure

A receipt is one JSON object. Every object in it is **strict**: unknown fields make the receipt invalid.

| Field             | Type                       | Meaning                                                                                                                                                                            |
| ----------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`          | `"greceipt.v1"`            | Format identifier                                                                                                                                                                  |
| `schemaVersion`   | `1`                        | Schema version                                                                                                                                                                     |
| `receiptId`       | `rcp_…`                    | Receipt identifier                                                                                                                                                                 |
| `issuedAtEpochMs` | integer                    | Issue time (Unix ms)                                                                                                                                                               |
| `subject`         | object                     | `tenantId`, `principalId` (the human authority), `agentId`, `requestId`, `correlationId`                                                                                           |
| `runtime`         | object                     | `interface`, `requestedAdapterId`, `adapterId` (`null` until execution)                                                                                                            |
| `action`          | object                     | The canonical action that was evaluated, including its `materialDigest` (the hash of the exact parameters)                                                                         |
| `delegationChain` | array                      | `{ grantId, version }` for each grant the decision relied on. Required unless the decision is DENY.                                                                                |
| `decision`        | object                     | `decision` (ALLOW, ASK or DENY), `reasonCode`, `actionDecisionDigest`, `decidedAtEpochMs`                                                                                          |
| `approval`        | object or null             | `approvalId`, `state`, `version`, `approvalDigest`, `record`. Present when a human decided.                                                                                        |
| `capability`      | object or null             | `capabilityId`, `claims`, `claimsDigest`, `state` (`issued`, `used`, `expired` or `revoked`)                                                                                       |
| `execution`       | object or null             | The execution record                                                                                                                                                               |
| `effect`          | object                     | `kind` (`verified`, `failed`, `outcome-pending` or `none`), `terminalEvent`, `failureCode`, `effectDigest`, `failureDigest`                                                        |
| `evidence`        | object                     | `chain` (1–10,000 hash-linked records), `recordCount`, `headRecordHash`                                                                                                            |
| `generatedBy`     | `"guardian-control-plane"` | Issuer                                                                                                                                                                             |
| `proof`           | object                     | `algorithm: "Ed25519"`, `canonicalization: "guardian-canonical-json.v1"`, `domain: "odingard.guardian.receipt.v1"`, `keyId` (`rkey_<hex>`), `signature` (base64url, 86 characters) |

The **body** is every field except `proof`. The signature covers the whole body.

## 3. Canonicalization: `guardian-canonical-json.v1`

The bytes that are signed are UTF-8 JSON produced as follows:

- **Objects:** keys sorted by UTF-16 code-unit order (JavaScript `<` on strings). No whitespace.
- **Arrays:** in order. No sparse arrays and no extra properties.
- **Strings and booleans:** `null`, booleans and strings are serialized as by `JSON.stringify`.
- **Numbers:** finite only, serialized as by `JSON.stringify`, with `-0` written as `0`. `NaN` and `Infinity` are rejected.
- **Rejected values:** `undefined`, functions, symbols, bigints, cycles, accessors, and non-plain objects all make canonicalization fail.
- **Limits:** depth at most 64, and at most 100,000 nodes.

## 4. Signature

```text
signing_input = UTF-8( canonical_json({ "domain": "odingard.guardian.receipt.v1", "receipt": <body> }) )
signature     = Ed25519_sign(private_key, signing_input)        # base64url, no padding
```

The domain wrapper prevents a receipt signature from being reused as a signature over any other Guardian object.

## 5. Key discovery

```text
GET https://guardian-api.odingard.com/v1/receipts/verification-keys
→ { "keys": [ { "kty": "OKP", "crv": "Ed25519", "kid": "rkey_…", "use": "sig", "alg": "EdDSA", "x": "<base64url>" } ] }
```

- The endpoint is public and needs no credential.
- A key set holds 1–8 keys, so rotation is supported: old keys keep verifying old receipts.
- Verifiers may cache the key set, or pin it for fully offline use.
- The published set holds Guardian's newest keys: the set is limited to 8. `GET /v1/receipts/verification-keys?kid=<proof.keyId>` returns a valid set that contains that key, so receipts signed by older keys stay verifiable. The SDK does this with `fetchReceiptVerificationKeys(baseUrl, { forReceipt })`.

## 6. Verification algorithm

A receipt is valid **only if every step passes**. On the first failure, return its code.

1. **Shape.** The receipt and the key set parse against the strict schemas. Otherwise `MALFORMED_RECEIPT`.
2. **Key.** Find the key whose `kid` equals `proof.keyId`. Otherwise `UNKNOWN_KEY`.
3. **Signature.** Ed25519-verify `proof.signature` over the signing input (§4). Otherwise `SIGNATURE_INVALID`.
4. **Evidence chain.** Every record's hash links to its predecessor, and the chain yields one consistent context. Otherwise `EVIDENCE_CHAIN_INVALID`.
5. **Subject.** The chain's tenant, principal, agent, request and correlation equal `subject`. Otherwise `SUBJECT_MISMATCH`.
6. **Head.** `evidence.headRecordHash` and `recordCount` match the chain. Otherwise `EVIDENCE_HEAD_MISMATCH`.
7. **Action.** Every action digest in the chain equals `action.materialDigest`, and the action re-digests to it. Otherwise `ACTION_MISMATCH`.
8. **Decision.** `decision` matches the chain's decision event (`DECISION_RECORDED`, or `REQUEST_DENIED` for pre-kernel denials). Otherwise `DECISION_MISMATCH`.
9. **Approval, capability, execution.** Each embedded object is present exactly when its evidence event is present, and re-digests to the value the chain recorded. Otherwise `APPROVAL_MISMATCH`, `CAPABILITY_MISMATCH` or `EXECUTION_MISMATCH`.
10. **Effect.** `effect` matches the terminal event. For `verified`, the effect digest is **recomputed from the embedded execution record**, so a receipt cannot borrow another request's effect. Otherwise `EFFECT_MISMATCH`.

On success a verifier returns `{ valid: true, subject, decision, effect: effect.kind }`.

**What "valid" means.** Guardian signed this exact record, nothing in it was changed, and its parts are mutually consistent with the evidence chain.

**What "valid" does not mean.** It is not a statement that the decision was wise, or that the effect was good. It also says nothing about actions that never went through Guardian.

## 7. Conformance vectors

The TypeScript and Python verifiers are tested against the same golden files, generated from the reference implementation:

- `packages/python/tests/fixtures/receipts.json`: **15 cases**, each with its expected result. One is valid. The other 14 are tampered or forged variants: changed body, corrupted signature, a forged decision, subject, chain digest, evidence head, delegation chain, capability, execution or effect (each re-signed with a different key), a truncated chain, an unknown key, a missing proof, and a non-object.
- `packages/python/tests/fixtures/canonical-json.json`: **34** canonicalization input/output vectors.

A new verifier conforms when it reproduces every expected result in both files.

## 8. Verify a receipt today

```bash
npm i @odingard/guardian-sdk
```

```js
import {
  fetchReceiptVerificationKeys,
  verifyReceiptOffline,
} from "@odingard/guardian-sdk";

const keys = await fetchReceiptVerificationKeys(
  "https://guardian-api.odingard.com",
);
const result = verifyReceiptOffline(receipt, keys); // { valid, decision, effect, subject } or { valid: false, reasonCode }
```

```python
from odingard_guardian import fetch_receipt_verification_keys, verify_receipt_offline

keys = fetch_receipt_verification_keys("https://guardian-api.odingard.com")
result = verify_receipt_offline(receipt, keys)
```

## 9. Linking to other systems' records

`greceipt.v1` is closed: it has no extension fields. A system that records its own side of an action, such as a resource provider's log of the call it served, links to Guardian by storing:

- `receiptId`;
- `subject.requestId`;
- `action.materialDigest`, the hash of the exact parameters Guardian authorized.

A matching `materialDigest` shows that the call served is the call that was authorized. Combined, the two records give one chain:

> human authority → Guardian decision → executed call → provider-side outcome

Each side stays verifiable on its own.

**A receiver acting on a request.** A receiver that is asked to act should do more than verify the receipt. It should:

- check that the request it received equals `action.materialParameters`;
- check that the decision was ALLOW, or ASK with an `approved` approval;
- check that the capability is not revoked, expired or used;
- check that the receipt is fresh;
- record `subject.requestId`, so it acts only once.

`verifyBeforeActing` in `@odingard/guardian-sdk` does all of this. Whether the authorization is still in force at that moment is not part of the format, because it can change after issue. Ask Guardian with `POST /v1/receipts/status { receipt }`, which replies with a status only.

## 10. Versioning

- Any change to fields, canonicalization or the signing domain is a new format identifier (`greceipt.v2`).
- `greceipt.v1` receipts stay verifiable for as long as their keys are published.
