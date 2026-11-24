/**
 * verify-receipt.mjs — zero credentials, no Guardian account.
 *
 * Verifies a real portable authority record (greceipt.v1) recorded on
 * Guardian, offline, against Guardian's Ed25519 public keys. Then tampers
 * one byte of the bound action and shows verification fail.
 *
 *   node verify-receipt.mjs [receipt.json] [baseUrl]
 *
 * With no arguments it verifies the bundled sample against the bundled copy
 * of its signing key (receipts/verification-keys.json), fully offline.
 * For your own record, pass the file and optionally the base URL of the
 * Guardian API that signed it (default https://guardian-api.odingard.com);
 * the script fetches the keys published at /v1/receipts/verification-keys.
 */
import { readFileSync } from "node:fs";
import {
  fetchReceiptVerificationKeys,
  verifyReceiptOffline,
} from "@odingard/guardian-sdk";

const file =
  process.argv[2] ??
  new URL("./receipts/sample.greceipt.json", import.meta.url);
const baseUrl =
  process.argv[3] ??
  (process.argv[2] ? "https://guardian-api.odingard.com" : undefined);
const receipt = JSON.parse(readFileSync(file, "utf8"));

let keys;
if (baseUrl) {
  const fetched = await fetchReceiptVerificationKeys(baseUrl, { forReceipt: receipt });
  if (!fetched.ok) {
    console.error(`could not fetch published keys: ${fetched.reasonCode}`);
    process.exit(1);
  }
  keys = fetched.keys;
  console.log(`[LIVE] keys from ${baseUrl}/v1/receipts/verification-keys`);
} else {
  keys = JSON.parse(
    readFileSync(
      new URL("./receipts/verification-keys.json", import.meta.url),
      "utf8",
    ),
  );
  console.log("[bundled] keys from receipts/verification-keys.json");
}
// From here on nothing touches the network.
const result = verifyReceiptOffline(receipt, keys);
console.log("[offline] receipt:", JSON.stringify(result));

const tampered = structuredClone(receipt);
tampered.action.purpose = `${tampered.action.purpose} (edited)`;
const tamperedResult = verifyReceiptOffline(tampered, keys);
console.log("[offline] tampered:", JSON.stringify(tamperedResult));
process.exitCode = result.valid && !tamperedResult.valid ? 0 : 1;
