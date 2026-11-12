import { randomBytes, sign as cryptoSign, createPublicKey, type KeyObject } from "node:crypto";

import {
  GUARDIAN_DEFAULT_REQUEST_TTL_MS,
  GUARDIAN_MAX_REQUEST_TTL_MS,
  type GuardianClient,
} from "@odingard/guardian-sdk";

import {
  AP2_VERSION,
  CLOCK_SKEW_SECONDS,
  DEFAULT_CLAIM_POLL_INTERVAL_MS,
  DEFAULT_GUARDIAN_CALL_TIMEOUT_MS,
  DEFAULT_MAX_OPEN_MANDATE_LIFETIME_SECONDS,
  DEFAULT_SIGNING_WINDOW_MS,
  DELEGATE_RECURRING_TOOL,
  DELEGATE_TOOL,
  KB_TERMINAL_TYP,
  MAX_CLAIM_POLL_INTERVAL_MS,
  MAX_GUARDIAN_CALL_TIMEOUT_MS,
  MAX_SIGNING_WINDOW_MS,
  PAY_ABOVE_CAP_TOOL,
  PAY_TOOL,
  SD_ALG,
  VCT,
} from "./constants.js";
import { flowStorage, type ExpectedHop, type PaymentFlow, type SigningToken } from "./context.js";
import { decideAndRedeem, type DecisionConfig } from "./decision.js";
import {
  arrayElementDisclosure,
  delegateItemOf,
  jsonSegment,
  jwkThumbprint,
  parseCompactJws,
  parseSdJwt,
  publicJwkOf,
  resolveSdJwtPayload,
  verifyEs256,
  verifyJwsWithAny,
  type PublicJwk,
} from "./jose.js";
import { Ledger, processStore, type Ap2GuardStore, type LedgerEntry } from "./ledger.js";
import {
  budgetMinor,
  checkCheckoutConstraints,
  checkPaymentConstraints,
  exponentOf,
  formatMinor,
  readAmount,
  readCheckoutJwt,
  readInstrument,
  readMerchant,
  readOpenCheckoutContent,
  readOpenMandate,
  readOpenPaymentContent,
  readPisp,
  throwIf,
  type Amount,
  type ClosedCheckoutContent,
  type ClosedPaymentContent,
  type Merchant,
  type OpenCheckoutContent,
  type OpenPaymentContent,
  type PaymentInstrument,
  type Pisp,
  type ReadCheckout,
} from "./mandates.js";
import {
  checkoutConstraintsView,
  checkoutView,
  isoFromEpoch,
  openCheckoutView,
  openPaymentView,
  paymentConstraintsView,
  paymentView,
  type DelegateTerms,
  type Mode,
  type PayTerms,
} from "./terms.js";
import {
  Ap2GuardRefused,
  b64urlDecode,
  frozenCopy,
  hasExactKeys,
  isPlainObject,
  jcs,
  refused,
  sameData,
  sha256b64url,
  termsDigestOf,
  type RefusalCode,
} from "./util.js";

// ------------------------------------------------------------------ types

/**
 * The agent key, held by your process. `sign` gets the exact JWS signing
 * input bytes and returns a raw ES256 (P-256, r||s, 64 bytes) signature.
 * The guard never sees the private key. `nodeKeySigner` builds one from a
 * Node KeyObject.
 */
export type Ap2AgentSigner = Readonly<{
  publicJwk: unknown;
  kid?: string;
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
}>;

/** Local limits for one currency, in integer minor units. */
export type CurrencyLimit = Readonly<{
  currency: string;
  /** Above this, a person must approve. */
  askAbove: number;
  /** Above this, refused locally; Guardian is not asked. */
  max: number;
  /** Optional: the only payee (merchant) ids allowed in this currency. */
  payees?: readonly string[];
}>;

export type Ap2GuardConfig = Readonly<{
  /** A Guardian client (`createGuardianClient`). */
  guardian: GuardianClient;
  /** The tool connection holding the ap2.* record-transport entries. */
  connectionId: string;
  /** The agent key's signer. The key stays in your process. */
  agentSigner: Ap2AgentSigner;
  /**
   * Public keys of your AP2 Trusted Surface (the non-agentic surface where
   * the user signs). Open mandates and human-present closed mandates must
   * verify under one of them.
   */
  trustedSurfaceKeys: readonly unknown[];
  /** Merchant id → the merchant's public keys for `checkout_jwt`. No key: refused. */
  merchantKeys: Readonly<Record<string, readonly unknown[]>>;
  /**
   * Receipt issuers by role: `checkout` maps the `iss` of Checkout Receipts
   * (the merchant) to its public keys, `payment` the `iss` of Payment
   * Receipts (the merchant payment processor). A receipt is accepted only
   * for the side its issuer is pinned for.
   */
  receiptIssuerKeys?: Readonly<{
    checkout?: Readonly<Record<string, readonly unknown[]>>;
    payment?: Readonly<Record<string, readonly unknown[]>>;
  }>;
  /** Per-currency `askAbove` and `max`. A currency with none: every payment needs a person. */
  limits?: readonly CurrencyLimit[];
  /** Durable compare-and-set store. Needed for mandates with agent_recurrence. */
  store?: Ap2GuardStore;
  /** Longest open-mandate lifetime the guard will ask a Trusted Surface to sign. Default 7 days. */
  maxOpenMandateLifetimeSeconds?: number;
  /** How long a Guardian request stays open (an ASK expires after it). Default 120 s, max 300 s. */
  requestTtlMs?: number;
  /** How long the signing token lasts after `execute`. Default 30 s, max 120 s. */
  signingWindowMs?: number;
  /** How often `claim` is polled while a person decides. Default 2 s, max 60 s. */
  claimPollIntervalMs?: number;
  /** Per-call limit on each Guardian call. Default 15 s, max 60 s. */
  guardianCallTimeoutMs?: number;
  /** Optional Guardian receipt verification keys (`fetchReceiptVerificationKeys`). */
  receiptVerificationKeys?: unknown;
  /** Called with each local record. Records never hold keys, signatures, mandates or tokens. */
  onRecord?: (record: Ap2GuardRecord) => void;
  /** Clock, for tests. */
  now?: () => number;
}>;

export type Ap2GuardRecord = Readonly<{
  at: number;
  event:
    | "refused"
    | "redeemed"
    | "signed"
    | "redeemed-not-signed"
    | "presented"
    | "receipt"
    | "delegated";
  flowId?: string;
  tool?: string;
  requestId?: string;
  receiptReference?: string;
  code?: RefusalCode;
  guardianReasonCode?: string;
  detail?: string;
  terms?: PayTerms | DelegateTerms;
  termsDigest?: string;
  reviewReasons?: readonly string[];
  approvedByPerson?: boolean;
  outcomeUnknown?: boolean;
  checkoutReference?: string;
  paymentReference?: string;
  presentedTo?: "credential-provider" | "merchant";
  receipt?: Readonly<{
    kind: "checkout" | "payment";
    status: "Success" | "Error";
    reference: string;
    iss: string;
    orderId?: string;
    paymentId?: string;
    pspConfirmationId?: string;
    networkConfirmationId?: string;
    error?: string;
    released: boolean;
    conflict: boolean;
  }>;
}>;

export type ReviewReason =
  | "NO_CAP_FOR_CURRENCY"
  | "ABOVE_ASK_ABOVE"
  | "FIRST_USE_OF_OPEN_MANDATE";

/** A verifier's challenge for one hop: the audience it names and its nonce. */
export type Challenge = Readonly<{ aud: string; nonce: string }>;

/** Human not present: the agent key signs closed mandates under open ones. */
export type Ap2PayInput = Readonly<{
  /** The open Checkout Mandate the Trusted Surface signed (`<jwt>~<disclosures>~`). */
  openCheckoutMandate: string;
  /** The open Payment Mandate the Trusted Surface signed. */
  openPaymentMandate: string;
  /** The merchant-signed checkout JWT. */
  checkoutJwt: string;
  paymentInstrument: PaymentInstrument;
  pisp?: Pisp;
  /** ISO 8601. Absent: immediate. */
  executionDate?: string;
  riskData?: Readonly<Record<string, unknown>>;
  /** Optional; must equal the checkout merchant. */
  payee?: Merchant;
  /** Optional; must equal the checkout total. */
  paymentAmount?: Amount;
  /** Optional; must equal the hash of `checkoutJwt`. */
  transactionId?: string;
  /** The merchant's challenge for the closed Checkout Mandate. */
  merchantChallenge: Challenge;
  /** The credential provider's challenge for the closed Payment Mandate. */
  credentialProviderChallenge: Challenge;
}>;

/** Human present: the Trusted Surface signs the closed mandates the guard built. */
export type Ap2PayHumanPresentInput = Readonly<{
  checkoutJwt: string;
  paymentInstrument: PaymentInstrument;
  pisp?: Pisp;
  executionDate?: string;
  riskData?: Readonly<Record<string, unknown>>;
  payee?: Merchant;
  paymentAmount?: Amount;
  transactionId?: string;
  /**
   * Shows the user the closed mandates on your Trusted Surface and returns
   * what the user signed there. Called at most once, after Guardian's
   * decision.
   */
  trustedSurface: (closed: {
    checkoutMandate: ClosedCheckoutContent;
    paymentMandate: ClosedPaymentContent;
  }) => Promise<{ checkoutMandate: string; paymentMandate: string }>;
}>;

export type Ap2DelegateInput = Readonly<{
  /** Open Checkout Mandate content. `cnf` is set by the guard to the agent key. */
  openCheckout: Readonly<Record<string, unknown>>;
  /**
   * Open Payment Mandate content, without `payment.reference`: the guard
   * adds it, set to the hash of the open checkout mandate signed here.
   */
  openPayment: Readonly<Record<string, unknown>>;
  /** Your Trusted Surface. Each is called at most once, after Guardian's decision. */
  trustedSurface: Readonly<{
    signOpenCheckout: (content: OpenCheckoutContent) => Promise<string>;
    signOpenPayment: (content: OpenPaymentContent) => Promise<string>;
  }>;
}>;

export type Ap2Delegation = Readonly<{
  openCheckoutMandate: string;
  openPaymentMandate: string;
  terms: DelegateTerms;
  termsDigest: string;
  requestId: string;
  receiptReference: string;
}>;

/**
 * Closed mandates the guard approved and signed (or the Trusted Surface
 * signed, human present). Each is presented once, through these methods.
 */
export type Ap2Presentation = Readonly<{
  terms: PayTerms;
  termsDigest: string;
  requestId: string;
  receiptReference: string;
  approvedByPerson: boolean;
  /** base64url(SHA-256(closed checkout mandate JWT)): the Checkout Receipt `reference`. */
  checkoutReference: string;
  /** base64url(SHA-256(closed payment mandate JWT)): the Payment Receipt `reference`. */
  paymentReference: string;
  /** Sends the Payment Mandate chain to the credential provider, once. */
  presentPayment<T>(send: (paymentMandate: string) => Promise<T>): Promise<T>;
  /** Sends the Checkout Mandate chain to the merchant, once. */
  presentCheckout<T>(send: (checkoutMandate: string) => Promise<T>): Promise<T>;
}>;

export type Ap2ReceiptResult = Readonly<{
  kind: "checkout" | "payment";
  status: "Success" | "Error";
  reference: string;
  error?: string;
  /** `unresolved_constraint`: the spec's way back to a human-present flow. A new decision is needed. */
  returnToHumanPresent: boolean;
  /**
   * The outstanding pair was released: a verified Error Payment Receipt, or a
   * verified Error Checkout Receipt while the payment mandate was never
   * presented.
   */
  released: boolean;
  /**
   * This receipt contradicts an earlier one (a Success Payment Receipt for a
   * released pair, or an Error after a Success). The pair counts as paid;
   * look at it by hand.
   */
  conflict: boolean;
}>;

const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

function boundedMs(name: string, value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`guardian-ap2: ${name} must be a whole number of ms from 1 to ${max}.`);
  }
  return value;
}

function pinnedKeys(list: unknown, what: string): PublicJwk[] {
  if (!Array.isArray(list)) throw new Error(`guardian-ap2: ${what} must be a list of public JWKs.`);
  return list.map((k) => {
    const pub = publicJwkOf(k);
    if (!pub) {
      throw new Error(`guardian-ap2: ${what} must hold EC P-256 public keys only (no private parts).`);
    }
    return pub;
  });
}

function pinnedKeyMap(map: unknown, what: string): Record<string, PublicJwk[]> {
  if (!isPlainObject(map)) throw new Error(`guardian-ap2: ${what} must map ids to public JWKs.`);
  const out: Record<string, PublicJwk[]> = Object.create(null) as Record<string, PublicJwk[]>;
  for (const [id, keys] of Object.entries(map)) out[id] = pinnedKeys(keys, `${what}.${id}`);
  return out;
}

/** Wraps a Node P-256 private KeyObject as an `Ap2AgentSigner`. The key stays in the KeyObject. */
export function nodeKeySigner(privateKey: KeyObject, kid?: string): Ap2AgentSigner {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return Object.freeze({
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    ...(kid !== undefined ? { kid } : {}),
    async sign(signingInput: Uint8Array) {
      return new Uint8Array(cryptoSign("sha256", signingInput, { key: privateKey, dsaEncoding: "ieee-p1363" }));
    },
  });
}

/** The reasons a payment needs a person, before Guardian is asked. */
type Plan = {
  terms: PayTerms;
  termsDigest: string;
  reasons: ReviewReason[];
  entry: LedgerEntry;
  closedCheckout: ClosedCheckoutContent;
  closedPayment: ClosedPaymentContent;
};

/**
 * Guardian for AP2 v0.2. Decides closed Checkout and Payment Mandates before
 * the agent key signs them, gates delegation requests to the Trusted Surface,
 * presents each signed pair once and reads receipts. Create with
 * `createAp2Guard`.
 */
export class Ap2Guard {
  private readonly config: Ap2GuardConfig;
  private readonly now: () => number;
  private readonly ledger: Ledger;
  private readonly durable: boolean;
  private readonly decision: DecisionConfig;
  private readonly signingWindowMs: number;
  private readonly maxLifetimeSec: number;
  private readonly agentJwk: PublicJwk;
  private readonly agentThumbprint: string;
  private readonly agentKid: string | undefined;
  private readonly agentSign: (input: Uint8Array) => Promise<Uint8Array>;
  private readonly tsKeys: PublicJwk[];
  private readonly merchantKeys: Record<string, PublicJwk[]>;
  private readonly receiptKeys: Record<"checkout" | "payment", Record<string, PublicJwk[]>>;
  private readonly limits: readonly CurrencyLimit[];
  private readonly log: Ap2GuardRecord[] = [];
  private readonly recordedRefusals = new WeakSet<Error>();

  /**
   * The only signing path for the agent key the guard knows. It signs a
   * KB-SD-JWT hop only inside a guarded `pay()` that Guardian approved, only
   * bytes that decode to the approved hop, and each hop once. Every other
   * call is refused.
   */
  declare readonly guardedSigner: Readonly<{
    sign(signingInput: string, disclosures: readonly string[]): Promise<string>;
  }>;

  constructor(config: Ap2GuardConfig) {
    this.config = config;
    this.now = config.now ?? Date.now;
    if (!config.guardian || typeof config.guardian.request !== "function") {
      throw new Error("guardian-ap2: `guardian` must be a Guardian client.");
    }
    if (typeof config.connectionId !== "string" || !config.connectionId) {
      throw new Error("guardian-ap2: `connectionId` is required.");
    }
    const signer = config.agentSigner;
    const agentJwk = signer ? publicJwkOf(signer.publicJwk) : null;
    if (!signer || !agentJwk || typeof signer.sign !== "function") {
      throw new Error("guardian-ap2: `agentSigner` needs an EC P-256 public JWK (no private parts) and sign().");
    }
    this.agentJwk = agentJwk;
    this.agentThumbprint = jwkThumbprint(agentJwk);
    this.agentKid = typeof signer.kid === "string" ? signer.kid : undefined;
    this.agentSign = (input) => signer.sign(input);
    this.tsKeys = pinnedKeys(config.trustedSurfaceKeys, "trustedSurfaceKeys");
    if (this.tsKeys.length === 0) throw new Error("guardian-ap2: pin at least one Trusted Surface key.");
    if (this.tsKeys.some((k) => jwkThumbprint(k) === this.agentThumbprint)) {
      throw new Error("guardian-ap2: the agent key cannot be a Trusted Surface key.");
    }
    this.merchantKeys = pinnedKeyMap(config.merchantKeys, "merchantKeys");
    const rk: unknown = config.receiptIssuerKeys ?? {};
    if (!isPlainObject(rk) || Object.keys(rk).some((k) => k !== "checkout" && k !== "payment")) {
      throw new Error("guardian-ap2: receiptIssuerKeys must be { checkout?: {iss: keys}, payment?: {iss: keys} }.");
    }
    this.receiptKeys = {
      checkout: pinnedKeyMap(rk.checkout ?? {}, "receiptIssuerKeys.checkout"),
      payment: pinnedKeyMap(rk.payment ?? {}, "receiptIssuerKeys.payment"),
    };
    for (const l of config.limits ?? []) {
      if (exponentOf(l.currency) === undefined) throw new Error(`guardian-ap2: limit for an unknown currency ${String(l.currency)}.`);
      for (const [name, v] of [["askAbove", l.askAbove], ["max", l.max]] as const) {
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
          throw new Error(`guardian-ap2: ${name} must be whole minor units.`);
        }
      }
      if (l.askAbove > l.max) throw new Error("guardian-ap2: askAbove must not be above max.");
    }
    const currencies = (config.limits ?? []).map((l) => l.currency);
    if (new Set(currencies).size !== currencies.length) throw new Error("guardian-ap2: one limit per currency.");
    this.limits = Object.freeze([...(config.limits ?? [])]);
    const requestTtlMs = config.requestTtlMs ?? GUARDIAN_DEFAULT_REQUEST_TTL_MS;
    boundedMs("requestTtlMs", requestTtlMs, GUARDIAN_MAX_REQUEST_TTL_MS);
    this.signingWindowMs = boundedMs("signingWindowMs", config.signingWindowMs ?? DEFAULT_SIGNING_WINDOW_MS, MAX_SIGNING_WINDOW_MS);
    const pollMs = boundedMs("claimPollIntervalMs", config.claimPollIntervalMs ?? DEFAULT_CLAIM_POLL_INTERVAL_MS, MAX_CLAIM_POLL_INTERVAL_MS);
    const callTimeoutMs = boundedMs(
      "guardianCallTimeoutMs",
      config.guardianCallTimeoutMs ?? DEFAULT_GUARDIAN_CALL_TIMEOUT_MS,
      MAX_GUARDIAN_CALL_TIMEOUT_MS,
    );
    const lifetime = config.maxOpenMandateLifetimeSeconds ?? DEFAULT_MAX_OPEN_MANDATE_LIFETIME_SECONDS;
    if (!Number.isSafeInteger(lifetime) || lifetime < 60) {
      throw new Error("guardian-ap2: maxOpenMandateLifetimeSeconds must be at least 60.");
    }
    this.maxLifetimeSec = lifetime;
    this.decision = Object.freeze({
      guardian: config.guardian,
      connectionId: config.connectionId,
      requestTtlMs,
      pollMs,
      callTimeoutMs,
      receiptVerificationKeys: config.receiptVerificationKeys,
      now: this.now,
    });
    this.durable = config.store !== undefined;
    this.ledger = new Ledger(config.store ?? processStore());
    const guardedSigner = Object.freeze({
      sign: (signingInput: string, disclosures: readonly string[]) => this.signGuarded(signingInput, disclosures),
    });
    Object.defineProperty(this, "guardedSigner", { value: guardedSigner, writable: false, configurable: false, enumerable: true });
  }

  // ---------------------------------------------------------------- records

  /** Local records (newest last). No keys, signatures, mandates, tokens or risk data values. */
  records(): readonly Ap2GuardRecord[] {
    return [...this.log];
  }

  /** The guard's ledger: one entry per closed pair (amounts, states, references). */
  async ledgerEntries(): Promise<readonly LedgerEntry[]> {
    return this.ledger.entries();
  }

  private record(r: Omit<Ap2GuardRecord, "at">): void {
    const full = Object.freeze({ at: this.now(), ...r }) as Ap2GuardRecord;
    this.log.push(full);
    try {
      this.config.onRecord?.(full);
    } catch {
      // a failing sink never changes a decision
    }
  }

  private recordRefusal(err: Ap2GuardRefused, flowId?: string): void {
    if (this.recordedRefusals.has(err)) return;
    this.recordedRefusals.add(err);
    this.record({
      event: "refused",
      ...(flowId ? { flowId } : {}),
      code: err.code,
      ...(err.guardianReasonCode ? { guardianReasonCode: err.guardianReasonCode } : {}),
      ...(err.requestId ? { requestId: err.requestId } : {}),
      ...(err.outcomeUnknown ? { outcomeUnknown: true } : {}),
      detail: err.message,
    });
  }

  private asRefusal(error: unknown, fallback: string): Ap2GuardRefused {
    return error instanceof Ap2GuardRefused ? error : refused("SIGNING_REFUSED", fallback);
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  private limitFor(currency: string): CurrencyLimit | undefined {
    return this.limits.find((l) => l.currency === currency);
  }

  private longestFlowMs(): number {
    return 4 * this.decision.callTimeoutMs + this.decision.requestTtlMs + this.decision.pollMs + this.signingWindowMs + 60_000;
  }

  /** Re-checks expiry after a decision, right before anything is signed. */
  private checkStillValid(openExps: readonly number[], checkoutExpiresAt: string | undefined): void {
    const nowSec = this.nowSec();
    if (openExps.some((exp) => nowSec > exp)) {
      throw refused("OPEN_MANDATE_EXPIRED", "An open mandate expired while the payment was decided; nothing was signed.");
    }
    if (checkoutExpiresAt !== undefined && this.now() >= Date.parse(checkoutExpiresAt)) {
      throw refused("CHECKOUT_EXPIRED", "The checkout expired while the payment was decided; nothing was signed.");
    }
  }

  // ------------------------------------------------------- closed contents

  private closedContents(
    input: Pick<Ap2PayInput, "checkoutJwt" | "paymentInstrument" | "pisp" | "executionDate" | "riskData" | "payee" | "paymentAmount" | "transactionId">,
  ): { read: ReadCheckout; closedCheckout: ClosedCheckoutContent; closedPayment: ClosedPaymentContent } {
    const read = readCheckoutJwt(input.checkoutJwt, this.merchantKeys, this.now());
    const merchant = read.checkout.merchant;
    if (input.transactionId !== undefined && input.transactionId !== read.checkoutHash) {
      throw refused("CHECKOUT_HASH_MISMATCH", "transaction_id is not the hash of this checkout_jwt.");
    }
    if (input.payee !== undefined) {
      const payee = readMerchant(input.payee, "payee");
      if (payee.id !== merchant.id || !sameData(payee, merchant)) {
        throw refused("PAYEE_MERCHANT_MISMATCH", "The payee is not the checkout's merchant.");
      }
    }
    const paymentAmount = { amount: read.total, currency: read.checkout.currency };
    if (input.paymentAmount !== undefined) {
      const given = readAmount(input.paymentAmount, "paymentAmount");
      if (!sameData(given, paymentAmount)) {
        throw refused("AMOUNT_TOTAL_MISMATCH", "The payment amount is not the checkout total, in the checkout currency.");
      }
    }
    const closedPayment: { -readonly [K in keyof ClosedPaymentContent]: ClosedPaymentContent[K] } = {
      vct: VCT.payment,
      transaction_id: read.checkoutHash,
      payee: merchant,
      payment_amount: paymentAmount,
      payment_instrument: readInstrument(input.paymentInstrument, "paymentInstrument"),
    };
    if (input.pisp !== undefined) closedPayment.pisp = readPisp(input.pisp, "pisp");
    if (input.executionDate !== undefined) {
      if (typeof input.executionDate !== "string" || Number.isNaN(Date.parse(input.executionDate))) {
        throw refused("MALFORMED_MANDATE", "executionDate must be an ISO 8601 date.");
      }
      closedPayment.execution_date = input.executionDate;
    }
    if (input.riskData !== undefined) {
      if (!isPlainObject(input.riskData)) throw refused("MALFORMED_MANDATE", "riskData must be an object.");
      try {
        closedPayment.risk_data = JSON.parse(jcs(input.riskData)) as Record<string, unknown>;
      } catch {
        throw refused("MALFORMED_MANDATE", "riskData must be plain JSON.");
      }
    }
    const closedCheckout: ClosedCheckoutContent = {
      vct: VCT.checkout,
      checkout_jwt: read.checkoutJwt,
      checkout_hash: read.checkoutHash,
    };
    return { read, closedCheckout: frozenCopy(closedCheckout), closedPayment: frozenCopy(closedPayment) };
  }

  /** Local caps: max refuses, askAbove and a missing cap need a person. */
  private capReasons(amount: number, currency: string, payeeId: string): ReviewReason[] {
    const limit = this.limitFor(currency);
    if (!limit) return ["NO_CAP_FOR_CURRENCY"];
    if (amount > limit.max) {
      throw refused("ABOVE_MAX", `${formatMinor(amount, currency)} is above the local max for ${currency}.`);
    }
    if (limit.payees && !limit.payees.includes(payeeId)) {
      throw refused("PAYEE_NOT_ALLOWED", `Payee ${payeeId} is not on the allowlist for ${currency}.`);
    }
    return amount > limit.askAbove ? ["ABOVE_ASK_ABOVE"] : [];
  }

  private challenge(c: unknown, who: string): Challenge {
    if (
      !isPlainObject(c) ||
      !hasExactKeys(c, ["aud", "nonce"]) ||
      typeof c.aud !== "string" ||
      typeof c.nonce !== "string" ||
      c.aud.length === 0 ||
      c.nonce.length < 8 ||
      c.aud.length > 512 ||
      c.nonce.length > 512
    ) {
      throw refused("INVALID_AUDIENCE", `The ${who} challenge needs an aud and a nonce (8 to 512 characters).`);
    }
    return { aud: c.aud, nonce: c.nonce };
  }

  // ------------------------------------------------- human not present (G3)

  /**
   * Human not present. Reads the open mandates and the checkout, asks
   * Guardian on the exact terms, and only after a redeemed approval signs
   * the closed Checkout and Payment Mandates with the agent key, once.
   */
  async pay(input: Ap2PayInput): Promise<Ap2Presentation> {
    const flow: PaymentFlow = { id: newId("ap2f") };
    let entryId: string | undefined;
    let redeemed: { requestId: string; receiptReference: string } | undefined;
    let outcomeUnknown: string | undefined;
    let signed = false;
    try {
      if (!isPlainObject(input)) throw refused("MALFORMED_MANDATE", "pay() needs an input object.");
      let snapshot: string;
      try {
        snapshot = jcs(input);
      } catch {
        throw refused("MALFORMED_MANDATE", "pay() input must be plain JSON data.");
      }
      const nowSec = this.nowSec();
      const merchantChallenge = this.challenge(input.merchantChallenge, "merchant");
      const cpChallenge = this.challenge(input.credentialProviderChallenge, "credential provider");
      const openCheckout = readOpenMandate<OpenCheckoutContent>(
        input.openCheckoutMandate,
        "checkout",
        this.tsKeys,
        this.agentThumbprint,
        nowSec,
      );
      const openPayment = readOpenMandate<OpenPaymentContent>(
        input.openPaymentMandate,
        "payment",
        this.tsKeys,
        this.agentThumbprint,
        nowSec,
      );
      const { read, closedCheckout, closedPayment } = this.closedContents(input);
      const why = checkCheckoutConstraints(openCheckout.content, read.checkout);
      if (why) throw refused("CONSTRAINT_VIOLATED", why);
      throwIf(checkPaymentConstraints(openPayment.content, closedPayment, openCheckout.token.sdHash));
      const recurrence = openPayment.content.constraints.find((c) => c.type === "payment.agent_recurrence");
      const budget = openPayment.content.constraints.find((c) => c.type === "payment.budget");
      if (recurrence && !this.durable) {
        throw refused("STORE_REQUIRED", "A mandate with payment.agent_recurrence needs a durable store.");
      }

      const terms: PayTerms = frozenCopy({
        schema: "odingard.guardian.ap2.pay.v1",
        ap2Version: AP2_VERSION,
        mode: "human-not-present" as Mode,
        merchant: read.checkout.merchant,
        amount: read.total,
        currency: read.checkout.currency,
        amountDisplay: formatMinor(read.total, read.checkout.currency),
        payment: paymentView(closedPayment),
        checkout: checkoutView(read, closedCheckout),
        keyBinding: {
          agentKeyThumbprint: this.agentThumbprint,
          checkout: { ...merchantChallenge, bindsToOpenMandate: openCheckout.token.sdHash },
          payment: { ...cpChallenge, bindsToOpenMandate: openPayment.token.sdHash },
        },
        openMandates: {
          checkout: openCheckoutView(openCheckout, openCheckout.issuerKey),
          payment: openPaymentView(openPayment, openPayment.issuerKey),
        },
      });
      const termsDigest = termsDigestOf(terms);
      const reasons = this.capReasons(terms.amount, terms.currency, terms.merchant.id);

      const now = this.now();
      const entry: LedgerEntry = {
        id: newId("ap2e"),
        key: openPayment.token.sdHash,
        mode: "human-not-present",
        currency: terms.currency,
        amount: terms.amount,
        createdAtMs: now,
        holdUntilMs: now + this.longestFlowMs(),
        state: "reserved",
      };
      const reserved = await this.ledger.reserve(entry, now, {
        ...(recurrence && recurrence.type === "payment.agent_recurrence"
          ? {
              recurrence: {
                frequency: recurrence.frequency,
                ...(recurrence.max_occurrences !== undefined ? { maxOccurrences: recurrence.max_occurrences } : {}),
              },
            }
          : {}),
        ...(budget && budget.type === "payment.budget" ? { budgetMinor: budgetMinor(budget.max, budget.currency) } : {}),
      });
      entryId = entry.id;
      if (reserved.firstUse) reasons.push("FIRST_USE_OF_OPEN_MANDATE");

      const plan: Plan = { terms, termsDigest, reasons, entry, closedCheckout, closedPayment };
      const decided = await this.decidePay(plan, flow, {
        onRedeemed: (r) => (redeemed = r),
        onOutcomeUnknown: (id) => (outcomeUnknown = id),
      });

      // Nothing the caller passed may have changed while a person decided.
      if (!sameData(JSON.parse(snapshot), input)) {
        throw refused("TERMS_CHANGED", "The payment input changed after the decision.");
      }
      // A person may have taken minutes; nothing signs under an expired open mandate or checkout.
      this.checkStillValid([openCheckout.content.exp, openPayment.content.exp], read.checkout.expires_at);
      const token: SigningToken = {
        terms,
        termsDigest,
        requestId: decided.requestId,
        receiptReference: decided.receiptReference,
        expiresAtMs: this.now() + this.signingWindowMs,
        hops: Object.freeze([
          Object.freeze({ kind: "checkout" as const, ...merchantChallenge, sdHash: openCheckout.token.sdHash, content: closedCheckout }),
          Object.freeze({ kind: "payment" as const, ...cpChallenge, sdHash: openPayment.token.sdHash, content: closedPayment }),
        ]),
        used: new Set(),
      };
      flow.token = token;
      await this.ledger.patch(entry.id, (e) => {
        if (e.state !== "reserved") {
          throw refused("SIGNING_REFUSED", "This payment's reservation was released; nothing was signed.");
        }
        e.state = "signing";
        e.requestId = decided.requestId;
      });
      signed = true; // from here a signature may exist; the entry stays counted
      const { checkoutChain, paymentChain } = await flowStorage.run(flow, async () => {
        const checkoutHop = await this.buildAndSignHop(token.hops[0]!);
        const paymentHop = await this.buildAndSignHop(token.hops[1]!);
        return {
          checkoutChain: `${openCheckout.token.sdJwt.slice(0, -1)}~~${checkoutHop}`,
          paymentChain: `${openPayment.token.sdJwt.slice(0, -1)}~~${paymentHop}`,
        };
      });
      return await this.finishSigned(flow.id, plan, decided, checkoutChain, paymentChain);
    } catch (error) {
      const err = this.asRefusal(error, "The guard failed; nothing was signed or presented.");
      this.recordRefusal(err, flow.id);
      if (!signed) {
        if (redeemed) {
          this.record({
            event: "redeemed-not-signed",
            flowId: flow.id,
            requestId: redeemed.requestId,
            receiptReference: redeemed.receiptReference,
            detail: "Redeemed, not signed. The decision is spent; a retry needs a new decision.",
          });
        } else if (outcomeUnknown) {
          this.record({
            event: "redeemed-not-signed",
            flowId: flow.id,
            requestId: outcomeUnknown,
            outcomeUnknown: true,
            detail: "Redeemed or unknown, not signed. Look up the request before retrying; a retry needs a new decision.",
          });
        }
        if (entryId) await this.ledger.releaseUnsigned(entryId).catch(() => undefined);
      }
      throw err;
    }
  }

  private async decidePay(
    plan: Plan,
    flow: PaymentFlow,
    hooks: Parameters<typeof decideAndRedeem>[5],
  ): Promise<{ requestId: string; receiptReference: string; approvedByPerson: boolean; tool: string }> {
    const aboveCap = plan.reasons.length > 0;
    const tool = aboveCap ? PAY_ABOVE_CAP_TOOL : PAY_TOOL;
    const args = { ...plan.terms, termsDigest: plan.termsDigest, reviewReasons: [...plan.reasons] };
    const purpose = `Pay ${plan.terms.amountDisplay} to ${plan.terms.merchant.name} over AP2 (${plan.terms.mode})${
      aboveCap ? ", needs a person's approval" : ""
    }`;
    const r = await decideAndRedeem(this.decision, tool, args, purpose, aboveCap, hooks);
    this.record({
      event: "redeemed",
      flowId: flow.id,
      tool,
      requestId: r.requestId,
      receiptReference: r.receiptReference,
      terms: plan.terms,
      termsDigest: plan.termsDigest,
      reviewReasons: [...plan.reasons],
      approvedByPerson: r.approvedByPerson,
    });
    return { ...r, tool };
  }

  private async finishSigned(
    flowId: string,
    plan: Plan,
    decided: { requestId: string; receiptReference: string; approvedByPerson: boolean },
    checkoutChain: string,
    paymentChain: string,
  ): Promise<Ap2Presentation> {
    const leaf = (chain: string) => chain.slice(chain.lastIndexOf("~~") + 2).split("~", 1)[0]!;
    const checkoutReference = sha256b64url(leaf(checkoutChain));
    const paymentReference = sha256b64url(leaf(paymentChain));
    await this.ledger
      .patch(plan.entry.id, (e) => {
        e.state = "signed";
        e.checkoutReference = checkoutReference;
        e.paymentReference = paymentReference;
      })
      .catch(() => undefined); // stays "signing": still counted and outstanding
    this.record({
      event: "signed",
      flowId,
      requestId: decided.requestId,
      receiptReference: decided.receiptReference,
      termsDigest: plan.termsDigest,
      checkoutReference,
      paymentReference,
    });
    return this.presentation(plan, decided, checkoutReference, paymentReference, checkoutChain, paymentChain);
  }

  private presentation(
    plan: Plan,
    decided: { requestId: string; receiptReference: string; approvedByPerson: boolean },
    checkoutReference: string,
    paymentReference: string,
    checkoutChain: string,
    paymentChain: string,
  ): Ap2Presentation {
    const sent = { checkout: false, payment: false };
    const present = async <T>(
      which: "checkout" | "payment",
      send: (chain: string) => Promise<T>,
    ): Promise<T> => {
      if (typeof send !== "function") throw refused("ALREADY_PRESENTED", "present needs a send function.");
      if (sent[which]) {
        const err = refused("ALREADY_PRESENTED", `This ${which} mandate was already presented; it is presented once.`);
        this.recordRefusal(err);
        throw err;
      }
      sent[which] = true; // synchronously, so two concurrent calls cannot both send
      await this.ledger.patch(plan.entry.id, (e) => {
        if (e.state === "released") {
          throw refused("PAIR_RELEASED", "A verified Error receipt released this pair; it is not presented.");
        }
        e.presentedTo = { ...(e.presentedTo ?? {}), [which]: true };
        if (e.state === "signed" || e.state === "signing") e.state = "presented";
      }).catch((error: unknown) => {
        sent[which] = false; // nothing was sent
        const err = this.asRefusal(error, "The guard's store failed; nothing was presented.");
        this.recordRefusal(err);
        throw err;
      });
      this.record({
        event: "presented",
        requestId: decided.requestId,
        presentedTo: which === "payment" ? "credential-provider" : "merchant",
        ...(which === "payment" ? { paymentReference } : { checkoutReference }),
      });
      return send(which === "payment" ? paymentChain : checkoutChain);
    };
    return Object.freeze({
      terms: plan.terms,
      termsDigest: plan.termsDigest,
      requestId: decided.requestId,
      receiptReference: decided.receiptReference,
      approvedByPerson: decided.approvedByPerson,
      checkoutReference,
      paymentReference,
      presentPayment: <T>(send: (paymentMandate: string) => Promise<T>) => present("payment", send),
      presentCheckout: <T>(send: (checkoutMandate: string) => Promise<T>) => present("checkout", send),
    });
  }

  // -------------------------------------------------------------- the signer

  /** Builds the terminal KB-SD-JWT hop from the approved terms and signs it through the guarded signer. */
  private async buildAndSignHop(hop: ExpectedHop): Promise<string> {
    const header: Record<string, unknown> = { alg: "ES256", typ: KB_TERMINAL_TYP };
    if (this.agentKid !== undefined) header.kid = this.agentKid;
    const disclosure = arrayElementDisclosure(randomBytes(16).toString("base64url"), hop.content);
    const payload = {
      _sd_alg: SD_ALG,
      aud: hop.aud,
      delegate_payload: [{ "...": sha256b64url(disclosure) }],
      iat: this.nowSec(),
      nonce: hop.nonce,
      sd_hash: hop.sdHash,
    };
    const signingInput = `${jsonSegment(header)}.${jsonSegment(payload)}`;
    const sig = await this.signGuarded(signingInput, [disclosure]);
    return `${signingInput}.${sig}~${disclosure}~`;
  }

  private async signGuarded(signingInput: string, disclosures: readonly string[]): Promise<string> {
    const flow = flowStorage.getStore();
    try {
      return await this.signChecked(flow, signingInput, disclosures);
    } catch (error) {
      const err = this.asRefusal(error, "The agent key failed to sign.");
      this.recordRefusal(err, flow?.id);
      throw err;
    }
  }

  private async signChecked(
    flow: PaymentFlow | undefined,
    signingInput: string,
    disclosures: readonly string[],
  ): Promise<string> {
    if (!flow) throw refused("NO_PAYMENT_FLOW", "Signing outside a guarded AP2 payment is refused.");
    const token = flow.token;
    if (!token) throw refused("NO_SIGNING_TOKEN", "No approved payment in this flow.");
    if (this.now() > token.expiresAtMs) throw refused("SIGNING_TOKEN_EXPIRED", "The approval's signing window has passed.");
    if (token.used.size >= token.hops.length) throw refused("SIGNING_TOKEN_USED", "This approval was already used to sign.");
    if (termsDigestOf(token.terms) !== token.termsDigest) {
      throw refused("TERMS_CHANGED", "The approved terms changed.");
    }
    const hop = this.checkSigningInput(signingInput, disclosures, token);
    if (token.used.has(hop.kind)) throw refused("SIGNING_TOKEN_USED", `The ${hop.kind} mandate was already signed under this approval.`);
    token.used.add(hop.kind);
    let sig: Uint8Array;
    try {
      sig = await this.agentSign(Buffer.from(signingInput, "ascii"));
    } catch {
      throw refused("SIGNING_REFUSED", "The agent key failed to sign.");
    }
    if (!(sig instanceof Uint8Array) || !verifyEs256(this.agentJwk, signingInput, sig)) {
      throw refused("SIGNING_REFUSED", "The agent signer returned a signature that does not verify under its public key.");
    }
    return Buffer.from(sig).toString("base64url");
  }

  /** The exact bytes to sign must decode to one approved hop, field by field. */
  private checkSigningInput(signingInput: string, disclosures: readonly string[], token: SigningToken): ExpectedHop {
    const bad = (field: string) =>
      refused("SIGNING_INPUT_MISMATCH", `The bytes to sign do not match the approved mandate (${field}).`);
    if (typeof signingInput !== "string" || !Array.isArray(disclosures)) throw bad("shape");
    const parts = signingInput.split(".");
    if (parts.length !== 2) throw bad("shape");
    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(b64urlDecode(parts[0]!).toString("utf8"));
      payload = JSON.parse(b64urlDecode(parts[1]!).toString("utf8"));
    } catch {
      throw bad("encoding");
    }
    if (!isPlainObject(header)) throw bad("header");
    const headerKeys = this.agentKid !== undefined ? ["alg", "typ", "kid"] : ["alg", "typ"];
    if (!hasExactKeys(header, headerKeys)) throw bad("header fields");
    if (header.alg !== "ES256") throw bad("alg");
    if (header.typ !== KB_TERMINAL_TYP) throw bad("typ");
    if (this.agentKid !== undefined && header.kid !== this.agentKid) throw bad("kid");
    if (!isPlainObject(payload)) throw bad("payload");
    if (!hasExactKeys(payload, ["_sd_alg", "aud", "delegate_payload", "iat", "nonce", "sd_hash"])) throw bad("payload fields");
    if (payload._sd_alg !== SD_ALG) throw bad("_sd_alg");
    const nowSec = this.nowSec();
    if (
      typeof payload.iat !== "number" ||
      !Number.isSafeInteger(payload.iat) ||
      Math.abs(payload.iat - nowSec) > CLOCK_SKEW_SECONDS
    ) {
      throw bad("iat");
    }
    const hop = token.hops.find((h) => h.sdHash === payload.sd_hash);
    if (!hop) throw bad("sd_hash");
    if (payload.aud !== hop.aud) throw bad("aud");
    if (payload.nonce !== hop.nonce) throw bad("nonce");
    const dp = payload.delegate_payload;
    if (
      !Array.isArray(dp) ||
      dp.length !== 1 ||
      !isPlainObject(dp[0]) ||
      !hasExactKeys(dp[0], ["..."]) ||
      typeof dp[0]["..."] !== "string"
    ) {
      throw bad("delegate_payload");
    }
    if (disclosures.length !== 1 || typeof disclosures[0] !== "string") throw bad("disclosures");
    if (sha256b64url(disclosures[0]) !== dp[0]["..."]) throw bad("disclosure digest");
    let arr: unknown;
    try {
      arr = JSON.parse(b64urlDecode(disclosures[0]).toString("utf8"));
    } catch {
      throw bad("disclosure");
    }
    if (!Array.isArray(arr) || arr.length !== 2 || typeof arr[0] !== "string" || arr[0].length < 16) throw bad("disclosure");
    if (!sameData(arr[1], hop.content)) throw bad("mandate content");
    return hop;
  }

  // ------------------------------------------------------ human present (G2)

  /**
   * Human present. Asks Guardian on the exact terms, then hands the closed
   * mandates to your Trusted Surface once; presents only what the user
   * signed there if it is exactly what was approved.
   */
  async payHumanPresent(input: Ap2PayHumanPresentInput): Promise<Ap2Presentation> {
    const flowId = newId("ap2f");
    let entryId: string | undefined;
    let redeemed: { requestId: string; receiptReference: string } | undefined;
    let outcomeUnknown: string | undefined;
    try {
      if (!isPlainObject(input) || typeof input.trustedSurface !== "function") {
        throw refused("MALFORMED_MANDATE", "payHumanPresent() needs input with a trustedSurface function.");
      }
      const { trustedSurface, ...data } = input;
      let snapshot: string;
      try {
        snapshot = jcs(data);
      } catch {
        throw refused("MALFORMED_MANDATE", "payHumanPresent() input must be plain JSON data.");
      }
      const { read, closedCheckout, closedPayment } = this.closedContents(data);
      const terms: PayTerms = frozenCopy({
        schema: "odingard.guardian.ap2.pay.v1",
        ap2Version: AP2_VERSION,
        mode: "human-present" as Mode,
        merchant: read.checkout.merchant,
        amount: read.total,
        currency: read.checkout.currency,
        amountDisplay: formatMinor(read.total, read.checkout.currency),
        payment: paymentView(closedPayment),
        checkout: checkoutView(read, closedCheckout),
        keyBinding: null,
        openMandates: null,
      });
      const termsDigest = termsDigestOf(terms);
      const reasons = this.capReasons(terms.amount, terms.currency, terms.merchant.id);
      const now = this.now();
      const entry: LedgerEntry = {
        id: newId("ap2e"),
        key: `hp:${read.checkoutHash}`,
        mode: "human-present",
        currency: terms.currency,
        amount: terms.amount,
        createdAtMs: now,
        holdUntilMs: now + this.longestFlowMs(),
        state: "reserved",
      };
      await this.ledger.reserve(entry, now, {});
      entryId = entry.id;
      const plan: Plan = { terms, termsDigest, reasons, entry, closedCheckout, closedPayment };
      const decided = await this.decidePay(plan, { id: flowId }, {
        onRedeemed: (r) => (redeemed = r),
        onOutcomeUnknown: (id) => (outcomeUnknown = id),
      });
      if (!sameData(JSON.parse(snapshot), data)) {
        throw refused("TERMS_CHANGED", "The payment input changed after the decision.");
      }
      this.checkStillValid([], read.checkout.expires_at);
      await this.ledger.patch(entry.id, (e) => {
        if (e.state !== "reserved") throw refused("SIGNING_REFUSED", "This payment's reservation was released.");
        e.state = "signing";
        e.requestId = decided.requestId;
      });
      let returned: unknown;
      try {
        returned = await flowStorage.exit(() => trustedSurface(frozenCopy({ checkoutMandate: closedCheckout, paymentMandate: closedPayment })));
      } catch {
        await this.ledger.patch(entry.id, (e) => {
          if (e.state === "signing") e.state = "released";
        }).catch(() => undefined);
        throw refused("SIGNING_REFUSED", "The Trusted Surface did not return signed mandates.");
      }
      const check = (raw: unknown, expected: ClosedCheckoutContent | ClosedPaymentContent, what: string): string => {
        let item: Record<string, unknown>;
        try {
          const tok = parseSdJwt(raw);
          if (!verifyJwsWithAny(tok.jws, this.tsKeys)) throw new Error("sig");
          item = delegateItemOf(resolveSdJwtPayload(tok));
        } catch {
          throw refused("MANDATE_CONTENT_MISMATCH", `The ${what} mandate from the Trusted Surface does not verify under a pinned key.`);
        }
        const { iat, exp, ...rest } = item;
        for (const t of [iat, exp]) {
          if (t !== undefined && (typeof t !== "number" || !Number.isSafeInteger(t))) {
            throw refused("MANDATE_CONTENT_MISMATCH", `The ${what} mandate has a malformed iat or exp.`);
          }
        }
        if (typeof exp === "number" && this.nowSec() > exp) {
          throw refused("MANDATE_CONTENT_MISMATCH", `The ${what} mandate from the Trusted Surface has expired.`);
        }
        if (termsDigestOf(rest) !== termsDigestOf(expected)) {
          throw refused("MANDATE_CONTENT_MISMATCH", `The ${what} mandate the user signed is not the one Guardian approved; it is not presented.`);
        }
        return raw as string;
      };
      let checkoutMandate: string;
      let paymentMandate: string;
      try {
        if (!isPlainObject(returned)) throw refused("MANDATE_CONTENT_MISMATCH", "The Trusted Surface returned no mandates.");
        checkoutMandate = check(returned.checkoutMandate, closedCheckout, "checkout");
        paymentMandate = check(returned.paymentMandate, closedPayment, "payment");
      } catch (e) {
        // Not presented by the guard; the user's signature covers other content.
        await this.ledger.patch(entry.id, (x) => {
          if (x.state === "signing") x.state = "released";
        }).catch(() => undefined);
        throw e;
      }
      const leaf = (t: string) => t.split("~", 1)[0]!;
      const checkoutReference = sha256b64url(leaf(checkoutMandate));
      const paymentReference = sha256b64url(leaf(paymentMandate));
      await this.ledger
        .patch(entry.id, (e) => {
          e.state = "signed";
          e.checkoutReference = checkoutReference;
          e.paymentReference = paymentReference;
        })
        .catch(() => undefined);
      this.record({
        event: "signed",
        flowId,
        requestId: decided.requestId,
        receiptReference: decided.receiptReference,
        termsDigest,
        checkoutReference,
        paymentReference,
        detail: "Signed by the Trusted Surface; content matches the approved terms.",
      });
      return this.presentation(plan, decided, checkoutReference, paymentReference, checkoutMandate, paymentMandate);
    } catch (error) {
      const err = this.asRefusal(error, "The guard failed; nothing was presented.");
      this.recordRefusal(err, flowId);
      if (redeemed && err.code !== "MANDATE_CONTENT_MISMATCH") {
        this.record({
          event: "redeemed-not-signed",
          flowId,
          requestId: redeemed.requestId,
          receiptReference: redeemed.receiptReference,
          detail: "Redeemed, not presented. The decision is spent; a retry needs a new decision.",
        });
      } else if (!redeemed && outcomeUnknown) {
        this.record({
          event: "redeemed-not-signed",
          flowId,
          requestId: outcomeUnknown,
          outcomeUnknown: true,
          detail: "Redeemed or unknown, not presented. Look up the request before retrying.",
        });
      }
      if (entryId) await this.ledger.releaseUnsigned(entryId).catch(() => undefined);
      throw err;
    }
  }

  // ------------------------------------------------------------ delegation (G1)

  /**
   * Asks Guardian before the Trusted Surface is asked to sign open mandates
   * for the agent key. Always needs a person; a rule ALLOW is refused.
   * The guard never signs open mandates and is not the Trusted Surface.
   */
  async delegate(input: Ap2DelegateInput): Promise<Ap2Delegation> {
    const flowId = newId("ap2d");
    try {
      if (
        !isPlainObject(input) ||
        !isPlainObject(input.trustedSurface) ||
        typeof input.trustedSurface.signOpenCheckout !== "function" ||
        typeof input.trustedSurface.signOpenPayment !== "function"
      ) {
        throw refused("MALFORMED_MANDATE", "delegate() needs content and a trustedSurface with signOpenCheckout and signOpenPayment.");
      }
      const { trustedSurface, ...data } = input;
      let snapshot: string;
      try {
        snapshot = jcs(data);
      } catch {
        throw refused("MALFORMED_MANDATE", "delegate() content must be plain JSON data.");
      }
      const nowSec = this.nowSec();
      const withCnf = (c: unknown, what: string): Record<string, unknown> => {
        if (!isPlainObject(c)) throw refused("MALFORMED_MANDATE", `${what} must be an object.`);
        if (c.cnf !== undefined) {
          const jwk = isPlainObject(c.cnf) ? publicJwkOf(c.cnf.jwk) : null;
          if (!jwk || jwkThumbprint(jwk) !== this.agentThumbprint) {
            throw refused("CNF_NOT_AGENT_KEY", `${what} delegates to another key (cnf), not this guard's agent key.`);
          }
        }
        return { ...c, cnf: { jwk: { kty: "EC", crv: "P-256", x: this.agentJwk.x, y: this.agentJwk.y } } };
      };
      const checkoutContent = readOpenCheckoutContent(withCnf(data.openCheckout, "openCheckout"), "openCheckout");
      const paymentInput = withCnf(data.openPayment, "openPayment");
      if (Array.isArray(paymentInput.constraints) && paymentInput.constraints.some((c) => isPlainObject(c) && c.type === "payment.reference")) {
        throw refused("MALFORMED_MANDATE", "Leave payment.reference out; the guard sets it to the signed open checkout mandate's hash.");
      }
      const paymentContent = readOpenPaymentContent(paymentInput, "openPayment");
      for (const [what, c] of [["openCheckout", checkoutContent], ["openPayment", paymentContent]] as const) {
        if (c.exp <= nowSec) throw refused("OPEN_MANDATE_EXPIRED", `${what}.exp is in the past.`);
        if (c.exp - nowSec > this.maxLifetimeSec) {
          throw refused("OPEN_MANDATE_LIFETIME_TOO_LONG", `${what} would be valid for longer than ${this.maxLifetimeSec} s.`);
        }
      }
      const range = paymentContent.constraints.find((c) => c.type === "payment.amount_range");
      if (!range || range.type !== "payment.amount_range") {
        throw refused("MISSING_FIELD", "An open payment mandate needs payment.amount_range.");
      }
      const recurrence = paymentContent.constraints.find((c) => c.type === "payment.agent_recurrence");
      const budget = paymentContent.constraints.find((c) => c.type === "payment.budget");
      if (recurrence && !budget) throw refused("MISSING_FIELD", "payment.agent_recurrence needs payment.budget.");
      if (budget && budget.type === "payment.budget" && budget.currency !== range.currency) {
        throw refused("MALFORMED_MANDATE", "payment.budget and payment.amount_range must use one currency.");
      }
      if (recurrence && !this.durable) throw refused("STORE_REQUIRED", "A recurring delegation needs a durable store.");
      const limit = this.limitFor(range.currency);
      if (!limit) throw refused("NO_CAP_FOR_CURRENCY", `No local cap is set for ${range.currency}; set one before delegating.`);
      if (range.max > limit.max) {
        throw refused("ABOVE_MAX", `The open mandate's maximum ${formatMinor(range.max, range.currency)} is above the local max.`);
      }

      const terms: DelegateTerms = frozenCopy({
        schema: "odingard.guardian.ap2.delegate.v1",
        ap2Version: AP2_VERSION,
        mode: "human-not-present" as const,
        recurring: recurrence !== undefined,
        agentKeyThumbprint: this.agentThumbprint,
        currency: range.currency,
        amountMax: range.max,
        amountMaxDisplay: formatMinor(range.max, range.currency),
        openCheckout: {
          vct: checkoutContent.vct,
          issuedAt: isoFromEpoch(checkoutContent.iat),
          expiresAt: isoFromEpoch(checkoutContent.exp),
          lifetimeSeconds: checkoutContent.exp - nowSec,
          constraints: checkoutConstraintsView(checkoutContent.constraints),
        },
        openPayment: {
          vct: paymentContent.vct,
          issuedAt: isoFromEpoch(paymentContent.iat),
          expiresAt: isoFromEpoch(paymentContent.exp),
          lifetimeSeconds: paymentContent.exp - nowSec,
          constraints: paymentConstraintsView(paymentContent.constraints),
          paymentReference: "Set by the guard to the hash of the open checkout mandate signed in this delegation",
          presets: {
            payee: paymentContent.payee ?? null,
            paymentAmount: paymentContent.payment_amount
              ? { ...paymentContent.payment_amount, display: formatMinor(paymentContent.payment_amount.amount, paymentContent.payment_amount.currency) }
              : null,
            paymentInstrument: paymentContent.payment_instrument ?? null,
            pisp: paymentContent.pisp ?? null,
            executionDate: paymentContent.execution_date ?? null,
            riskDataKeys: paymentContent.risk_data ? Object.keys(paymentContent.risk_data).sort() : [],
            riskDataDigest: paymentContent.risk_data ? termsDigestOf(paymentContent.risk_data) : null,
          },
        },
      });
      const termsDigest = termsDigestOf(terms);
      const tool = terms.recurring ? DELEGATE_RECURRING_TOOL : DELEGATE_TOOL;
      const args = { ...terms, termsDigest };
      const purpose = `Let the agent pay up to ${terms.amountMaxDisplay} per payment over AP2, without the user present${
        terms.recurring ? ", recurring" : ""
      }; needs a person's approval`;
      const decided = await decideAndRedeem(this.decision, tool, args, purpose, true);
      this.record({
        event: "redeemed",
        flowId,
        tool,
        requestId: decided.requestId,
        receiptReference: decided.receiptReference,
        terms,
        termsDigest,
        approvedByPerson: true,
      });
      if (!sameData(JSON.parse(snapshot), data)) throw refused("TERMS_CHANGED", "The delegation content changed after the decision.");

      const verifyReturned = <C extends OpenCheckoutContent | OpenPaymentContent>(
        raw: unknown,
        kind: "checkout" | "payment",
        expected: C,
      ) => {
        const m = readOpenMandate<C>(raw, kind, this.tsKeys, this.agentThumbprint, this.nowSec());
        if (termsDigestOf(m.content) !== termsDigestOf(expected)) {
          throw refused("MANDATE_CONTENT_MISMATCH", `The open ${kind} mandate the Trusted Surface signed is not the one Guardian approved.`);
        }
        return m;
      };
      const checkoutToSign = frozenCopy(checkoutContent);
      const signedCheckout = await flowStorage.exit(() => trustedSurface.signOpenCheckout(checkoutToSign));
      const openCheckout = verifyReturned(signedCheckout, "checkout", checkoutToSign);
      const paymentToSign: OpenPaymentContent = frozenCopy({
        ...paymentContent,
        constraints: [
          ...paymentContent.constraints,
          { type: "payment.reference" as const, conditional_transaction_id: openCheckout.token.sdHash },
        ],
      });
      const signedPayment = await flowStorage.exit(() => trustedSurface.signOpenPayment(paymentToSign));
      const openPayment = verifyReturned(signedPayment, "payment", paymentToSign);
      // A person approved this open mandate here, so its first payment may follow a rule.
      await this.ledger.markDelegated(openPayment.token.sdHash, openPayment.content.exp * 1000, this.now());
      this.record({
        event: "delegated",
        flowId,
        requestId: decided.requestId,
        receiptReference: decided.receiptReference,
        termsDigest,
      });
      return Object.freeze({
        openCheckoutMandate: signedCheckout as string,
        openPaymentMandate: signedPayment as string,
        terms,
        termsDigest,
        requestId: decided.requestId,
        receiptReference: decided.receiptReference,
      });
    } catch (error) {
      const err = this.asRefusal(error, "The guard failed; no delegation was made.");
      this.recordRefusal(err, flowId);
      throw err;
    }
  }

  // ---------------------------------------------------------------- receipts (G5)

  /**
   * Verifies a Checkout or Payment Receipt (ES256, pinned issuer key,
   * `reference` = a closed mandate this guard signed or presented) and
   * updates the ledger. Only a verified Error receipt releases an
   * outstanding pair; a verified Success payment receipt completes it.
   */
  async recordReceipt(receiptJwt: string): Promise<Ap2ReceiptResult> {
    try {
      let jws;
      try {
        jws = parseCompactJws(receiptJwt);
      } catch {
        throw refused("RECEIPT_INVALID", "The receipt is not a compact JWS.");
      }
      const p = jws.payload;
      if (typeof p.iss !== "string") throw refused("RECEIPT_INVALID", "The receipt has no issuer.");
      const iss = p.iss;
      // The roles this issuer is pinned for, and whose key the signature verifies under.
      const roles = (["checkout", "payment"] as const).filter((role) => {
        const keys = Object.prototype.hasOwnProperty.call(this.receiptKeys[role], iss) ? this.receiptKeys[role][iss]! : [];
        return keys.length > 0 && verifyJwsWithAny(jws, keys);
      });
      if (roles.length === 0) {
        throw refused("RECEIPT_INVALID", "The receipt is not signed by a pinned key of its issuer.");
      }
      if (p.status !== "Success" && p.status !== "Error") throw refused("RECEIPT_INVALID", "The receipt status is not Success or Error.");
      if (typeof p.reference !== "string" || typeof p.iat !== "number") throw refused("RECEIPT_INVALID", "The receipt has no reference or iat.");
      const status = p.status;
      const reference = p.reference;
      const s = (k: string) => (typeof p[k] === "string" && (p[k] as string).length > 0 ? (p[k] as string) : undefined);
      if (status === "Error" && (!s("error") || !s("error_description"))) {
        throw refused("RECEIPT_INVALID", "An Error receipt needs error and error_description.");
      }
      let released = false;
      let conflict = false;
      const found = await this.ledger.patchByReference(reference, (e, which) => {
        if (!roles.includes(which)) {
          throw refused(
            "RECEIPT_INVALID",
            `The issuer ${iss} is not pinned for ${which} receipts; a ${which} receipt must come from a ${which === "payment" ? "payment processor" : "merchant"} key.`,
          );
        }
        if (status === "Success") {
          if (which === "checkout" && !s("order_id")) throw refused("RECEIPT_INVALID", "A Success checkout receipt needs order_id.");
          if (which === "payment" && (!s("payment_id") || !s("psp_confirmation_id") || !s("network_confirmation_id"))) {
            throw refused("RECEIPT_INVALID", "A Success payment receipt needs payment_id, psp_confirmation_id and network_confirmation_id.");
          }
        }
        const previous = e.receipts?.[which];
        e.receipts = { ...(e.receipts ?? {}), [which]: status };
        if (previous !== undefined && previous !== status) conflict = true;
        if (which === "payment" && status === "Success") {
          // Money moved: the pair counts, even if an earlier receipt released it.
          if (e.state === "released") conflict = true;
          e.state = "complete";
        } else if (status === "Error" && e.state !== "complete" && e.state !== "released") {
          // A checkout Error does not undo a payment mandate already given to the
          // credential provider: only the payment side can release that.
          if (which === "payment" || !e.presentedTo?.payment) {
            e.state = "released";
            released = true;
          }
        } else if (which === "payment" && status === "Error" && e.state === "complete") {
          conflict = true;
        }
        if (conflict) e.conflict = true;
      });
      if (!found) throw refused("RECEIPT_INVALID", "The receipt references no closed mandate this guard signed.");
      const error = s("error");
      this.record({
        event: "receipt",
        ...(found.entry.requestId ? { requestId: found.entry.requestId } : {}),
        receipt: {
          kind: found.which,
          status,
          reference,
          iss: p.iss,
          ...(s("order_id") ? { orderId: s("order_id")! } : {}),
          ...(s("payment_id") ? { paymentId: s("payment_id")! } : {}),
          ...(s("psp_confirmation_id") ? { pspConfirmationId: s("psp_confirmation_id")! } : {}),
          ...(s("network_confirmation_id") ? { networkConfirmationId: s("network_confirmation_id")! } : {}),
          ...(error ? { error } : {}),
          released,
          conflict,
        },
      });
      return Object.freeze({
        kind: found.which,
        status,
        reference,
        ...(error ? { error } : {}),
        returnToHumanPresent: error === "unresolved_constraint",
        released,
        conflict,
      });
    } catch (error) {
      const err = this.asRefusal(error, "The receipt could not be read.");
      this.recordRefusal(err);
      throw err;
    }
  }
}

/** Builds the AP2 guard. */
export function createAp2Guard(config: Ap2GuardConfig): Ap2Guard {
  return new Ap2Guard(config);
}
