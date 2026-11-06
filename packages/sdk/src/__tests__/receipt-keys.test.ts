import { describe, expect, it } from "vitest";

import { fetchReceiptVerificationKeys } from "../index.js";

describe("fetchReceiptVerificationKeys for an older receipt", () => {
  it("asks for a set containing the receipt's own signing key", async () => {
    const urls: string[] = [];
    const fetchFake = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    };
    await fetchReceiptVerificationKeys("https://guardian.test/", {
      fetch: fetchFake,
    });
    await fetchReceiptVerificationKeys("https://guardian.test", {
      fetch: fetchFake,
      forReceipt: { proof: { keyId: "rkey_abc123" } },
    });
    await fetchReceiptVerificationKeys("https://guardian.test", {
      fetch: fetchFake,
      kid: "rkey_def456",
    });
    await fetchReceiptVerificationKeys("https://guardian.test", {
      fetch: fetchFake,
      forReceipt: { proof: { keyId: "rkey_x&evil=1" } },
    });
    expect(urls).toEqual([
      "https://guardian.test/v1/receipts/verification-keys",
      "https://guardian.test/v1/receipts/verification-keys?kid=rkey_abc123",
      "https://guardian.test/v1/receipts/verification-keys?kid=rkey_def456",
      "https://guardian.test/v1/receipts/verification-keys",
    ]);
  });
});
