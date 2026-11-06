/**
 * Golden cross-language fixtures for the Python SDK, generated from
 * the canonical TypeScript implementation.
 *
 *   npm run fixtures   (from packages/python)
 *
 * Writes tests/fixtures/receipts.json and tests/fixtures/canonical-json.json.
 * The receipt cases start from the real staging sample receipt, re-signed
 * with an ephemeral test key so the fixtures need no network. Every case
 * records the TypeScript verifier's verdict; the Python verifier must match.
 */
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { canonicalJson } from "../../sdk/src/contracts/canonical-json.js";
import { canonicalSha256 } from "../../sdk/src/contracts/digest.js";
import { portableReceiptSigningInput } from "../../sdk/src/contracts/receipt.js";
import { createReceiptSignerFromJwk } from "../../sdk/src/evidence/receipt.js";
import { verifyReceiptOffline } from "../../sdk/src/receipts.js";

const here = new URL(".", import.meta.url);
const sample = JSON.parse(
  readFileSync(
    new URL("../../../examples/receipts/staging-sample.greceipt.json", here),
    "utf8",
  ),
);

function testKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; d: string };
  return { privateKey, signer: createReceiptSignerFromJwk(jwk) };
}
const { privateKey, signer } = testKey();
const other = testKey().signer;
const keys = { keys: [signer.verificationJwk] };

type Json = any;
const clone = (v: Json): Json => structuredClone(v);
const bodyOf = (r: Json) => {
  const { proof: _proof, ...body } = r;
  return body;
};
// Raw re-signing (no schema gate) so deliberately malformed bodies still
// carry a valid signature and exercise the verifier's later checks.
const resign = (r: Json) => {
  const body = bodyOf(r);
  const signature = edSign(
    null,
    portableReceiptSigningInput(body as never),
    privateKey,
  ).toString("base64url");
  return {
    ...body,
    proof: {
      algorithm: "Ed25519",
      canonicalization: "guardian-canonical-json.v1",
      domain: "odingard.guardian.receipt.v1",
      keyId: signer.keyId,
      signature,
    },
  };
};

const valid = resign(sample);
const cases: { name: string; receipt: Json; keys: Json }[] = [];
const add = (name: string, receipt: Json, k: Json = keys) =>
  cases.push({ name, receipt, keys: k });

add("valid", valid);
add("unknown key", valid, { keys: [other.verificationJwk] });
{
  const r = clone(valid);
  r.action.purpose = `${r.action.purpose} (edited)`;
  add("tampered body, original signature", r);
}
{
  const r = clone(valid);
  r.proof.signature =
    r.proof.signature.slice(0, -2) +
    (r.proof.signature.endsWith("AA") ? "BA" : "AA");
  add("corrupted signature", r);
}
{
  const r = clone(valid);
  r.decision.reasonCode = "FORGED_REASON";
  add("forged decision, re-signed", resign(r));
}
{
  const r = clone(valid);
  r.subject.requestId = "req_00000000000000000000000000000000";
  add("forged subject, re-signed", resign(r));
}
{
  const r = clone(valid);
  r.evidence.chain[0].payloadDigest = "0".repeat(64);
  add("forged chain payload digest, re-signed", resign(r));
}
{
  const r = clone(valid);
  r.evidence.headRecordHash = "f".repeat(64);
  add("forged evidence head, re-signed", resign(r));
}
{
  const r = clone(valid);
  r.evidence.chain = r.evidence.chain.slice(0, -1);
  r.evidence.recordCount = r.evidence.chain.length;
  r.evidence.headRecordHash = r.evidence.chain.at(-1).recordHash;
  add("truncated chain, re-signed", resign(r));
}
{
  const r = clone(valid);
  r.delegationChain = [];
  add("forged delegation chain, re-signed", resign(r));
}
{
  const r = clone(valid);
  if (r.capability) r.capability.claimsDigest = "a".repeat(64);
  add("forged capability digest, re-signed", resign(r));
}
{
  const r = clone(valid);
  if (r.execution) r.execution.attemptId = "att_" + "b".repeat(32);
  add("forged execution attempt, re-signed", resign(r));
}
{
  const r = clone(valid);
  r.effect.kind = r.effect.kind === "verified" ? "failed" : "verified";
  add("forged effect, re-signed", resign(r));
}
{
  const r = clone(valid);
  delete r.proof;
  add("missing proof", r);
}
add("not an object", "nope");

const receipts = cases.map((c) => ({
  ...c,
  expected: verifyReceiptOffline(c.receipt, c.keys),
}));
writeFileSync(
  new URL("../tests/fixtures/receipts.json", here),
  JSON.stringify(receipts, null, 1) + "\n",
);

const vectors: Json[] = [
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  1.5,
  0.1,
  1e21,
  1e-7,
  123456789012345680000,
  1.7976931348623157e308,
  5e-324,
  2 ** 53,
  0.000001,
  1e20,
  -2.5e-8,
  100,
  1e300,
  "",
  "plain",
  'quote" back\\slash',
  "ctrl\u0000\u0001\u001f\b\f\n\r\t",
  "del\u007f",
  "é ü 中文",
  "emoji 😀",
  "  ",
  [],
  [1, [2, [3]]],
  {},
  { b: 1, a: 2, A: 3, _: 4, "10": 5, "9": 6 },
  { "😀": 1, "￿": 2, é: 3, z: 4 },
  { nested: { y: [1, { b: null, a: "x" }], x: true } },
];
const canon = vectors.map((value) => ({
  value,
  canonical: canonicalJson(value),
  sha256: canonicalSha256(value),
}));
writeFileSync(
  new URL("../tests/fixtures/canonical-json.json", here),
  JSON.stringify(canon, null, 1) + "\n",
);

console.log(
  receipts
    .map(
      (r) =>
        `${r.name}: ${r.expected.valid ? "valid" : (r.expected as Json).reasonCode}`,
    )
    .join("\n"),
);
