/**
 * verify-receipt.mjs — LIVE, zero credentials, no Guardian account.
 *
 * Verifies a real portable authority receipt (greceipt.v1) recorded on
 * Guardian staging, offline, against the Ed25519 keys Guardian publishes.
 * Then tampers one byte of the bound action and shows verification fail.
 *
 *   node verify-receipt.mjs [receipt.json] [baseUrl]
 */
import { readFileSync } from "node:fs";
import {
  fetchReceiptVerificationKeys,
  verifyReceiptOffline,
} from "@odingard/guardian-sdk";

const file = process.argv[2] ?? new URL("./receipts/staging-sample.greceipt.json", import.meta.url);
const baseUrl = process.argv[3] ?? "https://guardian-api-staging.odingard.com";
const receipt = JSON.parse(readFileSync(file, "utf8"));

const keys = await fetchReceiptVerificationKeys(baseUrl);
if (!keys.ok) {
  console.error(`could not fetch published keys: ${keys.reasonCode}`);
  process.exit(1);
}
console.log(`[LIVE] keys from ${baseUrl}/v1/receipts/verification-keys`);
// From here on nothing touches the network.
const result = verifyReceiptOffline(receipt, keys.keys);
console.log("[offline] receipt:", JSON.stringify(result));

const tampered = structuredClone(receipt);
tampered.action.purpose = `${tampered.action.purpose} (edited)`;
console.log("[offline] tampered:", JSON.stringify(verifyReceiptOffline(tampered, keys.keys)));
process.exit(result.valid ? 0 : 1);
