import {
  GUARDIAN_DEFAULT_REQUEST_TTL_MS,
  GUARDIAN_MAX_REQUEST_TTL_MS,
  type GuardianClient,
} from "@odingard/guardian-sdk";

import { AdapterIdSchema } from "@odingard/guardian-sdk/contracts";

import type { LinkAdapter, LinkSpendRequestView } from "./adapter.js";
import { checkAmountDeclaration, type AmountDeclaration } from "./amount.js";
import { LinkCard } from "./card.js";
import {
  DEFAULT_CLAIM_POLL_INTERVAL_MS,
  DEFAULT_GUARDIAN_CALL_TIMEOUT_MS,
  DEFAULT_LINK_POLL_INTERVAL_MS,
  LINK_MAX_AMOUNT,
  MAX_CLAIM_POLL_INTERVAL_MS,
  MAX_GUARDIAN_CALL_TIMEOUT_MS,
  MAX_LINK_APPROVAL_WAIT_MS,
  SPEND_ABOVE_CAP_TOOL,
  SPEND_REQUEST_ID_RE,
  SPEND_TOOL,
  SUPPORTED_CURRENCIES,
  type SupportedCurrency,
} from "./constants.js";
import { decideAndRedeem, type DecisionConfig } from "./decision.js";
import { Ledger, processStore, type DecisionEntry, type LinkGuardStore } from "./ledger.js";
import {
  differences,
  readTerms,
  updateDifferences,
  type CanonicalTerms,
  type LinkSpendTerms,
} from "./terms.js";
import { isPlainObject, LinkGuardRefused, refused, sleep, type RefusalCode } from "./util.js";

/** Local limits for one currency, in minor units (cents). */
export type CurrencyLimit = Readonly<{
  currency: SupportedCurrency;
  /** Above this, the spend needs a person's approval. */
  askAbove: number;
  /** Above this, the spend is refused locally. At most 50,000 (Link's limit). */
  max: number;
}>;

export type LinkGuardConfig = Readonly<{
  /** A Guardian client (`createGuardianClient`). */
  guardian: GuardianClient;
  /** The tool connection holding the `link.spend` and `link.spend.above_cap` entries. */
  connectionId: string;
  /**
   * Adapter audience for executes (`adp_…`), as `createGuardianContext`
   * takes it. Default: the SDK's tool adapter.
   */
  adapterId?: string;
  /**
   * The Link adapter, holding the Link login (`linkCliAdapter`). Only the
   * guard holds it; give the agent the guard, never the adapter or its
   * auth file.
   */
  link: LinkAdapter;
  /** Currencies the guard spends in. Default: USD only. */
  currencies?: readonly SupportedCurrency[];
  /** Per-currency `askAbove` and `max`. A currency with none: every spend needs a person. */
  limits?: readonly CurrencyLimit[];
  /**
   * Durable store with compare-and-set. Default: in-process, so a restart
   * forgets which decisions were used and which cards were read.
   */
  store?: LinkGuardStore;
  /**
   * The amount declaration set on both tools in the Guardian console, so
   * console dollar limits apply (`LINK_AMOUNT_DECLARATION`). Needs an
   * `@odingard/guardian-sdk` that carries it; USD only.
   */
  amountArgument?: AmountDeclaration;
  /** How long a Guardian request stays open (an ASK expires after it). Default 120 s, max 300 s. */
  requestTtlMs?: number;
  /** How often `claim` is polled while a person decides in Guardian. Default 2 s, max 60 s. */
  claimPollIntervalMs?: number;
  /** Per-call limit on each Guardian call. Default 15 s, max 60 s. */
  guardianCallTimeoutMs?: number;
  /** How often Link is read while waiting for Link's own approval. Default 2 s. */
  linkPollIntervalMs?: number;
  /** Optional receipt verification keys (`fetchReceiptVerificationKeys`). */
  receiptVerificationKeys?: unknown;
  /** Called with each local record. Records never hold card details. */
  onRecord?: (record: LinkGuardRecord) => void;
  /** Clock, for tests. */
  now?: () => number;
}>;

export type LinkGuardRecord = Readonly<{
  at: number;
  event:
    | "refused"
    | "created"
    | "updated"
    | "approval-requested"
    | "link-approved"
    | "card-read"
    | "canceled"
    | "outcome-unknown";
  tool?: string;
  requestId?: string;
  receiptReference?: string;
  spendRequestId?: string;
  terms?: CanonicalTerms;
  reviewReasons?: readonly string[];
  approvedByPerson?: boolean;
  /** For TERMS_CHANGED: the fields that differ (names only). */
  fields?: readonly string[];
  code?: RefusalCode;
  guardianReasonCode?: string;
  outcomeUnknown?: boolean;
  detail?: string;
}>;

/** A spend request the guard created on a Guardian decision. */
export type LinkSpendHandle = Readonly<{
  spendRequestId: string;
  requestId: string;
  receiptReference: string;
  tool: string;
  terms: CanonicalTerms;
  approvedByPerson: boolean;
}>;

type ReviewReason = "NO_CAP_FOR_CURRENCY" | "ABOVE_ASK_ABOVE" | "UPDATES_SPEND_REQUEST";

const WAITING = new Set(["created", "pending_approval"]);

function boundedMs(name: string, value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`guardian-link: ${name} must be a whole number of ms from 1 to ${max}.`);
  }
  return value;
}

function viewOk(view: unknown): view is LinkSpendRequestView {
  return (
    isPlainObject(view) &&
    typeof view.id === "string" &&
    SPEND_REQUEST_ID_RE.test(view.id) &&
    typeof view.status === "string"
  );
}

function checkCard(card: unknown): card is { number: string; expMonth: number; expYear: number } {
  return (
    isPlainObject(card) &&
    typeof card.number === "string" &&
    /^\d{12,19}$/.test(card.number) &&
    Number.isSafeInteger(card.expMonth) &&
    (card.expMonth as number) >= 1 &&
    (card.expMonth as number) <= 12 &&
    Number.isSafeInteger(card.expYear)
  );
}

/**
 * Guards a Stripe Link agent wallet in test mode. Guardian decides each
 * spend on its exact terms before the spend request is created or updated;
 * the card is read once, for the approved request only.
 */
export class LinkGuard {
  readonly #link: LinkAdapter;
  readonly #ledger: Ledger;
  readonly #decision: DecisionConfig;
  readonly #currencies: readonly SupportedCurrency[];
  readonly #limits: readonly CurrencyLimit[];
  readonly #linkPollMs: number;
  readonly #onRecord?: (record: LinkGuardRecord) => void;
  readonly #now: () => number;
  readonly #log: LinkGuardRecord[] = [];
  readonly #recorded = new WeakSet<Error>();

  constructor(config: LinkGuardConfig) {
    if (!config.guardian || typeof config.guardian.request !== "function") {
      throw new Error("guardian-link: `guardian` must be a Guardian client.");
    }
    if (typeof config.connectionId !== "string" || !config.connectionId) {
      throw new Error("guardian-link: `connectionId` is required.");
    }
    if (config.adapterId !== undefined && !AdapterIdSchema.safeParse(config.adapterId).success) {
      throw new Error("guardian-link: `adapterId` must be an adapter id (adp_…).");
    }
    const link = config.link;
    const methods = [
      "approvalPolicy",
      "createSpendRequest",
      "updateSpendRequest",
      "requestApproval",
      "retrieveSpendRequest",
      "readCard",
      "cancelSpendRequest",
    ] as const;
    if (!link || methods.some((m) => typeof (link as unknown as Record<string, unknown>)[m] !== "function")) {
      throw new Error("guardian-link: `link` must be a Link adapter (linkCliAdapter).");
    }
    this.#link = link;
    this.#now = config.now ?? Date.now;

    const currencies = config.currencies ?? ["usd"];
    if (currencies.length === 0) throw new Error("guardian-link: `currencies` must name at least one.");
    for (const c of currencies) {
      if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(c)) {
        throw new Error(`guardian-link: currency ${String(c)} is not supported.`);
      }
    }
    this.#currencies = Object.freeze([...currencies]);
    for (const l of config.limits ?? []) {
      if (!currencies.includes(l.currency)) {
        throw new Error(`guardian-link: limit for currency ${String(l.currency)}, which is not enabled.`);
      }
      if (!Number.isSafeInteger(l.max) || l.max < 1 || l.max > LINK_MAX_AMOUNT) {
        throw new Error(`guardian-link: max must be a whole number from 1 to ${LINK_MAX_AMOUNT}.`);
      }
      if (!Number.isSafeInteger(l.askAbove) || l.askAbove < 0 || l.askAbove > l.max) {
        throw new Error("guardian-link: askAbove must be a whole number from 0 to max.");
      }
    }
    this.#limits = Object.freeze([...(config.limits ?? [])]);

    let amountArgument: AmountDeclaration | undefined;
    if (config.amountArgument !== undefined) {
      amountArgument = checkAmountDeclaration(config.amountArgument);
      if (currencies.some((c) => c !== "usd")) {
        throw new Error("guardian-link: `amountArgument` reads US dollars only; enable `usd` only.");
      }
    }
    const requestTtlMs = config.requestTtlMs ?? GUARDIAN_DEFAULT_REQUEST_TTL_MS;
    if (!Number.isSafeInteger(requestTtlMs) || requestTtlMs < 1 || requestTtlMs > GUARDIAN_MAX_REQUEST_TTL_MS) {
      throw new Error(`guardian-link: requestTtlMs must be from 1 to ${GUARDIAN_MAX_REQUEST_TTL_MS}.`);
    }
    this.#decision = Object.freeze({
      guardian: config.guardian,
      connectionId: config.connectionId,
      requestTtlMs,
      pollMs: boundedMs(
        "claimPollIntervalMs",
        config.claimPollIntervalMs ?? DEFAULT_CLAIM_POLL_INTERVAL_MS,
        MAX_CLAIM_POLL_INTERVAL_MS,
      ),
      callTimeoutMs: boundedMs(
        "guardianCallTimeoutMs",
        config.guardianCallTimeoutMs ?? DEFAULT_GUARDIAN_CALL_TIMEOUT_MS,
        MAX_GUARDIAN_CALL_TIMEOUT_MS,
      ),
      ...(amountArgument ? { amountArgument } : {}),
      ...(config.adapterId !== undefined ? { adapterId: config.adapterId } : {}),
      ...(config.receiptVerificationKeys !== undefined
        ? { receiptVerificationKeys: config.receiptVerificationKeys }
        : {}),
      now: this.#now,
    });
    this.#linkPollMs = boundedMs(
      "linkPollIntervalMs",
      config.linkPollIntervalMs ?? DEFAULT_LINK_POLL_INTERVAL_MS,
      MAX_CLAIM_POLL_INTERVAL_MS,
    );
    if (config.onRecord) this.#onRecord = config.onRecord;
    this.#ledger = new Ledger(config.store ?? processStore());
  }

  // ---------------------------------------------------------------- records

  /** Local records (newest last). Never card details. */
  records(): readonly LinkGuardRecord[] {
    return [...this.#log];
  }

  #record(r: Omit<LinkGuardRecord, "at">): void {
    const full = Object.freeze({ at: this.#now(), ...r }) as LinkGuardRecord;
    this.#log.push(full);
    try {
      this.#onRecord?.(full);
    } catch {
      // a failing sink never changes a decision
    }
  }

  async #guarded<T>(fn: () => Promise<T>, spendRequestId?: string): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const err =
        error instanceof LinkGuardRefused
          ? error
          : refused("LINK_CALL_FAILED", "The guard failed; nothing further was done.", undefined, {
              ...(spendRequestId ? { spendRequestId } : {}),
            });
      if (!this.#recorded.has(err)) {
        this.#recorded.add(err);
        this.#record({
          event: "refused",
          code: err.code,
          ...(err.guardianReasonCode ? { guardianReasonCode: err.guardianReasonCode } : {}),
          ...(err.requestId ? { requestId: err.requestId } : {}),
          ...((err.spendRequestId ?? spendRequestId) ? { spendRequestId: err.spendRequestId ?? spendRequestId } : {}),
          ...(err.outcomeUnknown ? { outcomeUnknown: true } : {}),
          detail: err.message,
        });
      }
      throw err;
    }
  }

  // ------------------------------------------------------------- Link calls

  /** Calls Link through the adapter. Never passes the adapter's own error text on. */
  async #call<T>(what: string, fn: () => Promise<T>, extra: { spendRequestId?: string; requestId?: string } = {}): Promise<T> {
    try {
      return await fn();
    } catch {
      throw refused("LINK_CALL_FAILED", `Link ${what} failed.`, undefined, extra);
    }
  }

  async #checkNoPolicy(): Promise<void> {
    const policy = await this.#call("approval-policy retrieve", () => this.#link.approvalPolicy()).catch(() => ({
      state: "unknown" as const,
    }));
    if (!isPlainObject(policy) || policy.state === "unknown" || (policy.state !== "none" && policy.state !== "present")) {
      throw refused(
        "LINK_APPROVAL_POLICY_UNKNOWN",
        "Cannot confirm that no Link approval policy exists; nothing was done.",
      );
    }
    if (policy.state === "present") {
      throw refused(
        "LINK_APPROVAL_POLICY_PRESENT",
        "A Link approval policy exists, so Link could approve without the person; remove it first.",
      );
    }
  }

  async #retrieve(spendRequestId: string): Promise<LinkSpendRequestView> {
    const view = await this.#call("retrieve", () => this.#link.retrieveSpendRequest(spendRequestId), {
      spendRequestId,
    });
    if (!viewOk(view) || view.id !== spendRequestId) {
      throw refused("LINK_CALL_FAILED", "Link returned an unreadable spend request.", undefined, { spendRequestId });
    }
    return view;
  }

  /** Cancels a spend request whose terms no longer match; best effort. */
  async #cancelQuietly(spendRequestId: string): Promise<void> {
    try {
      await this.#link.cancelSpendRequest(spendRequestId);
      this.#record({ event: "canceled", spendRequestId, detail: "Canceled by the guard: terms changed." });
    } catch {
      this.#record({
        event: "canceled",
        spendRequestId,
        outcomeUnknown: true,
        detail: "The guard tried to cancel this spend request; Link did not confirm.",
      });
    }
  }

  async #refuseChanged(entry: DecisionEntry, view: LinkSpendRequestView, fields: string[]): Promise<never> {
    await this.#ledger.mark(entry.requestId, "refused").catch(() => undefined);
    this.#record({
      event: "refused",
      code: "TERMS_CHANGED",
      requestId: entry.requestId,
      spendRequestId: view.id,
      fields,
      detail: "The spend request in Link differs from the decided terms.",
    });
    await this.#cancelQuietly(view.id);
    const err = refused(
      "TERMS_CHANGED",
      `The spend request in Link differs from the decided terms (${fields.join(", ")}); it was canceled.`,
      undefined,
      { requestId: entry.requestId, spendRequestId: view.id },
    );
    this.#recorded.add(err);
    throw err;
  }

  async #current(spendRequestId: string): Promise<DecisionEntry> {
    if (typeof spendRequestId !== "string" || !SPEND_REQUEST_ID_RE.test(spendRequestId)) {
      throw refused("UNKNOWN_SPEND_REQUEST", "That is not a Link spend request id.");
    }
    const entry = await this.#ledger.current(spendRequestId);
    if (!entry) {
      throw refused("UNKNOWN_SPEND_REQUEST", "This guard did not create that spend request.", undefined, {
        spendRequestId,
      });
    }
    return entry;
  }

  // ----------------------------------------------------------- deciding

  #reasons(terms: CanonicalTerms): { reasons: ReviewReason[]; limit?: CurrencyLimit } {
    const limit = this.#limits.find((l) => l.currency === terms.currency);
    if (limit && terms.amount > limit.max) {
      throw refused("ABOVE_MAX", `${terms.amountDisplay} is above the local max for ${terms.currency}.`);
    }
    const reasons: ReviewReason[] = [];
    if (!limit) reasons.push("NO_CAP_FOR_CURRENCY");
    else if (terms.amount > limit.askAbove) reasons.push("ABOVE_ASK_ABOVE");
    return limit ? { reasons, limit } : { reasons };
  }

  async #decide(
    terms: CanonicalTerms,
    reasons: ReviewReason[],
    spendRequestId: string | null,
  ): Promise<{ tool: string; requestId: string; receiptReference: string; approvedByPerson: boolean }> {
    const needsPerson = reasons.length > 0;
    const tool = needsPerson ? SPEND_ABOVE_CAP_TOOL : SPEND_TOOL;
    const args = { ...terms, spendRequestId, reviewReasons: [...reasons] };
    const purpose = `${spendRequestId ? "Change a" : "Create a"} Stripe Link test spend request: ${terms.amountDisplay} at merchant ${JSON.stringify(terms.merchantName)} (${terms.merchantHost})${needsPerson ? " (needs a person's approval)" : ""}`;
    const redeemed = await decideAndRedeem(this.#decision, tool, args, purpose, needsPerson);
    return { tool, ...redeemed };
  }

  /**
   * Guardian decides the spend on its exact terms; on ALLOW, or an ASK a
   * person approved, the guard creates one test-mode spend request with
   * exactly those terms and checks what Link created. It does not request
   * Link's approval yet (see `requestApproval`, or use `spend`).
   */
  async create(raw: LinkSpendTerms): Promise<LinkSpendHandle> {
    return this.#guarded(async () => {
      const terms = readTerms(raw, this.#currencies);
      const { reasons } = this.#reasons(terms);
      await this.#checkNoPolicy();
      const d = await this.#decide(terms, reasons, null);
      const entry: DecisionEntry = {
        requestId: d.requestId,
        tool: d.tool,
        receiptReference: d.receiptReference,
        terms,
        state: "acting",
        createdAtMs: this.#now(),
      };
      // One decision acts once, across restarts when the store is durable.
      await this.#ledger.claim(entry);
      await this.#checkNoPolicy();
      let view: LinkSpendRequestView;
      try {
        view = await this.#link.createSpendRequest({
          test: true,
          credentialType: "card",
          merchantName: terms.merchantName,
          merchantUrl: terms.merchantUrl,
          context: terms.context,
          amount: terms.amount,
          currency: terms.currency,
          lineItems: terms.lineItems,
          totals: terms.totals,
          idempotencyKey: `guardian-link-${d.requestId}`,
          requestApproval: false,
        });
        if (!viewOk(view)) throw new Error("unreadable");
      } catch {
        await this.#ledger.mark(d.requestId, "outcome-unknown").catch(() => undefined);
        this.#record({
          event: "outcome-unknown",
          tool: d.tool,
          requestId: d.requestId,
          detail: "Link create was sent; its outcome is unknown. The decision is spent.",
        });
        throw refused(
          "LINK_OUTCOME_UNKNOWN",
          "Link create was sent but its outcome is unknown. The decision is spent; a retry needs a new decision.",
          undefined,
          { outcomeUnknown: true, requestId: d.requestId },
        );
      }
      try {
        await this.#ledger.bind(d.requestId, view.id);
      } catch (error) {
        await this.#ledger.mark(d.requestId, "refused").catch(() => undefined);
        throw error;
      }
      const fields = differences(terms, view, view.id);
      if (fields.length > 0) await this.#refuseChanged(entry, view, fields);
      if (view.status !== "created") {
        await this.#ledger.mark(d.requestId, "refused").catch(() => undefined);
        await this.#cancelQuietly(view.id);
        throw view.status === "approved"
          ? refused(
              "LINK_APPROVAL_POLICY_PRESENT",
              "Link approved the spend request without the person; it was canceled.",
              undefined,
              { requestId: d.requestId, spendRequestId: view.id },
            )
          : refused("WRONG_STATE", `Link created the spend request as ${view.status}; it was canceled.`, undefined, {
              requestId: d.requestId,
              spendRequestId: view.id,
            });
      }
      await this.#ledger.move(d.requestId, ["acting"], "created", () =>
        refused("WRONG_STATE", "This decision changed state.", undefined, { requestId: d.requestId }),
      );
      this.#record({
        event: "created",
        tool: d.tool,
        requestId: d.requestId,
        receiptReference: d.receiptReference,
        spendRequestId: view.id,
        terms,
        reviewReasons: [...reasons],
        approvedByPerson: d.approvedByPerson,
      });
      return Object.freeze({
        spendRequestId: view.id,
        requestId: d.requestId,
        receiptReference: d.receiptReference,
        tool: d.tool,
        terms,
        approvedByPerson: d.approvedByPerson,
      });
    });
  }

  /**
   * Changes a spend request the guard created, before Link's approval is
   * requested. A change is a new decision on the full new terms and always
   * needs a person. Link cannot change the merchant name or context: create
   * a new spend request for that.
   */
  async update(spendRequestId: string, raw: LinkSpendTerms): Promise<LinkSpendHandle> {
    return this.#guarded(async () => {
      const entry = await this.#current(spendRequestId);
      if (entry.state !== "created") {
        throw refused("WRONG_STATE", "Only a spend request not yet sent for Link approval can be changed.", undefined, {
          spendRequestId,
        });
      }
      const terms = readTerms(raw, this.#currencies);
      const unsupported = updateDifferences(entry.terms, terms);
      if (unsupported.length > 0) {
        throw refused(
          "UPDATE_NOT_SUPPORTED",
          `Link cannot change ${unsupported.join(" or ")}; create a new spend request instead.`,
          undefined,
          { spendRequestId },
        );
      }
      const { reasons } = this.#reasons(terms);
      reasons.push("UPDATES_SPEND_REQUEST");
      await this.#checkNoPolicy();
      const before = await this.#retrieve(spendRequestId);
      const changedOutside = differences(entry.terms, before, spendRequestId);
      if (changedOutside.length > 0) await this.#refuseChanged(entry, before, changedOutside);
      if (before.status !== "created") {
        throw refused("WRONG_STATE", `The spend request is ${before.status}; it cannot be changed.`, undefined, {
          spendRequestId,
        });
      }
      const d = await this.#decide(terms, reasons, spendRequestId);
      const next: DecisionEntry = {
        requestId: d.requestId,
        tool: d.tool,
        receiptReference: d.receiptReference,
        terms,
        state: "acting",
        createdAtMs: this.#now(),
      };
      await this.#ledger.claimUpdate(next, spendRequestId, entry.requestId);
      try {
        await this.#checkNoPolicy();
      } catch (error) {
        await this.#ledger.mark(d.requestId, "refused").catch(() => undefined);
        throw error;
      }
      let view: LinkSpendRequestView;
      try {
        view = await this.#link.updateSpendRequest(spendRequestId, {
          merchantUrl: terms.merchantUrl,
          amount: terms.amount,
          currency: terms.currency,
          lineItems: terms.lineItems,
          totals: terms.totals,
        });
        if (!viewOk(view)) throw new Error("unreadable");
      } catch {
        await this.#ledger.mark(d.requestId, "outcome-unknown").catch(() => undefined);
        this.#record({
          event: "outcome-unknown",
          tool: d.tool,
          requestId: d.requestId,
          spendRequestId,
          detail: "Link update was sent; its outcome is unknown. The decision is spent.",
        });
        throw refused(
          "LINK_OUTCOME_UNKNOWN",
          "Link update was sent but its outcome is unknown. The decision is spent; a retry needs a new decision.",
          undefined,
          { outcomeUnknown: true, requestId: d.requestId, spendRequestId },
        );
      }
      const fields = differences(terms, view, spendRequestId);
      if (fields.length > 0) await this.#refuseChanged({ ...next, spendRequestId }, view, fields);
      if (view.status !== "created") {
        await this.#ledger.mark(d.requestId, "refused").catch(() => undefined);
        await this.#cancelQuietly(spendRequestId);
        throw view.status === "approved"
          ? refused(
              "LINK_APPROVAL_POLICY_PRESENT",
              "Link approved the updated spend request without the person; it was canceled.",
              undefined,
              { requestId: d.requestId, spendRequestId },
            )
          : refused("WRONG_STATE", `Link updated the spend request to ${view.status}; it was canceled.`, undefined, {
              requestId: d.requestId,
              spendRequestId,
            });
      }
      await this.#ledger.move(d.requestId, ["acting"], "created", () =>
        refused("WRONG_STATE", "This decision changed state.", undefined, { requestId: d.requestId }),
      );
      this.#record({
        event: "updated",
        tool: d.tool,
        requestId: d.requestId,
        receiptReference: d.receiptReference,
        spendRequestId,
        terms,
        reviewReasons: [...reasons],
        approvedByPerson: d.approvedByPerson,
      });
      return Object.freeze({
        spendRequestId,
        requestId: d.requestId,
        receiptReference: d.receiptReference,
        tool: d.tool,
        terms,
        approvedByPerson: d.approvedByPerson,
      });
    }, spendRequestId);
  }

  /**
   * Asks Link to have the person approve the spend request (a push to the
   * Link app), once, after checking that it still has the decided terms
   * and that no Link approval policy exists.
   */
  async requestApproval(spendRequestId: string): Promise<void> {
    return this.#guarded(async () => {
      const entry = await this.#current(spendRequestId);
      if (entry.state !== "created") {
        throw refused("WRONG_STATE", "Link approval was already requested for this spend request.", undefined, {
          spendRequestId,
          requestId: entry.requestId,
        });
      }
      await this.#checkNoPolicy();
      const view = await this.#retrieve(spendRequestId);
      const fields = differences(entry.terms, view, spendRequestId);
      if (fields.length > 0) await this.#refuseChanged(entry, view, fields);
      if (view.status !== "created") {
        throw refused("WRONG_STATE", `The spend request is ${view.status}.`, undefined, { spendRequestId });
      }
      await this.#ledger.move(entry.requestId, ["created"], "approval-requested", () =>
        refused("WRONG_STATE", "Link approval was already requested for this spend request.", undefined, {
          spendRequestId,
        }),
      );
      try {
        await this.#link.requestApproval(spendRequestId);
      } catch {
        await this.#ledger.mark(entry.requestId, "outcome-unknown").catch(() => undefined);
        throw refused(
          "LINK_OUTCOME_UNKNOWN",
          "Link request-approval was sent but its outcome is unknown; the card will not be read. Cancel it and start again.",
          undefined,
          { outcomeUnknown: true, requestId: entry.requestId, spendRequestId },
        );
      }
      this.#record({ event: "approval-requested", requestId: entry.requestId, spendRequestId });
    }, spendRequestId);
  }

  /** `create`, then `requestApproval`. */
  async spend(raw: LinkSpendTerms): Promise<LinkSpendHandle> {
    const handle = await this.create(raw);
    await this.requestApproval(handle.spendRequestId);
    return handle;
  }

  /**
   * Waits until the person approves the spend request in Link, and checks
   * it still has the decided terms. Refuses on any other outcome.
   */
  async waitForLinkApproval(spendRequestId: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = boundedMs("timeoutMs", opts.timeoutMs ?? MAX_LINK_APPROVAL_WAIT_MS, MAX_LINK_APPROVAL_WAIT_MS);
    return this.#guarded(async () => {
      const entry = await this.#current(spendRequestId);
      if (entry.state !== "approval-requested") {
        throw refused("WRONG_STATE", "Link approval was not requested for this spend request.", undefined, {
          spendRequestId,
        });
      }
      const deadline = this.#now() + timeoutMs;
      for (;;) {
        const view = await this.#retrieve(spendRequestId);
        const fields = differences(entry.terms, view, spendRequestId);
        if (fields.length > 0) await this.#refuseChanged(entry, view, fields);
        if (view.status === "approved") {
          this.#record({ event: "link-approved", requestId: entry.requestId, spendRequestId });
          return;
        }
        if (!WAITING.has(view.status)) {
          throw refused("LINK_NOT_APPROVED", `Link reports the spend request as ${view.status}.`, undefined, {
            spendRequestId,
          });
        }
        if (this.#now() >= deadline) {
          throw refused("LINK_APPROVAL_TIMEOUT", "No one approved the spend request in Link in time.", undefined, {
            spendRequestId,
          });
        }
        await sleep(Math.max(1, Math.min(this.#linkPollMs, deadline - this.#now())));
      }
    }, spendRequestId);
  }

  /**
   * Reads the card for an approved spend request once and hands it to
   * `use`. The card is readable only inside `use` and never prints its
   * details. A second call for the same spend request is refused.
   */
  async withCard<T>(spendRequestId: string, use: (card: LinkCard) => Promise<T> | T): Promise<T> {
    if (typeof use !== "function") throw new TypeError("guardian-link: withCard needs a callback.");
    let card: LinkCard | undefined;
    const opened = await this.#guarded(async () => {
      const entry = await this.#current(spendRequestId);
      if (entry.state === "card-read") {
        throw refused("CARD_ALREADY_READ", "The card for this spend request was already read.", undefined, {
          spendRequestId,
          requestId: entry.requestId,
        });
      }
      if (entry.state !== "approval-requested") {
        throw refused("WRONG_STATE", "The card is read only after Link approval was requested and given.", undefined, {
          spendRequestId,
        });
      }
      const view = await this.#retrieve(spendRequestId);
      const fields = differences(entry.terms, view, spendRequestId);
      if (fields.length > 0) await this.#refuseChanged(entry, view, fields);
      if (view.status !== "approved") {
        throw refused("LINK_NOT_APPROVED", `Link reports the spend request as ${view.status}.`, undefined, {
          spendRequestId,
        });
      }
      // Marked before reading, so a crash or a second caller cannot read twice.
      await this.#ledger.move(entry.requestId, ["approval-requested"], "card-read", () =>
        refused("CARD_ALREADY_READ", "The card for this spend request was already read.", undefined, {
          spendRequestId,
        }),
      );
      let got: Awaited<ReturnType<LinkAdapter["readCard"]>>;
      try {
        got = await this.#link.readCard(spendRequestId);
      } catch {
        throw refused("CARD_UNREADABLE", "Link did not return the card; it will not be read again.", undefined, {
          spendRequestId,
        });
      }
      if (!isPlainObject(got) || !viewOk(got.request) || !checkCard(got.card)) {
        throw refused("CARD_UNREADABLE", "Link returned a card the guard cannot read.", undefined, { spendRequestId });
      }
      const withCardFields = differences(entry.terms, got.request, spendRequestId);
      if (withCardFields.length > 0) await this.#refuseChanged(entry, got.request, withCardFields);
      if (got.request.status !== "approved") {
        throw refused("LINK_NOT_APPROVED", `Link reports the spend request as ${got.request.status}.`, undefined, {
          spendRequestId,
        });
      }
      card = new LinkCard(spendRequestId, got.card);
      this.#record({
        event: "card-read",
        requestId: entry.requestId,
        receiptReference: entry.receiptReference,
        spendRequestId,
      });
      return card;
    }, spendRequestId);
    try {
      return await use(opened);
    } finally {
      card?.close();
    }
  }

  /**
   * Cancels a spend request this guard created. The guard's ledger marks it
   * canceled first, so the guard does nothing more with it even if Link
   * does not confirm the cancel.
   */
  async cancel(spendRequestId: string): Promise<void> {
    return this.#guarded(async () => {
      const entry = await this.#current(spendRequestId);
      await this.#ledger.mark(entry.requestId, "canceled");
      await this.#call("cancel", () => this.#link.cancelSpendRequest(spendRequestId), { spendRequestId });
      this.#record({ event: "canceled", requestId: entry.requestId, spendRequestId });
    }, spendRequestId);
  }
}

/** Builds the guard. */
export function createLinkGuard(config: LinkGuardConfig): LinkGuard {
  return new LinkGuard(config);
}

