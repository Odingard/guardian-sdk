import type { RecurrenceFrequency } from "./constants.js";
import { Ap2GuardRefused } from "./util.js";

/**
 * A durable key-value store with an atomic compare-and-set, supplied by the
 * developer (a database row with a version column, for example). The guard
 * keeps open-mandate use, budgets and outstanding presentations in it, so a
 * restart forgets none of them.
 */
export interface Ap2GuardStore {
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
 * One closed pair (or one human-present payment).
 * - reserved: amount held before Guardian is asked, nothing signed yet
 * - signing: the guard is signing the closed mandates
 * - signed: closed mandates exist; they may be presented
 * - presented: sent at least once to the credential provider or merchant
 * - complete: a verified Success payment receipt; never released
 * - released: nothing was signed, a verified Error Payment Receipt came
 *   back, or a verified Error Checkout Receipt came back before the payment
 *   mandate was ever presented
 */
export type LedgerEntry = {
  id: string;
  /** Open payment mandate `sd_hash` (human not present) or `hp:<checkout_hash>`. */
  key: string;
  mode: "human-not-present" | "human-present";
  currency: string;
  amount: number;
  createdAtMs: number;
  /** A "reserved" entry counts until this time; then it is stale and released. */
  holdUntilMs: number;
  state: "reserved" | "signing" | "signed" | "presented" | "complete" | "released";
  requestId?: string;
  /** base64url(SHA-256(closed checkout mandate JWT)), the receipt `reference`. */
  checkoutReference?: string;
  /** base64url(SHA-256(closed payment mandate JWT)). */
  paymentReference?: string;
  receipts?: { checkout?: "Success" | "Error"; payment?: "Success" | "Error" };
  /** Which closed mandates were handed to a send function (set before the send). */
  presentedTo?: { checkout?: true; payment?: true };
  /** A verified receipt contradicted an earlier one (for example Success after a release). */
  conflict?: true;
};

/** `delegated`: open payment mandates a person approved through `delegate()`, with their `exp`. */
type LedgerDoc = { entries: LedgerEntry[]; delegated?: { key: string; expMs: number }[] };

const LEDGER_KEY = "guardian-ap2:v1:ledger";
const MAX_CAS_ATTEMPTS = 16;
const KEEP_FINAL_MS = 400 * 24 * 3600 * 1000;

/** In-process store, used when none is given. Forgets everything on restart. */
export function processStore(): Ap2GuardStore {
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

/** UTC period id of `ms` for a recurrence frequency. BIWEEKLY is handled by spacing. */
export function periodId(ms: number, frequency: RecurrenceFrequency): string | null {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  switch (frequency) {
    case "DAILY":
      return d.toISOString().slice(0, 10);
    case "WEEKLY": {
      // ISO week: the Monday that starts it.
      const day = (d.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
    }
    case "MONTHLY":
      return d.toISOString().slice(0, 7);
    case "QUARTERLY":
      return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case "ANNUALLY":
      return String(y);
    default:
      return null;
  }
}

const BIWEEKLY_MS = 14 * 24 * 3600 * 1000;

/** Counts against occurrences and budget. */
export const counts = (e: LedgerEntry, nowMs: number) =>
  e.state !== "released" && !(e.state === "reserved" && nowMs > e.holdUntilMs);

/** Signed or presented, with no verified receipt yet. */
export const outstanding = (e: LedgerEntry) => e.state === "signing" || e.state === "signed" || e.state === "presented";

export type ReserveRules = Readonly<{
  /** Recurrence from the open mandate; none means the mandate pays once. */
  recurrence?: Readonly<{ frequency: RecurrenceFrequency; maxOccurrences?: number }>;
  /** Budget in minor units, from the open mandate. */
  budgetMinor?: number;
}>;

export type ReserveResult = Readonly<{
  firstUse: boolean;
}>;

function storeError(detail: string): Ap2GuardRefused {
  return new Ap2GuardRefused("STORE_UNAVAILABLE", detail);
}

export class Ledger {
  constructor(private readonly store: Ap2GuardStore) {}

  private async read(): Promise<{ doc: LedgerDoc; version: string | null }> {
    let current: { value: string; version: string } | null;
    try {
      current = await this.store.get(LEDGER_KEY);
    } catch {
      throw storeError("The guard's store cannot be read.");
    }
    if (current === null) return { doc: { entries: [] }, version: null };
    try {
      const doc = JSON.parse(current.value) as LedgerDoc;
      if (!doc || !Array.isArray(doc.entries)) throw new Error("bad");
      return { doc, version: current.version };
    } catch {
      throw storeError("The guard's store holds data it cannot read.");
    }
  }

  /** Read-modify-write with compare-and-set; `change` may throw to abort. */
  private async update<T>(change: (doc: LedgerDoc) => T): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const { doc, version } = await this.read();
      const result = change(doc);
      let written: boolean;
      try {
        written = await this.store.compareAndSet(LEDGER_KEY, version, JSON.stringify(doc));
      } catch {
        throw storeError("The guard's store cannot be written.");
      }
      if (written) return result;
    }
    throw storeError("The guard's store kept changing; nothing was reserved.");
  }

  async entries(): Promise<LedgerEntry[]> {
    return (await this.read()).doc.entries;
  }

  /**
   * Atomically checks single use, recurrence (frequency and
   * max_occurrences), budget and in-flight use for `entry.key`, then records
   * the reservation.
   *
   * AP2 (Autonomous mode): an agent MUST NOT present a subsequent closed
   * pair under an open mandate before a rejection receipt for the previous
   * one. So while any pair under `entry.key` is signed or presented with no
   * verified receipt, a new one is refused outright; no approval overrides
   * this.
   */
  async reserve(entry: LedgerEntry, nowMs: number, rules: ReserveRules): Promise<ReserveResult> {
    return this.update((doc) => {
      doc.entries = doc.entries.filter((e) => !(nowMs - e.createdAtMs > KEEP_FINAL_MS && !outstanding(e)));
      const same = doc.entries.filter((e) => e.key === entry.key);
      if (same.some((e) => e.state === "reserved" && nowMs <= e.holdUntilMs)) {
        throw new Ap2GuardRefused("MANDATE_IN_USE", "Another payment from this open mandate is being decided.");
      }
      const live = same.filter((e) => counts(e, nowMs));
      if (live.some(outstanding)) {
        throw new Ap2GuardRefused(
          "OUTSTANDING_PRESENTATION",
          "A pair signed under this open mandate has no verified receipt yet; nothing more is signed until a rejection receipt for it arrives.",
        );
      }
      if (!rules.recurrence) {
        if (live.some((e) => e.state === "complete")) {
          throw new Ap2GuardRefused("MANDATE_ALREADY_USED", "This open mandate has already paid once and has no agent_recurrence.");
        }
      } else {
        const { frequency, maxOccurrences } = rules.recurrence;
        if (maxOccurrences !== undefined && live.length >= maxOccurrences) {
          throw new Ap2GuardRefused("RECURRENCE_EXCEEDED", `This open mandate allows ${maxOccurrences} payments; they are used.`);
        }
        if (frequency === "BIWEEKLY") {
          if (live.some((e) => nowMs - e.createdAtMs < BIWEEKLY_MS)) {
            throw new Ap2GuardRefused("RECURRENCE_EXCEEDED", "This open mandate pays at most once every 14 days.");
          }
        } else if (frequency !== "ON_DEMAND") {
          const pid = periodId(nowMs, frequency);
          if (live.some((e) => periodId(e.createdAtMs, frequency) === pid)) {
            throw new Ap2GuardRefused("RECURRENCE_EXCEEDED", `This open mandate already paid in this ${frequency.toLowerCase()} period.`);
          }
        }
      }
      if (rules.budgetMinor !== undefined) {
        const used = live.reduce((s, e) => s + e.amount, 0);
        if (used + entry.amount > rules.budgetMinor) {
          throw new Ap2GuardRefused("BUDGET_EXCEEDED", "This payment would exceed the open mandate's budget.");
        }
      }
      const delegated = (doc.delegated ?? []).some((d) => d.key === entry.key);
      const firstUse = !delegated && !same.some((e) => e.state === "complete");
      doc.entries.push(entry);
      return { firstUse };
    });
  }

  async patch(id: string, change: (entry: LedgerEntry) => void): Promise<LedgerEntry | undefined> {
    return this.update((doc) => {
      const entry = doc.entries.find((e) => e.id === id);
      if (entry) change(entry);
      return entry ? { ...entry } : undefined;
    });
  }

  /** Finds the entry a closed mandate reference belongs to and patches it. */
  async patchByReference(
    reference: string,
    change: (entry: LedgerEntry, which: "checkout" | "payment") => void,
  ): Promise<{ entry: LedgerEntry; which: "checkout" | "payment" } | undefined> {
    return this.update((doc) => {
      for (const e of doc.entries) {
        const which = e.checkoutReference === reference ? "checkout" : e.paymentReference === reference ? "payment" : null;
        if (which) {
          change(e, which);
          return { entry: { ...e }, which };
        }
      }
      return undefined;
    });
  }

  /** Records that a person approved this open payment mandate through `delegate()`. */
  async markDelegated(key: string, expMs: number, nowMs: number): Promise<void> {
    await this.update((doc) => {
      doc.delegated = (doc.delegated ?? []).filter((d) => d.expMs > nowMs);
      doc.delegated.push({ key, expMs });
    });
  }

  /** Release an entry only if nothing was signed for it. */
  async releaseUnsigned(id: string): Promise<void> {
    await this.patch(id, (e) => {
      if (e.state === "reserved") e.state = "released";
    });
  }
}
