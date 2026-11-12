import { AsyncLocalStorage } from "node:async_hooks";

import type { ClosedCheckoutContent, ClosedPaymentContent } from "./mandates.js";
import type { PayTerms } from "./terms.js";

/** What one approved hop may contain, exactly. */
export type ExpectedHop = Readonly<{
  kind: "checkout" | "payment";
  aud: string;
  nonce: string;
  sdHash: string;
  content: ClosedCheckoutContent | ClosedPaymentContent;
}>;

/** Single use: one checkout hop and one payment hop, within the window. */
export type SigningToken = {
  readonly terms: PayTerms;
  readonly termsDigest: string;
  readonly requestId: string;
  readonly receiptReference: string;
  readonly expiresAtMs: number;
  readonly hops: readonly ExpectedHop[];
  readonly used: Set<"checkout" | "payment">;
};

/** One `pay()` call. */
export type PaymentFlow = {
  readonly id: string;
  token?: SigningToken;
};

export const flowStorage = new AsyncLocalStorage<PaymentFlow>();
