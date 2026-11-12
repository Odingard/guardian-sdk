import { randomBytes } from "node:crypto";

import {
  classifyRequestResult,
  verifyReceiptOffline,
  GUARDIAN_DEFAULT_REQUEST_TTL_MS,
  GUARDIAN_MAX_REQUEST_TTL_MS,
  type GuardianClient,
} from "@odingard/guardian-sdk";
import {
  x402Client,
  x402HTTPClient,
  type PaymentCreatedContext,
  type PaymentCreationContext,
  type PaymentPolicy,
  type PaymentResponseContext,
  type SelectPaymentRequirements,
  type SpendControls,
} from "@x402/core/client";
import type {
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
} from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  DEFAULT_CLAIM_POLL_INTERVAL_MS,
  DEFAULT_GUARDIAN_CALL_TIMEOUT_MS,
  DEFAULT_MAX_TIMEOUT_SECONDS_LIMIT,
  DEFAULT_SIGNING_WINDOW_MS,
  EIP3009_TYPES,
  MAX_CLAIM_POLL_INTERVAL_MS,
  MAX_GUARDIAN_CALL_TIMEOUT_MS,
  MAX_SIGNING_WINDOW_MS,
  RECONCILE_MARGIN_MS,
  PAY_ABOVE_CAP_TOOL,
  PAY_TOOL,
  pinnedAsset,
  type SupportedNetwork,
} from "./constants.js";
import {
  flowStorage,
  requestStorage,
  type PaymentFlow,
  type RequestContext,
  type SigningToken,
} from "./context.js";
import {
  isLive,
  Ledger,
  processStore,
  type AuthorizationStateReader,
  type BudgetConfig,
  type LedgerEntry,
  type X402GuardStore,
} from "./ledger.js";
import {
  readTerms,
  requestKeyOf,
  type CanonicalTerms,
  type PaymentRequestInfo,
  type TermsOptions,
} from "./terms.js";
import {
  ADDRESS_RE,
  ATOMIC_RE,
  frozenCopy,
  isPlainObject,
  sameData,
  sleep,
  withTimeout,
  X402GuardRefused,
  type RefusalCode,
} from "./util.js";
import { assertSupportedX402 } from "./version.js";

/** The wallet the guard signs with. A viem local account fits. */
export type X402WalletSigner = {
  readonly address: `0x${string}`;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
};

/** Local limits for one pinned asset, in its atomic units. */
export type AssetLimit = Readonly<{
  network: SupportedNetwork;
  asset: string;
  /** Above this, the payment needs a person's approval. */
  askAbove: string;
  /** Above this, the payment is refused locally. */
  max: string;
  /** Optional: the only recipients allowed for this asset. */
  payTo?: readonly string[];
}>;

export type X402GuardConfig = Readonly<{
  /** A Guardian client (`createGuardianClient`). */
  guardian: GuardianClient;
  /** The tool connection holding the `x402.pay` and `x402.pay.above_cap` entries. */
  connectionId: string;
  /** The wallet. The guard never exposes it; it hands x402 a wrapped signer. */
  signer: X402WalletSigner;
  /**
   * Networks the guard pays on. Default: Base Sepolia only. Base mainnet
   * (`eip155:8453`) must be named here to be used.
   */
  enabledNetworks?: readonly SupportedNetwork[];
  /** Per-asset `askAbove` and `max`. An asset with none: every payment needs a person. */
  limits?: readonly AssetLimit[];
  /** Local budgets. Need `store`. */
  budgets?: readonly BudgetConfig[];
  /** Durable store with compare-and-set, for budgets and live authorizations. */
  store?: X402GuardStore;
  /** On-chain `authorizationState` reader, used by `reconcile()` to release budgets. */
  authorizationState?: AuthorizationStateReader;
  /** x402's own spend controls. Cannot be turned off. */
  spendControls?: SpendControls;
  paymentRequirementsSelector?: SelectPaymentRequirements;
  /** Highest `maxTimeoutSeconds` accepted. Default 300. */
  maxTimeoutSecondsLimit?: number;
  /** How long a Guardian request stays open (an ASK expires after it). Default 120 s, max 300 s. */
  requestTtlMs?: number;
  /** How long a signing token lasts after `execute`. Default 30 s, max 120 s. */
  signingWindowMs?: number;
  /** How often `claim` is polled while a person decides. Default 2 s, max 60 s. */
  claimPollIntervalMs?: number;
  /** Per-call limit on each Guardian call. Default 15 s, max 60 s. */
  guardianCallTimeoutMs?: number;
  /**
   * Optional receipt verification keys (from `fetchReceiptVerificationKeys`).
   * When given, the receipt checked for an above-cap payment must verify
   * offline.
   */
  receiptVerificationKeys?: unknown;
  /** Called with each local record. Records never hold keys or signatures. */
  onRecord?: (record: X402GuardRecord) => void;
  /** Clock, for tests. */
  now?: () => number;
}>;

export type X402GuardRecord = Readonly<{
  at: number;
  event:
    | "refused"
    | "redeemed"
    | "signed"
    | "redeemed-not-signed"
    | "signed-not-sent"
    | "settlement"
    | "released"
    | "spent";
  flowId?: string;
  tool?: string;
  requestId?: string;
  receiptReference?: string;
  code?: RefusalCode;
  guardianReasonCode?: string;
  detail?: string;
  terms?: CanonicalTerms;
  reviewReasons?: readonly string[];
  approvedByPerson?: boolean;
  /** `execute` was sent but its outcome is unknown; the decision may be spent. */
  outcomeUnknown?: boolean;
  nonce?: string;
  from?: string;
  validBefore?: number;
  network?: string;
  transaction?: string;
  success?: boolean;
  errorReason?: string;
}>;

type ReviewReason =
  | "NO_CAP_FOR_ASSET"
  | "ABOVE_ASK_ABOVE"
  | "LIVE_AUTHORIZATION_FOR_REQUEST"
  | "RECENT_START_WITHOUT_STORE";

const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

function refused(
  code: RefusalCode,
  detail: string,
  guardianReasonCode?: string,
  extra?: { outcomeUnknown?: boolean; requestId?: string },
): X402GuardRefused {
  return new X402GuardRefused(code, detail, guardianReasonCode, extra);
}

/**
 * Claim answers that decide nothing (sdk 0.4.0): Guardian could not
 * answer for now (unreachable, rate limited, database busy, 429, 5xx). A
 * held request stays held and the guard keeps waiting for the person until
 * the request TTL ends. Nothing is signed while it waits.
 */
const CLAIM_STILL_HELD = new Set([
  "APPROVAL_PENDING",
  "APPROVAL_REQUIRED",
  "SERVICE_UNAVAILABLE",
  "RATE_LIMITED",
  "DB_BUSY",
  "HTTP_429",
]);

function claimStillHeld(reasonCode: string): boolean {
  return CLAIM_STILL_HELD.has(reasonCode) || /^HTTP_5\d\d$/.test(reasonCode);
}

const OUTCOME_UNKNOWN_DETAIL = (requestId: string) =>
  `Guardian may have redeemed this decision (execute outcome unknown); nothing was signed. ` +
  `Look up request ${requestId} before retrying; a retry needs a new decision.`;

function toBig(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d{1,78}$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return null;
}

const hasExactKeys = (obj: Record<string, unknown>, keys: string[]) => {
  const own = Reflect.ownKeys(obj);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};

function mismatch(field: string): X402GuardRefused {
  return refused(
    "TYPED_DATA_MISMATCH",
    `The data to sign does not match the approved terms (${field}).`,
  );
}

/**
 * Builds and guards the official x402 client. Create one with
 * `createX402Guard`, then use its `client` with the fetch, axios or MCP
 * builders.
 */
export class X402Guard {
  readonly client: GuardedX402Client;
  private readonly config: X402GuardConfig;
  private readonly ledger: Ledger;
  private readonly durable: boolean;
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private readonly termsOptions: TermsOptions;
  private readonly requestTtlMs: number;
  private readonly signingWindowMs: number;
  private readonly pollMs: number;
  private readonly callTimeoutMs: number;
  private readonly walletAddress: string;
  private readonly wallet: X402WalletSigner;
  private readonly log: X402GuardRecord[] = [];
  /** PaymentRequired object → the request it answered (set by the HTTP hook). */
  private readonly pending = new WeakMap<
    object,
    { ctx: RequestContext; info: PaymentRequestInfo }
  >();

  constructor(config: X402GuardConfig) {
    assertSupportedX402("@x402/core");
    assertSupportedX402("@x402/evm");
    this.config = config;
    this.now = config.now ?? Date.now;
    if (!config.guardian || typeof config.guardian.request !== "function") {
      throw new Error("guardian-x402: `guardian` must be a Guardian client.");
    }
    if (typeof config.connectionId !== "string" || !config.connectionId) {
      throw new Error("guardian-x402: `connectionId` is required.");
    }
    const signer = config.signer;
    if (
      !signer ||
      typeof signer.address !== "string" ||
      !ADDRESS_RE.test(signer.address) ||
      typeof signer.signTypedData !== "function"
    ) {
      throw new Error(
        "guardian-x402: `signer` must have an address and signTypedData.",
      );
    }
    this.wallet = signer;
    this.walletAddress = signer.address.toLowerCase();
    this.guardedSigner = Object.freeze({
      address: signer.address,
      signTypedData: (message: Parameters<X402WalletSigner["signTypedData"]>[0]) =>
        this.signGuarded(message),
      signTransaction: async (): Promise<`0x${string}`> => {
        throw refused("SIGNING_REFUSED", "The guard does not sign transactions.");
      },
    });

    const enabled = config.enabledNetworks ?? [BASE_SEPOLIA];
    for (const n of enabled) {
      if (n !== BASE_SEPOLIA && n !== BASE_MAINNET) {
        throw new Error(`guardian-x402: network ${String(n)} is not supported.`);
      }
    }
    const limit = config.maxTimeoutSecondsLimit ?? DEFAULT_MAX_TIMEOUT_SECONDS_LIMIT;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("guardian-x402: maxTimeoutSecondsLimit must be a positive whole number.");
    }
    this.termsOptions = Object.freeze({
      enabledNetworks: Object.freeze([...enabled]),
      maxTimeoutSecondsLimit: limit,
    });
    this.requestTtlMs = config.requestTtlMs ?? GUARDIAN_DEFAULT_REQUEST_TTL_MS;
    if (
      !Number.isSafeInteger(this.requestTtlMs) ||
      this.requestTtlMs < 1 ||
      this.requestTtlMs > GUARDIAN_MAX_REQUEST_TTL_MS
    ) {
      throw new Error(
        `guardian-x402: requestTtlMs must be from 1 to ${GUARDIAN_MAX_REQUEST_TTL_MS}.`,
      );
    }
    this.signingWindowMs = boundedMs(
      "signingWindowMs",
      config.signingWindowMs ?? DEFAULT_SIGNING_WINDOW_MS,
      MAX_SIGNING_WINDOW_MS,
    );
    this.pollMs = boundedMs(
      "claimPollIntervalMs",
      config.claimPollIntervalMs ?? DEFAULT_CLAIM_POLL_INTERVAL_MS,
      MAX_CLAIM_POLL_INTERVAL_MS,
    );
    this.callTimeoutMs = boundedMs(
      "guardianCallTimeoutMs",
      config.guardianCallTimeoutMs ?? DEFAULT_GUARDIAN_CALL_TIMEOUT_MS,
      MAX_GUARDIAN_CALL_TIMEOUT_MS,
    );

    for (const l of config.limits ?? []) {
      if (!pinnedAsset(l.network, l.asset)) {
        throw new Error(`guardian-x402: limit for an unsupported asset ${l.asset} on ${l.network}.`);
      }
      if (!ATOMIC_RE.test(l.askAbove) && l.askAbove !== "0") {
        throw new Error("guardian-x402: askAbove must be an atomic integer string.");
      }
      if (!ATOMIC_RE.test(l.max)) {
        throw new Error("guardian-x402: max must be a positive atomic integer string.");
      }
      for (const p of l.payTo ?? []) {
        if (!ADDRESS_RE.test(p)) throw new Error(`guardian-x402: payTo ${p} is not an address.`);
      }
    }
    const budgets = config.budgets ?? [];
    if (budgets.length > 0 && !config.store) {
      throw new Error("guardian-x402: budgets need a durable `store`.");
    }
    for (const b of budgets) {
      if (!pinnedAsset(b.network, b.asset) || !ATOMIC_RE.test(b.limit)) {
        throw new Error("guardian-x402: each budget needs a pinned asset and an atomic limit.");
      }
      if (b.period !== "day" && b.period !== "month") {
        throw new Error("guardian-x402: budget period must be day or month.");
      }
    }
    if ((config.spendControls as unknown) === false) {
      throw new Error("guardian-x402: x402 spendControls cannot be turned off.");
    }
    this.durable = config.store !== undefined;
    this.ledger = new Ledger(config.store ?? processStore(), budgets);
    this.startedAtMs = this.now();
    this.client = new GuardedX402Client(this, config);
  }

  // ---------------------------------------------------------------- records

  /** Local records (newest last). No keys, signatures or payment payloads. */
  records(): readonly X402GuardRecord[] {
    return [...this.log];
  }

  /** @internal */
  record(r: Omit<X402GuardRecord, "at">): void {
    const full = Object.freeze({ at: this.now(), ...r }) as X402GuardRecord;
    this.log.push(full);
    try {
      this.config.onRecord?.(full);
    } catch {
      // a failing sink never changes a decision
    }
  }

  /** Authorizations the guard signed that may still be settled. */
  async liveAuthorizations(): Promise<LedgerEntry[]> {
    const now = this.now();
    return (await this.ledger.entries()).filter(
      (e) => (e.state === "signed" || e.state === "signing" || e.state === "spent") && isLive(e, now),
    );
  }

  /**
   * Releases budget held by authorizations whose `validBefore` has passed
   * and whose nonce the chain shows unused. Needs `authorizationState`.
   */
  async reconcile(): Promise<{ released: number; spent: number }> {
    const reader = this.config.authorizationState;
    let released = 0;
    let spent = 0;
    const now = this.now();
    for (const e of await this.ledger.entries()) {
      // A reservation is released only after the longest time its flow can
      // still be deciding. Even then, the signer refuses an entry that is no
      // longer "reserved", so nothing is signed against released budget.
      const holdUntil = e.holdUntilMs ?? e.createdAtMs + LONGEST_FLOW_MS;
      if (e.state === "reserved" && now > holdUntil) {
        await this.ledger.releaseUnsigned(e.id);
        released += 1;
        continue;
      }
      // validBefore is checked on chain against block time, which can lag
      // the local clock; wait a margin past it before reading the nonce.
      if (
        !reader ||
        (e.state !== "signed" && e.state !== "signing") ||
        e.validBefore === undefined ||
        now <= e.validBefore * 1000 + RECONCILE_MARGIN_MS ||
        !e.nonce ||
        !e.from
      ) {
        continue;
      }
      let used: unknown;
      try {
        used = await reader({ network: e.network, asset: e.asset, from: e.from, nonce: e.nonce });
      } catch {
        continue;
      }
      if (used === false) {
        await this.ledger.patch(e.id, (x) => {
          if (x.state === "signed" || x.state === "signing") x.state = "released";
        });
        this.record({ event: "released", nonce: e.nonce, network: e.network });
        released += 1;
      } else if (used === true) {
        await this.ledger.patch(e.id, (x) => {
          if (x.state === "signed" || x.state === "signing") x.state = "spent";
        });
        this.record({ event: "spent", nonce: e.nonce, network: e.network });
        spent += 1;
      }
    }
    return { released, spent };
  }

  // ------------------------------------------------------- transport glue

  /**
   * An x402 HTTP client for this guard. Its only `onPaymentRequired` hook
   * records which request the 402 answered; it never returns headers.
   */
  httpClient(): x402HTTPClient {
    const http = new x402HTTPClient(this.client);
    http.onPaymentRequired(async ({ paymentRequired, requestUrl }) => {
      const ctx = requestStorage.getStore();
      if (ctx && ctx.info.transport === "http" && paymentRequired && typeof paymentRequired === "object") {
        this.pending.set(paymentRequired, {
          ctx,
          info: { ...ctx.info, finalUrl: typeof requestUrl === "string" ? requestUrl : null },
        });
      }
      return undefined;
    });
    return http;
  }

  /** @internal */
  requestInfoFor(paymentRequired: object): {
    info: PaymentRequestInfo | null;
    ctx: RequestContext | null;
  } {
    const ctx = requestStorage.getStore() ?? null;
    if (ctx?.info.transport === "mcp") return { info: ctx.info, ctx };
    const found = this.pending.get(paymentRequired);
    if (found && found.ctx === ctx) return { info: found.info, ctx };
    return { info: null, ctx };
  }

  /** @internal Fetch: "Payment already attempted" after the payload was signed. */
  async markSignedNotSent(ctx: RequestContext): Promise<void> {
    const id = ctx.signedEntries.at(-1);
    if (!id) return;
    const entry = await this.ledger
      .patch(id, (e) => {
        e.sent = "not-sent";
      })
      .catch(() => undefined);
    this.record({
      event: "signed-not-sent",
      ...(entry?.nonce ? { nonce: entry.nonce } : {}),
      ...(entry?.requestId ? { requestId: entry.requestId } : {}),
      detail: "Signed, not sent: x402 stopped before sending. The authorization stays live until validBefore.",
    });
  }

  /** @internal v1 settlement, read by the transport wrapper. */
  async recordV1Settlement(ctx: RequestContext, settle: SettleResponse | null): Promise<void> {
    const id = [...ctx.signedEntries].reverse().find((e) => ctx.versions.get(e) === 1);
    if (!id || !settle) return;
    const entry = await this.ledger.patch(id, (e) => {
      if (settle.success === true && (e.state === "signed" || e.state === "signing")) {
        e.state = "spent";
      }
    }).catch(() => undefined);
    this.recordSettlement(entry, settle);
  }

  private recordSettlement(entry: LedgerEntry | undefined, settle: SettleResponse): void {
    this.record({
      event: "settlement",
      ...(entry?.requestId ? { requestId: entry.requestId } : {}),
      ...(entry?.nonce ? { nonce: entry.nonce } : {}),
      success: settle.success === true,
      ...(typeof settle.transaction === "string" ? { transaction: settle.transaction } : {}),
      ...(typeof settle.network === "string" ? { network: settle.network } : {}),
      ...(typeof settle.errorReason === "string" ? { errorReason: settle.errorReason } : {}),
    });
  }

  // --------------------------------------------------------- core hooks

  /** @internal Drops entries the guard cannot pay before x402 selects one. */
  policy: PaymentPolicy = (x402Version, requirements) => {
    const flow = flowStorage.getStore();
    if (!flow) return [];
    return requirements.filter((r) => {
      const read = readTerms(x402Version, r, flow.paymentRequired, flow.request, this.termsOptions);
      if (!read.ok) flow.dropped.push({ code: read.code, detail: read.detail });
      return read.ok;
    });
  };

  /** @internal Pre-check before x402 runs: refuse what nothing can pay. */
  precheck(paymentRequired: unknown, request: PaymentRequestInfo | null): void {
    if (!isPlainObject(paymentRequired)) {
      throw refused("MALFORMED_PAYMENT_REQUIRED", "The payment terms are not an object.");
    }
    const version = paymentRequired.x402Version;
    if (version !== 1 && version !== 2) {
      throw refused("UNSUPPORTED_VERSION", `x402Version ${String(version)} is not supported.`);
    }
    const accepts = paymentRequired.accepts;
    if (!Array.isArray(accepts) || accepts.length === 0) {
      throw refused("MALFORMED_PAYMENT_REQUIRED", "The payment terms list no payment options.");
    }
    let first: { code: RefusalCode; detail: string } | null = null;
    for (const r of accepts) {
      const read = readTerms(version, r, paymentRequired, request, this.termsOptions);
      if (read.ok) return;
      first ??= { code: read.code, detail: read.detail };
    }
    throw refused(first!.code, first!.detail);
  }

  /** @internal The decision point: x402's onBeforePaymentCreation. */
  beforePaymentCreation = async (
    ctx: PaymentCreationContext,
  ): Promise<void | { abort: true; reason: string }> => {
    const flow = flowStorage.getStore();
    try {
      if (!flow || flow.paymentRequired !== ctx.paymentRequired) {
        throw refused("NO_PAYMENT_FLOW", "This payment did not start through the guard.");
      }
      if (flow.decided) {
        throw refused("NO_PAYMENT_FLOW", "This payment was already decided.");
      }
      flow.decided = true;
      flow.selectedRequirements = ctx.selectedRequirements;
      await this.decide(flow, ctx);
      return undefined;
    } catch (error) {
      const err =
        error instanceof X402GuardRefused
          ? error
          : refused("SIGNING_REFUSED", "The guard failed while deciding; nothing was signed.");
      if (flow) {
        (flow as { refusal?: X402GuardRefused }).refusal = err;
        if (flow.ledgerId) await this.ledger.releaseUnsigned(flow.ledgerId).catch(() => undefined);
      }
      this.recordRefusal(err, flow?.id);
      return { abort: true, reason: err.message };
    }
  };

  private limitFor(terms: CanonicalTerms): AssetLimit | undefined {
    return (this.config.limits ?? []).find(
      (l) => l.network === terms.network && l.asset.toLowerCase() === terms.asset,
    );
  }

  private async decide(flow: PaymentFlow, ctx: PaymentCreationContext): Promise<void> {
    const read = readTerms(
      ctx.paymentRequired.x402Version,
      ctx.selectedRequirements,
      ctx.paymentRequired,
      flow.request,
      this.termsOptions,
    );
    if (!read.ok) throw refused(read.code, read.detail);
    const terms = frozenCopy(read.terms);
    let snapshot: unknown;
    try {
      snapshot = frozenCopy(ctx.selectedRequirements);
    } catch {
      throw refused("MALFORMED_PAYMENT_REQUIRED", "The selected entry cannot be copied.");
    }
    const amount = BigInt(terms.amount);

    // Local checks: max, payTo allowlist, live authorizations, budget.
    const limit = this.limitFor(terms);
    if (limit && amount > BigInt(limit.max)) {
      throw refused("ABOVE_MAX", `${terms.amountDisplay} is above the local max for this asset.`);
    }
    if (limit?.payTo && !limit.payTo.some((p) => p.toLowerCase() === terms.payTo)) {
      throw refused("PAY_TO_NOT_ALLOWED", `payTo ${terms.payTo} is not on the allowlist.`);
    }
    const reasons: ReviewReason[] = [];
    if (!limit) reasons.push("NO_CAP_FOR_ASSET");
    else if (amount > BigInt(limit.askAbove)) reasons.push("ABOVE_ASK_ABOVE");
    const now = this.now();
    if (
      !this.durable &&
      now < this.startedAtMs + this.termsOptions.maxTimeoutSecondsLimit * 1000
    ) {
      reasons.push("RECENT_START_WITHOUT_STORE");
    }

    const entry: LedgerEntry = {
      id: newId("x4e"),
      requestKey: requestKeyOf(terms),
      network: terms.network,
      asset: terms.asset,
      amount: terms.amount,
      createdAtMs: now,
      holdUntilMs: now + this.longestFlowMs(),
      state: "reserved",
      sent: "unknown",
    };
    // Any earlier payment made while serving this same call counts as the
    // same request, whatever resource the server names the second time.
    const { liveForRequest } = await this.ledger.reserve(
      entry,
      now,
      flow.requestContext?.signedEntries ?? [],
    );
    flow.ledgerId = entry.id;
    if (liveForRequest.length > 0) {
      reasons.push("LIVE_AUTHORIZATION_FOR_REQUEST");
      const exposure = liveForRequest.reduce((s, e) => s + BigInt(e.amount), amount);
      if (limit && exposure > BigInt(limit.max)) {
        throw refused(
          "ABOVE_MAX",
          "This payment plus live authorizations for the same request is above the local max.",
        );
      }
    }

    const aboveCap = reasons.length > 0;
    const tool = aboveCap ? PAY_ABOVE_CAP_TOOL : PAY_TOOL;
    const args = { ...terms, reviewReasons: [...reasons] };
    const { requestId, capabilityToken, viaAsk } = await this.askGuardian(
      tool,
      args,
      terms,
      aboveCap,
    );

    const executed = await withTimeout(
      Promise.resolve().then(() =>
        this.config.guardian.execute({ requestId, capabilityToken }),
      ),
      this.callTimeoutMs,
    );
    if (!executed.ok) {
      // The execute call was made but no answer came back: Guardian may have
      // redeemed the decision. Nothing is signed either way.
      flow.executeOutcomeUnknown = { requestId };
      throw refused(
        "EXECUTE_FAILED",
        `${
          executed.timedOut ? "Guardian did not answer execute in time." : "Guardian execute failed."
        } ${OUTCOME_UNKNOWN_DETAIL(requestId)}`,
        undefined,
        { outcomeUnknown: true, requestId },
      );
    }
    const ex = executed.value as unknown;
    const exOk =
      isPlainObject(ex) &&
      ex.ok === true &&
      isPlainObject(ex.receipt) &&
      ex.receipt.status === "sent-verified" &&
      ex.receipt.requestId === requestId &&
      typeof ex.receipt.receiptReference === "string";
    if (!exOk) {
      const code =
        isPlainObject(ex) && typeof ex.reasonCode === "string" ? ex.reasonCode : "EXECUTE_FAILED";
      // sdk 0.4.0 marks an execute it cannot read (no answer, 5xx, an
      // unreadable body) with outcomeUnknown; an ok:true answer the guard
      // cannot accept is a redemption too. Both: the decision may be spent.
      const definitiveRefusal =
        isPlainObject(ex) && ex.ok === false && ex.outcomeUnknown !== true;
      if (!definitiveRefusal) {
        flow.executeOutcomeUnknown = { requestId };
        throw refused(
          "EXECUTE_FAILED",
          `Guardian did not redeem the decision cleanly. ${OUTCOME_UNKNOWN_DETAIL(requestId)}`,
          code,
          { outcomeUnknown: true, requestId },
        );
      }
      throw refused("EXECUTE_FAILED", "Guardian did not redeem the decision.", code, {
        requestId,
      });
    }
    const receiptReference = (ex as { receipt: { receiptReference: string } }).receipt
      .receiptReference;
    flow.redeemed = { requestId, receiptReference };
    await this.ledger
      .patch(entry.id, (e) => {
        e.requestId = requestId;
      })
      .catch(() => undefined); // informational only

    let approvedByPerson = false;
    if (aboveCap) {
      if (!viaAsk) {
        throw refused(
          "PERSON_APPROVAL_REQUIRED",
          "This payment needs a person's approval; a rule ALLOW is not enough.",
        );
      }
      await this.checkApprovedByPerson(requestId, tool, args);
      approvedByPerson = true;
    }

    const token: SigningToken = {
      terms,
      pinned: read.pinned,
      requirementSnapshot: snapshot,
      requestId,
      receiptReference,
      expiresAtMs: this.now() + this.signingWindowMs,
      used: false,
    };
    flow.token = token;
    this.record({
      event: "redeemed",
      flowId: flow.id,
      tool,
      requestId,
      receiptReference,
      terms,
      reviewReasons: [...reasons],
      approvedByPerson,
    });
  }

  /** The longest a flow can hold a reservation before it signs. */
  private longestFlowMs(): number {
    // request + claim overrun + execute + receipt, the approval wait, the
    // last poll, the signing window, and a margin for the store.
    return (
      4 * this.callTimeoutMs + this.requestTtlMs + this.pollMs + this.signingWindowMs + 60_000
    );
  }

  private async guardianCall<T>(fn: () => Promise<T>): Promise<T> {
    const r = await withTimeout(Promise.resolve().then(fn), this.callTimeoutMs);
    if (!r.ok) {
      throw r.timedOut
        ? refused("GUARDIAN_TIMEOUT", "Guardian did not answer in time.")
        : refused("GUARDIAN_UNREACHABLE", "Guardian could not be reached.");
    }
    return r.value;
  }

  private async askGuardian(
    tool: string,
    args: Record<string, unknown>,
    terms: CanonicalTerms,
    aboveCap: boolean,
  ): Promise<{ requestId: string; capabilityToken: string; viaAsk: boolean }> {
    const purpose = `Pay ${terms.amountDisplay} on ${terms.networkName} over x402${
      aboveCap ? " (needs a person's approval)" : ""
    }`;
    const answer = await this.guardianCall(() =>
      this.config.guardian.request({
        action: "tool.invoke",
        connectionId: this.config.connectionId,
        toolName: tool,
        arguments: args,
        purpose,
        ttlMs: this.requestTtlMs,
      }),
    );
    const startedAt = this.now();
    if (!wellFormed(answer)) {
      throw refused("GUARDIAN_UNREACHABLE", "Guardian's answer was malformed.");
    }
    const decision = classifyRequestResult(answer);
    if (decision.decision === "DENY") {
      if (decision.reasonCode === "SERVICE_UNAVAILABLE") {
        throw refused("GUARDIAN_UNREACHABLE", "Guardian could not be reached.");
      }
      throw refused("GUARDIAN_DENIED", "Guardian denied this payment.", decision.reasonCode);
    }
    if (decision.decision === "ALLOW") {
      if (aboveCap) {
        throw refused(
          "PERSON_APPROVAL_REQUIRED",
          "This payment needs a person's approval; a rule ALLOW is not enough.",
        );
      }
      return {
        requestId: decision.requestId,
        capabilityToken: decision.capabilityToken,
        viaAsk: false,
      };
    }

    // ASK: wait for a person, inside the hook, before anything is signed.
    const requestId = decision.requestId;
    const deadline = startedAt + this.requestTtlMs;
    while (this.now() < deadline) {
      await sleep(Math.max(1, Math.min(this.pollMs, deadline - this.now())));
      let claimed: unknown;
      try {
        claimed = await this.guardianCall(() => this.config.guardian.claim(requestId));
      } catch {
        continue; // transient; the deadline still holds
      }
      if (!wellFormed(claimed)) {
        throw refused("GUARDIAN_UNREACHABLE", "Guardian's answer was malformed.");
      }
      // An answer that decides must name this request; an empty or other id is refused.
      if (claimed.ok && claimed.requestId !== requestId) {
        throw refused("GUARDIAN_UNREACHABLE", "Guardian answered for a different request.");
      }
      if (claimed.ok && claimed.decision === "ALLOW") {
        if (typeof claimed.capabilityToken !== "string" || !claimed.capabilityToken) {
          throw refused("GUARDIAN_DENIED", "Guardian issued no capability.", "CAPABILITY_MISSING");
        }
        return { requestId, capabilityToken: claimed.capabilityToken, viaAsk: true };
      }
      const held =
        (claimed.ok && claimed.decision === "ASK") ||
        (!claimed.ok && claimStillHeld(claimed.reasonCode));
      if (held) continue; // the deadline still holds
      throw refused(
        "GUARDIAN_DENIED",
        "Guardian denied this payment.",
        claimed.ok ? (claimed.reasonCode ?? "DENIED") : claimed.reasonCode,
      );
    }
    throw refused("APPROVAL_TIMEOUT", "No person approved this payment in time.");
  }

  /** The receipt must show a person approved this exact request. */
  private async checkApprovedByPerson(
    requestId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const fail = (why: string) =>
      refused("RECEIPT_CHECK_FAILED", `Cannot confirm a person approved this payment (${why}).`);
    const got = await this.guardianCall(() => this.config.guardian.portableReceipt(requestId));
    if (!isPlainObject(got) || got.ok !== true) throw fail("no receipt");
    const receipt = got.receipt;
    if (this.config.receiptVerificationKeys !== undefined) {
      const verified = verifyReceiptOffline(receipt, this.config.receiptVerificationKeys);
      if (!verified.valid) throw fail("receipt does not verify");
    }
    if (!isPlainObject(receipt)) throw fail("malformed receipt");
    const subject = receipt.subject;
    const action = receipt.action;
    const decision = receipt.decision;
    const approval = receipt.approval;
    // The receipt must be for this request, not an earlier one on the same terms.
    if (!isPlainObject(subject) || subject.requestId !== requestId) throw fail("other request");
    if (!isPlainObject(action) || action.requestId !== requestId) throw fail("other request");
    if (action.action !== "tool.invoke") throw fail("action");
    const params = action.materialParameters;
    if (
      !isPlainObject(params) ||
      params.toolName !== tool ||
      params.connectionId !== this.config.connectionId ||
      !sameData(params.arguments, args)
    ) {
      throw fail("terms differ");
    }
    if (!isPlainObject(decision) || decision.decision !== "ASK") throw fail("not an ASK");
    // Guardian moves the approval to "consumed" when execute redeems it.
    if (
      !isPlainObject(approval) ||
      (approval.state !== "approved" && approval.state !== "consumed")
    ) {
      throw fail("not approved");
    }
  }

  // -------------------------------------------------------------- signer

  /** @internal The only signer x402 gets: EIP-3009 typed data, nothing else. */
  readonly guardedSigner: Readonly<{
    address: `0x${string}`;
    signTypedData: X402WalletSigner["signTypedData"];
    signTransaction: () => Promise<`0x${string}`>;
  }>;

  private readonly recordedRefusals = new WeakSet<Error>();

  /** @internal Records a refusal once. */
  recordRefusal(err: X402GuardRefused, flowId?: string): void {
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

  private async signGuarded(raw: unknown): Promise<`0x${string}`> {
    try {
      return await this.signChecked(raw);
    } catch (error) {
      if (error instanceof X402GuardRefused) {
        this.recordRefusal(error, flowStorage.getStore()?.id);
      }
      throw error;
    }
  }

  private async signChecked(raw: unknown): Promise<`0x${string}`> {
    const flow = flowStorage.getStore();
    if (!flow) throw refused("NO_PAYMENT_FLOW", "Signing outside a guarded payment is refused.");
    flow.signAttempted = true;
    const token = flow.token;
    if (!token) throw refused("NO_SIGNING_TOKEN", "No approved payment in this flow.");
    if (token.used) throw refused("SIGNING_TOKEN_USED", "This approval was already used to sign.");
    token.used = true;
    if (this.now() > token.expiresAtMs) {
      throw refused("SIGNING_TOKEN_EXPIRED", "The approval's signing window has passed.");
    }
    const pr = flow.paymentRequired as { x402Version?: unknown };
    const live = readTerms(
      pr?.x402Version,
      flow.selectedRequirements,
      flow.paymentRequired,
      flow.request,
      this.termsOptions,
    );
    if (
      !live.ok ||
      !sameData(live.terms, token.terms) ||
      !sameData(jsonCopy(flow.selectedRequirements), token.requirementSnapshot)
    ) {
      throw refused("TERMS_CHANGED", "The payment terms changed after the decision.");
    }
    let data: Record<string, unknown>;
    try {
      data = structuredClone(raw) as Record<string, unknown>;
    } catch {
      throw mismatch("not plain data");
    }
    const checked = this.checkTypedData(data, token);
    const ledgerId = flow.ledgerId;
    if (!ledgerId) throw refused("SIGNING_REFUSED", "No reservation for this payment.");
    const marked = await this.ledger.patch(ledgerId, (e) => {
      // Only a reservation still held may be signed against. One released
      // in the meantime (by reconcile) may already back another payment.
      if (e.state !== "reserved") {
        throw refused("SIGNING_REFUSED", "This payment's reservation was released; nothing was signed.");
      }
      e.state = "signing";
      e.from = checked.from;
      e.nonce = checked.nonce;
      e.validBefore = checked.validBefore;
    });
    if (!marked) throw refused("SIGNING_REFUSED", "No reservation for this payment.");
    let signature: `0x${string}`;
    try {
      signature = await this.wallet.signTypedData(
        data as Parameters<X402WalletSigner["signTypedData"]>[0],
      );
    } catch (error) {
      throw error instanceof X402GuardRefused
        ? error
        : refused("SIGNING_REFUSED", "The wallet failed to sign.");
    }
    flow.signed = { nonce: checked.nonce, from: checked.from, validBefore: checked.validBefore };
    await this.ledger
      .patch(ledgerId, (e) => {
        if (e.state === "signing") e.state = "signed";
      })
      .catch(() => undefined); // stays "signing": still counted and live
    if (flow.requestContext) {
      flow.requestContext.signedEntries.push(ledgerId);
      flow.requestContext.versions.set(ledgerId, token.terms.x402Version);
    }
    this.record({
      event: "signed",
      flowId: flow.id,
      requestId: token.requestId,
      receiptReference: token.receiptReference,
      nonce: checked.nonce,
      from: checked.from,
      validBefore: checked.validBefore,
      network: token.terms.network,
    });
    return signature;
  }

  private checkTypedData(
    data: Record<string, unknown>,
    token: SigningToken,
  ): { from: string; nonce: string; validBefore: number } {
    const { terms, pinned } = token;
    if (!isPlainObject(data) || !hasExactKeys(data, ["domain", "types", "primaryType", "message"])) {
      throw mismatch("shape");
    }
    if (data.primaryType !== "TransferWithAuthorization") throw mismatch("primaryType");
    if (!sameData(data.types, EIP3009_TYPES)) throw mismatch("types");
    const domain = data.domain;
    if (
      !isPlainObject(domain) ||
      !hasExactKeys(domain, ["name", "version", "chainId", "verifyingContract"])
    ) {
      throw mismatch("domain fields");
    }
    const chainId = toBig(domain.chainId);
    if (chainId === null || chainId !== BigInt(pinned.chainId)) throw mismatch("chainId");
    if (
      typeof domain.verifyingContract !== "string" ||
      domain.verifyingContract.toLowerCase() !== terms.asset
    ) {
      throw mismatch("verifyingContract");
    }
    if (domain.name !== terms.extra.name || domain.name !== pinned.name) throw mismatch("name");
    if (domain.version !== terms.extra.version || domain.version !== pinned.version) {
      throw mismatch("version");
    }
    const m = data.message;
    if (
      !isPlainObject(m) ||
      !hasExactKeys(m, ["from", "to", "value", "validAfter", "validBefore", "nonce"])
    ) {
      throw mismatch("message fields");
    }
    if (typeof m.from !== "string" || m.from.toLowerCase() !== this.walletAddress) {
      throw mismatch("from");
    }
    if (typeof m.to !== "string" || m.to.toLowerCase() !== terms.payTo) throw mismatch("to");
    const value = toBig(m.value);
    if (value === null || value !== BigInt(terms.amount)) throw mismatch("value");
    const nowSec = BigInt(Math.floor(this.now() / 1000));
    const validAfter = toBig(m.validAfter);
    if (validAfter === null || validAfter > nowSec) throw mismatch("validAfter");
    const validBefore = toBig(m.validBefore);
    if (
      validBefore === null ||
      validBefore > nowSec + BigInt(terms.maxTimeoutSeconds) ||
      validBefore <= validAfter
    ) {
      throw mismatch("validBefore");
    }
    if (typeof m.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(m.nonce)) {
      throw mismatch("nonce");
    }
    return {
      from: m.from.toLowerCase(),
      nonce: m.nonce.toLowerCase(),
      validBefore: Number(validBefore),
    };
  }

  // --------------------------------------------------------- after hooks

  /** @internal */
  afterPaymentCreation = async (ctx: PaymentCreatedContext): Promise<void> => {
    const flow = flowStorage.getStore();
    if (!flow?.signed) return;
    const auth = (ctx.paymentPayload?.payload as { authorization?: { nonce?: unknown } })
      ?.authorization;
    if (typeof auth?.nonce !== "string" || auth.nonce.toLowerCase() !== flow.signed.nonce) {
      this.record({
        event: "refused",
        flowId: flow.id,
        code: "TYPED_DATA_MISMATCH",
        detail: "The payload's nonce is not the one the guard signed.",
      });
    }
  };

  /** @internal v2 only (x402 skips this hook for v1). */
  paymentResponse = async (ctx: PaymentResponseContext): Promise<void> => {
    const auth = (ctx.paymentPayload?.payload as { authorization?: { nonce?: unknown } })
      ?.authorization;
    const settle = ctx.settleResponse;
    if (typeof auth?.nonce !== "string" || !settle) return;
    const entry = await this.ledger
      .patchByNonce(auth.nonce, (e) => {
        if (settle.success === true && (e.state === "signed" || e.state === "signing")) {
          e.state = "spent";
        }
      })
      .catch(() => undefined);
    this.recordSettlement(entry, settle);
  };

  /** @internal Called when a flow ends. */
  async endFlow(flow: PaymentFlow): Promise<void> {
    if (flow.signed) return;
    if (flow.redeemed) {
      this.record({
        event: "redeemed-not-signed",
        flowId: flow.id,
        requestId: flow.redeemed.requestId,
        receiptReference: flow.redeemed.receiptReference,
        detail: "Redeemed, not signed. The decision is spent; a retry needs a new decision.",
      });
    } else if (flow.executeOutcomeUnknown) {
      this.record({
        event: "redeemed-not-signed",
        flowId: flow.id,
        requestId: flow.executeOutcomeUnknown.requestId,
        outcomeUnknown: true,
        detail:
          "Redeemed or unknown, not signed. The decision may be spent; look up the request " +
          "before retrying, and a retry needs a new decision.",
      });
    }
    if (flow.ledgerId) await this.ledger.releaseUnsigned(flow.ledgerId).catch(() => undefined);
  }

  /** @internal */
  newFlow(paymentRequired: unknown): PaymentFlow {
    const { info, ctx } = isPlainObject(paymentRequired)
      ? this.requestInfoFor(paymentRequired)
      : { info: null, ctx: requestStorage.getStore() ?? null };
    return {
      id: newId("x4f"),
      paymentRequired,
      request: info,
      requestContext: ctx,
      dropped: [],
      decided: false,
      signAttempted: false,
    };
  }

}

/** Without a stored hold, the longest any configuration allows. */
const LONGEST_FLOW_MS =
  4 * MAX_GUARDIAN_CALL_TIMEOUT_MS +
  GUARDIAN_MAX_REQUEST_TTL_MS +
  MAX_CLAIM_POLL_INTERVAL_MS +
  MAX_SIGNING_WINDOW_MS +
  60_000;

function boundedMs(name: string, value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`guardian-x402: ${name} must be a whole number of ms from 1 to ${max}.`);
  }
  return value;
}

function jsonCopy(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return Symbol("not comparable");
  }
}

function wellFormed(value: unknown): value is
  | { ok: true; requestId: string; decision: "ALLOW" | "ASK" | "DENY"; capabilityToken?: string; reasonCode?: string }
  | { ok: false; reasonCode: string; requestId?: string } {
  if (!isPlainObject(value)) return false;
  if (value.ok === true) {
    return (
      typeof value.requestId === "string" &&
      (value.decision === "ALLOW" || value.decision === "ASK" || value.decision === "DENY")
    );
  }
  return value.ok === false && typeof value.reasonCode === "string";
}

/**
 * The official `x402Client`, built and sealed by the guard. Every payment
 * runs in its own flow; the guard's hooks and wrapped signer read it.
 */
export class GuardedX402Client extends x402Client {
  /** @internal */
  readonly guard: X402Guard;
  private sealed = false;

  constructor(guard: X402Guard, config: X402GuardConfig) {
    super(config.paymentRequirementsSelector);
    this.guard = guard;
    if (config.spendControls) super.setSpendControls(config.spendControls);
    // Policies run before x402 selects an entry; ours is first.
    this.registerPolicy(guard.policy);
    this.onBeforePaymentCreation(guard.beforePaymentCreation);
    this.onAfterPaymentCreation(guard.afterPaymentCreation);
    this.onPaymentResponse(guard.paymentResponse);
    registerExactEvmScheme(this, {
      signer: guard.guardedSigner,
      networks: [...(config.enabledNetworks ?? [BASE_SEPOLIA])],
    });
    this.sealed = true;
  }

  override register(...args: Parameters<x402Client["register"]>): x402Client {
    if (this.sealed) throw refused("GUARD_SEALED", "The guarded client takes no other schemes.");
    return super.register(...args);
  }

  override registerV1(...args: Parameters<x402Client["registerV1"]>): x402Client {
    if (this.sealed) throw refused("GUARD_SEALED", "The guarded client takes no other schemes.");
    return super.registerV1(...args);
  }

  override registerExtension(
    ...args: Parameters<x402Client["registerExtension"]>
  ): x402Client {
    if (this.sealed) throw refused("GUARD_SEALED", "The guarded client takes no extensions.");
    return super.registerExtension(...args);
  }

  /**
   * Refused once sealed: a failure hook can return its own payload, which
   * x402 would send in place of a guard refusal.
   */
  override onPaymentCreationFailure(
    ...args: Parameters<x402Client["onPaymentCreationFailure"]>
  ): x402Client {
    if (this.sealed) {
      throw refused("GUARD_SEALED", "onPaymentCreationFailure hooks are refused on the guarded client.");
    }
    return super.onPaymentCreationFailure(...args);
  }

  override setSpendControls(controls: SpendControls | false): x402Client {
    if (this.sealed && controls === false) {
      throw refused("GUARD_SEALED", "x402 spendControls cannot be turned off.");
    }
    return super.setSpendControls(controls);
  }

  override async createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload> {
    const flow = this.guard.newFlow(paymentRequired);
    return flowStorage.run(flow, async () => {
      try {
        this.guard.precheck(paymentRequired, flow.request);
        return await super.createPaymentPayload(paymentRequired);
      } catch (error) {
        const own = (flow as { refusal?: X402GuardRefused }).refusal;
        if (own) throw own;
        if (error instanceof X402GuardRefused) {
          this.guard.recordRefusal(error, flow.id);
          throw error;
        }
        const msg = error instanceof Error ? error.message : "";
        const dropped = flow.dropped[0];
        if (dropped && /filtered out by policies/.test(msg)) {
          const err = refused(dropped.code as RefusalCode, dropped.detail);
          this.guard.recordRefusal(err, flow.id);
          throw err;
        }
        throw error;
      } finally {
        await this.guard.endFlow(flow);
      }
    });
  }
}

/** Builds the guard and its guarded x402 client. */
export function createX402Guard(config: X402GuardConfig): X402Guard {
  return new X402Guard(config);
}

export { requestStorage };
