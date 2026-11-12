import { AsyncLocalStorage } from "node:async_hooks";

import type { CanonicalTerms, PaymentRequestInfo } from "./terms.js";
import type { PinnedAsset } from "./constants.js";

/** One request the agent made through a guarded transport. */
export type RequestContext = {
  readonly id: string;
  readonly info: PaymentRequestInfo;
  /** Ledger ids of authorizations signed while serving this request. */
  readonly signedEntries: string[];
  /** x402 version of each signed flow, by ledger id. */
  readonly versions: Map<string, number>;
};

export type SigningToken = {
  readonly terms: CanonicalTerms;
  readonly pinned: PinnedAsset;
  /** Snapshot of the selected entry at decision time. */
  readonly requirementSnapshot: unknown;
  readonly requestId: string;
  readonly receiptReference: string;
  readonly expiresAtMs: number;
  used: boolean;
};

/** One `createPaymentPayload` call. */
export type PaymentFlow = {
  readonly id: string;
  readonly paymentRequired: unknown;
  readonly request: PaymentRequestInfo | null;
  readonly requestContext: RequestContext | null;
  /** Policy-time refusal reasons, first one wins in errors. */
  readonly dropped: { code: string; detail: string }[];
  /** The live entry x402 selected (a reference, not a copy). */
  selectedRequirements?: unknown;
  decided: boolean;
  ledgerId?: string;
  /** Set once Guardian's execute redeemed the decision. */
  redeemed?: { requestId: string; receiptReference: string };
  /** Set when `execute` was sent but its outcome is unknown (may be redeemed). */
  executeOutcomeUnknown?: { requestId: string };
  token?: SigningToken;
  signed?: { nonce: string; from: string; validBefore: number };
  signAttempted: boolean;
};

export const requestStorage = new AsyncLocalStorage<RequestContext>();
export const flowStorage = new AsyncLocalStorage<PaymentFlow>();
