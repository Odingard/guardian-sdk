// The guard's record of each Guardian decision and the one spend request it
// acted on. Kept in a developer-supplied compare-and-set store, so a
// restart forgets neither which decisions were used nor which cards were
// read. Never holds card details.
import { SPEND_ABOVE_CAP_TOOL, SPEND_REQUEST_ID_RE, SPEND_TOOL, SUPPORTED_CURRENCIES } from "./constants.js";
import { readTerms, type CanonicalTerms } from "./terms.js";
import { isPlainObject, refused } from "./util.js";

/**
 * A durable key-value store with an atomic compare-and-set, supplied by the
 * developer (a database row with a version column, for example). Only the
 * guard may be able to write to it: whoever can write it can mark a used
 * decision unused. The guard refuses a stored entry it cannot read exactly.
 */
export interface LinkGuardStore {
  /** The current value and its version, or null when the key is absent. */
  get(key: string): Promise<{ value: string; version: string } | null>;
  /**
   * Write `value` only if the key's version is still `expectedVersion`
   * (null: only if the key is absent). Returns false on a conflict. Must be
   * atomic.
   */
  compareAndSet(key: string, expectedVersion: string | null, value: string): Promise<boolean>;
}

/**
 * One decision.
 * - acting: Guardian redeemed it; the guard is calling Link
 * - created: Link created (or updated) the spend request on these terms
 * - approval-requested: Link was asked to have the person approve it
 * - card-read: the card was read, once
 * - superseded: an approved update replaced these terms
 * - outcome-unknown: a Link call was sent and its outcome is unknown
 * - refused: Link returned something other than the decided terms
 * - canceled: canceled through the guard
 */
export type DecisionEntry = {
  requestId: string;
  tool: string;
  receiptReference: string;
  terms: CanonicalTerms;
  state:
    | "acting"
    | "created"
    | "approval-requested"
    | "card-read"
    | "superseded"
    | "outcome-unknown"
    | "refused"
    | "canceled";
  spendRequestId?: string;
  /** For an update: the decision it replaced. */
  replaces?: string;
  createdAtMs: number;
};

type LedgerDoc = { decisions: DecisionEntry[] };

const LEDGER_KEY = "guardian-link:v1:ledger";
const MAX_CAS_ATTEMPTS = 16;

/** In-process store, used when none is given. A restart forgets it. */
export function processStore(): LinkGuardStore {
  const data = new Map<string, { value: string; version: string }>();
  let counter = 0;
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async compareAndSet(key, expectedVersion, value) {
      const current = data.get(key) ?? null;
      if ((current?.version ?? null) !== expectedVersion) return false;
      counter += 1;
      data.set(key, { value, version: String(counter) });
      return true;
    },
  };
}

const live = (e: DecisionEntry) => e.state !== "superseded";

const STATES: readonly DecisionEntry["state"][] = [
  "acting",
  "created",
  "approval-requested",
  "card-read",
  "superseded",
  "outcome-unknown",
  "refused",
  "canceled",
];
const ENTRY_KEYS = new Set([
  "requestId",
  "tool",
  "receiptReference",
  "terms",
  "state",
  "spendRequestId",
  "replaces",
  "createdAtMs",
]);
const RAW_TERMS_KEYS = ["merchantName", "merchantUrl", "amount", "currency", "lineItems", "totals", "context"] as const;

/** JSON with sorted keys, so two readings of the same value compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** True only for an entry the guard itself could have written. */
function entryOk(e: unknown): e is DecisionEntry {
  if (!isPlainObject(e)) return false;
  if (Object.keys(e).some((k) => !ENTRY_KEYS.has(k))) return false;
  if (typeof e.requestId !== "string" || !e.requestId) return false;
  if (e.tool !== SPEND_TOOL && e.tool !== SPEND_ABOVE_CAP_TOOL) return false;
  if (typeof e.receiptReference !== "string") return false;
  if (!STATES.includes(e.state as DecisionEntry["state"])) return false;
  if (e.spendRequestId !== undefined && (typeof e.spendRequestId !== "string" || !SPEND_REQUEST_ID_RE.test(e.spendRequestId))) {
    return false;
  }
  if (e.replaces !== undefined && (typeof e.replaces !== "string" || !e.replaces)) return false;
  if (typeof e.createdAtMs !== "number" || !Number.isFinite(e.createdAtMs)) return false;
  if (!isPlainObject(e.terms)) return false;
  // The stored terms must be exactly what reading their own fields gives.
  const t = e.terms;
  try {
    const raw = Object.fromEntries(RAW_TERMS_KEYS.map((k) => [k, t[k]]));
    return stable(readTerms(raw, SUPPORTED_CURRENCIES)) === stable(t);
  } catch {
    return false;
  }
}

/** States in which the guard does nothing more with a decision. */
const TERMINAL: ReadonlySet<DecisionEntry["state"]> = new Set([
  "card-read",
  "canceled",
  "refused",
  "superseded",
  "outcome-unknown",
]);

export type LedgerLimits = Readonly<{
  now: () => number;
  /** Finished decisions older than this (from `createdAtMs`) are dropped on write. */
  retentionMs: number;
  /** Most entries the document may hold. */
  maxEntries: number;
}>;

/**
 * Why dropping old finished decisions keeps replay protection:
 *
 * - A decision acts only after Guardian's `execute` redeemed its
 *   capability, and that happens before the guard writes the entry or
 *   calls Link. `execute` is single-use and a request expires within its
 *   TTL (at most 300 s), so a decision handed out again later is refused
 *   by Guardian itself (`CAPABILITY_USED` or expired) before Link is
 *   called. The guard's own "seen before" check is a second line for the
 *   short time a request is live; the retention window (at least 1 day) is
 *   far longer than any request TTL.
 * - Entries still in progress (`acting`, `created`, `approval-requested`)
 *   are never dropped: they hold what an approved request may still do.
 * - A dropped finished entry fails closed: the guard no longer knows its
 *   spend request, so `requestApproval`, `withCard`, `update` and `cancel`
 *   refuse it (`UNKNOWN_SPEND_REQUEST`), and a card already read stays
 *   unreadable through the guard.
 * - If Link returned a dropped entry's spend request id for a new create,
 *   that request is not in `created` with the decided terms (it was
 *   approved, used, canceled or expired), so the guard cancels and refuses.
 */
export class Ledger {
  private readonly limits: LedgerLimits;
  constructor(
    private readonly store: LinkGuardStore,
    limits?: LedgerLimits,
  ) {
    this.limits = limits ?? { now: Date.now, retentionMs: 30 * 86_400_000, maxEntries: 1_000 };
  }

  /** Drops finished entries older than the retention window. */
  private prune(doc: LedgerDoc): void {
    const cutoff = this.limits.now() - this.limits.retentionMs;
    doc.decisions = doc.decisions.filter((e) => !(TERMINAL.has(e.state) && e.createdAtMs < cutoff));
  }

  private full(doc: LedgerDoc): boolean {
    return doc.decisions.length >= this.limits.maxEntries;
  }

  /**
   * Refuses (`LEDGER_FULL`) when no new decision fits even after dropping
   * old finished ones. Checked before Guardian is asked.
   */
  async checkRoom(): Promise<void> {
    const { doc } = await this.read();
    this.prune(doc);
    if (this.full(doc)) {
      throw refused(
        "LEDGER_FULL",
        "The guard's store holds as many decisions as it may; finish or cancel open spend requests, or raise ledgerMaxEntries. Nothing was asked.",
      );
    }
  }

  private async read(): Promise<{ doc: LedgerDoc; version: string | null }> {
    let current: { value: string; version: string } | null;
    try {
      current = await this.store.get(LEDGER_KEY);
    } catch {
      throw refused("STORE_UNAVAILABLE", "The guard's store cannot be read.");
    }
    if (current === null) return { doc: { decisions: [] }, version: null };
    try {
      const doc = JSON.parse(current.value) as unknown;
      if (
        !isPlainObject(doc) ||
        Object.keys(doc).some((k) => k !== "decisions") ||
        !Array.isArray(doc.decisions) ||
        !doc.decisions.every(entryOk) ||
        new Set(doc.decisions.map((d) => d.requestId)).size !== doc.decisions.length
      ) {
        throw new Error("bad");
      }
      return { doc: doc as LedgerDoc, version: current.version };
    } catch {
      throw refused("STORE_UNAVAILABLE", "The guard's store holds data it cannot read.");
    }
  }

  /** Read-modify-write with compare-and-set; `change` may throw to abort. */
  private async update<T>(change: (doc: LedgerDoc) => T): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const { doc, version } = await this.read();
      this.prune(doc);
      const before = doc.decisions.length;
      const result = change(doc);
      // Only a change that adds a decision can be refused for room, so
      // decisions in progress can always move on (or be canceled).
      if (doc.decisions.length > before && doc.decisions.length > this.limits.maxEntries) {
        throw refused("LEDGER_FULL", "The guard's store holds as many decisions as it may; nothing was written.");
      }
      let written: boolean;
      try {
        written = await this.store.compareAndSet(LEDGER_KEY, version, JSON.stringify(doc));
      } catch {
        throw refused("STORE_UNAVAILABLE", "The guard's store cannot be written.");
      }
      if (written) return result;
    }
    throw refused("STORE_UNAVAILABLE", "The guard's store kept changing; nothing was done.");
  }

  async entries(): Promise<DecisionEntry[]> {
    return (await this.read()).doc.decisions;
  }

  /** The decision currently in force for a spend request this guard created. */
  async current(spendRequestId: string): Promise<DecisionEntry | undefined> {
    return (await this.entries()).find((e) => e.spendRequestId === spendRequestId && live(e));
  }

  /**
   * Records that a decision is being acted on. A decision acts once: a
   * request id seen before (in any state) is refused.
   */
  async claim(entry: DecisionEntry): Promise<void> {
    await this.update((doc) => {
      if (doc.decisions.some((e) => e.requestId === entry.requestId)) {
        throw refused("DECISION_ALREADY_USED", "This Guardian decision was already acted on.", undefined, {
          requestId: entry.requestId,
        });
      }
      doc.decisions.push(entry);
    });
  }

  /**
   * Claims an update decision: the spend request's current decision must
   * still be `expected` and its request not yet sent for Link approval.
   * The current decision is superseded in the same write.
   */
  async claimUpdate(entry: DecisionEntry, spendRequestId: string, expected: string): Promise<void> {
    await this.update((doc) => {
      if (doc.decisions.some((e) => e.requestId === entry.requestId)) {
        throw refused("DECISION_ALREADY_USED", "This Guardian decision was already acted on.", undefined, {
          requestId: entry.requestId,
        });
      }
      const cur = doc.decisions.find((e) => e.spendRequestId === spendRequestId && live(e));
      if (!cur || cur.requestId !== expected || cur.state !== "created") {
        throw refused("WRONG_STATE", "The spend request changed state; nothing was updated.", undefined, {
          spendRequestId,
        });
      }
      cur.state = "superseded";
      doc.decisions.push({ ...entry, spendRequestId, replaces: expected });
    });
  }

  /** Binds a created spend request to its decision; one decision, one request. */
  async bind(requestId: string, spendRequestId: string): Promise<void> {
    await this.update((doc) => {
      const other = doc.decisions.find(
        (e) => e.spendRequestId === spendRequestId && e.requestId !== requestId,
      );
      if (other) {
        throw refused(
          "SPEND_REQUEST_REUSED",
          "Link returned a spend request another decision already holds.",
          undefined,
          { requestId, spendRequestId },
        );
      }
      const e = doc.decisions.find((x) => x.requestId === requestId);
      if (!e || e.state !== "acting" || (e.spendRequestId && e.spendRequestId !== spendRequestId)) {
        throw refused("WRONG_STATE", "This decision is not waiting for Link.", undefined, { requestId });
      }
      e.spendRequestId = spendRequestId;
    });
  }

  /** Moves a decision from one state to the next; refuses any other state. */
  async move(
    requestId: string,
    from: readonly DecisionEntry["state"][],
    to: DecisionEntry["state"],
    onWrongState: () => Error,
  ): Promise<void> {
    await this.update((doc) => {
      const e = doc.decisions.find((x) => x.requestId === requestId);
      if (!e || !from.includes(e.state)) throw onWrongState();
      e.state = to;
    });
  }

  /** Best effort: marks a decision, whatever its state, unless superseded. */
  async mark(requestId: string, to: DecisionEntry["state"]): Promise<void> {
    await this.update((doc) => {
      const e = doc.decisions.find((x) => x.requestId === requestId);
      if (e && e.state !== "superseded" && e.state !== "card-read") e.state = to;
    });
  }
}
