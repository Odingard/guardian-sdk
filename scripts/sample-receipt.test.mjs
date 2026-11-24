// Checks that examples/receipts/sample.greceipt.json verifies.
//
// Offline (always): against the bundled copy of Guardian's public key,
// examples/receipts/verification-keys.json.
// Live (opt-in): set GUARDIAN_LIVE_KEYS_URL to the base URL of a Guardian API
// that publishes the bundled key. The sample must verify against the keys it
// publishes at /v1/receipts/verification-keys, and the bundled copy must match.
// There is no default host: point it at the API that signed the sample.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  fetchReceiptVerificationKeys,
  verifyReceiptOffline,
} from "../packages/sdk/dist/index.js";

const API = process.env.GUARDIAN_LIVE_KEYS_URL;
const read = (p) =>
  JSON.parse(
    readFileSync(new URL(`../examples/receipts/${p}`, import.meta.url), "utf8"),
  );
const receipt = read("sample.greceipt.json");
// The key set as published: { keys: [jwk, ...] }.
const bundled = read("verification-keys.json");

test("sample verifies offline against the bundled key", () => {
  assert.equal(receipt.proof.keyId, bundled.keys[0].kid);
  const result = verifyReceiptOffline(receipt, bundled);
  assert.equal(result.valid, true, JSON.stringify(result));
});

test("a tampered sample fails offline", () => {
  const tampered = structuredClone(receipt);
  tampered.action.purpose = `${tampered.action.purpose} (edited)`;
  assert.equal(verifyReceiptOffline(tampered, bundled).valid, false);
});

test("the example requests the signing key for an older receipt", async (t) => {
  const expectedPath = `/v1/receipts/verification-keys?kid=${receipt.proof.keyId}`;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === expectedPath ? bundled : { keys: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const example = fileURLToPath(new URL("../examples/verify-receipt.mjs", import.meta.url));
  const sample = fileURLToPath(new URL("../examples/receipts/sample.greceipt.json", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [
    example,
    sample,
    `http://127.0.0.1:${server.address().port}`,
  ], { timeout: 5000 });
  assert.match(stdout, /\[offline\] receipt: \{"valid":true/);
  assert.match(stdout, /\[offline\] tampered: \{"valid":false/);
});

test(
  "sample verifies against the keys published by Guardian",
  {
    skip: !API && "set GUARDIAN_LIVE_KEYS_URL to run",
  },
  async () => {
    const keys = await fetchReceiptVerificationKeys(API, { forReceipt: receipt });
    assert.equal(keys.ok, true, JSON.stringify(keys));
    const result = verifyReceiptOffline(receipt, keys.keys);
    assert.equal(result.valid, true, JSON.stringify(result));
    const live = keys.keys.keys.find((k) => k.kid === receipt.proof.keyId);
    assert.deepEqual(
      { kid: live.kid, x: live.x },
      { kid: bundled.keys[0].kid, x: bundled.keys[0].x },
    );
  },
);
