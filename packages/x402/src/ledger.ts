import type { SupportedNetwork } from "./constants.js";
import { X402GuardRefused } from "./util.js";

/**
 * A durable key-value store with an atomic compare-and-set, supplied by the
 * developer (a database row with a version column, for example). The guard
 * keeps budgets and live authorizations in it, so a restart forgets neither.
 */
export interface X402GuardStore {
  /** The current value and its version, or null when the key is absent. */
  get(key: string): Promise<{ value: string; version: string } | null>;
  /**
   * Write `value` only if the key's version is still `expectedVersion`
   * (null: only if the key is absent). Returns false on a conflict. Must be
   * atomic.
   */
  compareAndSet(
    key: string,
    expectedVersion: string | null,
    value: string,
  ): Promise<boolean>;
}

/** Reads `authorizationState(from, nonce)` on the token contract. */
export type AuthorizationStateReader = (query: {
  network: SupportedNetwork;
  asset: string;
  from: string;
  nonce: string;
}) => Promise<boolean>;

export type BudgetConfig = Readonly<{
  network: SupportedNetwork;
  asset: string;
  period: "day" | "month";
  /** Atomic units of the asset. */
  limit: string;
}>;

/**
 * One payment's local entry.
 * - reserved: amount held before Guardian is asked, nothing signed yet
 * - signing: about to sign; nonce and validBefore are known
 * - signed: an authorization exists and may be settled until validBefore
 * - spent: settled, or the chain shows the nonce used; never released
 * - released: no signature was made, or validBefore passed and the chain
 *   shows the nonce unused
 */
export type LedgerEntry = {
  id: string;
  requestKey: string;
  network: SupportedNetwork;
  asset: string;
  amount: string;
  createdAtMs: number;
  /** A "reserved" entry is not released by reconcile before this time. */
  holdUntilMs?: number;
  state: "reserved" | "signing" | "signed" | "spent" | "released";
  from?: string;
  nonce?: string;
  /** Unix seconds. */
  validBefore?: number;
  requestId?: string;
  sent?: "unknown" | "not-sent";
};

type LedgerDoc = { entries: LedgerEntry[] };

const LEDGER_KEY = "guardian-x402:v1:ledger";
const MAX_CAS_ATTEMPTS = 16;
const KEEP_FINAL_MS = 40 * 24 * 3600 * 1000;

/** In-process store used for live authorizations when none is given. */
export function processStore(): X402GuardStore {
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

function periodId(ms: number, period: "day" | "month"): string {
  const iso = new Date(ms).toISOString();
  return period === "day" ? iso.slice(0, 10) : iso.slice(0, 7);
}

const counts = (e: LedgerEntry) => e.state !== "released";

/** Live: may still be settled (or may still be signed). */
export function isLive(e: LedgerEntry, nowMs: number): boolean {
  if (e.state === "released") return false;
  if (e.state === "reserved") return true;
  return e.validBefore === undefined || e.validBefore * 1000 > nowMs;
}

export class Ledger {
  constructor(
    private readonly store: X402GuardStore,
    private readonly budgets: readonly BudgetConfig[],
  ) {}

  private async read(): Promise<{ doc: LedgerDoc; version: string | null }> {
    let current: { value: string; version: string } | null;
    try {
      current = await this.store.get(LEDGER_KEY);
    } catch {
      throw new X402GuardRefused(
        "STORE_UNAVAILABLE",
        "The guard's store cannot be read.",
      );
    }
    if (current === null) return { doc: { entries: [] }, version: null };
    try {
      const doc = JSON.parse(current.value) as LedgerDoc;
      if (!doc || !Array.isArray(doc.entries)) throw new Error("bad");
      return { doc, version: current.version };
    } catch {
      throw new X402GuardRefused(
        "STORE_UNAVAILABLE",
        "The guard's store holds data it cannot read.",
      );
    }
  }

  /** Read-modify-write with compare-and-set; `change` may throw to abort. */
  private async update<T>(
    change: (doc: LedgerDoc) => T,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const { doc, version } = await this.read();
      const result = change(doc);
      let written: boolean;
      try {
        written = await this.store.compareAndSet(
          LEDGER_KEY,
          version,
          JSON.stringify(doc),
        );
      } catch {
        throw new X402GuardRefused(
          "STORE_UNAVAILABLE",
          "The guard's store cannot be written.",
        );
      }
      if (written) return result;
    }
    throw new X402GuardRefused(
      "STORE_UNAVAILABLE",
      "The guard's store kept changing; nothing was reserved.",
    );
  }

  async entries(): Promise<LedgerEntry[]> {
    return (await this.read()).doc.entries;
  }

  /**
   * Atomically checks budgets and records a reservation. Returns the live
   * entries for the same request that existed before this one: same
   * request key, or one of `sameRequestIds`.
   */
  async reserve(
    entry: LedgerEntry,
    nowMs: number,
    sameRequestIds: readonly string[] = [],
  ): Promise<{ liveForRequest: LedgerEntry[] }> {
    return this.update((doc) => {
      // Entries older than any budget period that can no longer be settled
      // are dropped, so the document stays small.
      doc.entries = doc.entries.filter(
        (e) => !(nowMs - e.createdAtMs > KEEP_FINAL_MS && !isLive(e, nowMs)),
      );
      for (const budget of this.budgets) {
        if (
          budget.network !== entry.network ||
          budget.asset.toLowerCase() !== entry.asset
        ) {
          continue;
        }
        const pid = periodId(entry.createdAtMs, budget.period);
        let used = 0n;
        for (const e of doc.entries) {
          if (
            counts(e) &&
            e.network === entry.network &&
            e.asset === entry.asset &&
            periodId(e.createdAtMs, budget.period) === pid
          ) {
            used += BigInt(e.amount);
          }
        }
        if (used + BigInt(entry.amount) > BigInt(budget.limit)) {
          throw new X402GuardRefused(
            "BUDGET_EXCEEDED",
            `This payment would exceed the local ${budget.period} budget for this asset.`,
          );
        }
      }
      const liveForRequest = doc.entries.filter(
        (e) =>
          (e.requestKey === entry.requestKey || sameRequestIds.includes(e.id)) &&
          isLive(e, nowMs),
      );
      doc.entries.push(entry);
      return { liveForRequest };
    });
  }

  async patch(
    id: string,
    change: (entry: LedgerEntry) => void,
  ): Promise<LedgerEntry | undefined> {
    return this.update((doc) => {
      const entry = doc.entries.find((e) => e.id === id);
      if (entry) change(entry);
      return entry ? { ...entry } : undefined;
    });
  }

  async patchByNonce(
    nonce: string,
    change: (entry: LedgerEntry) => void,
  ): Promise<LedgerEntry | undefined> {
    const lower = nonce.toLowerCase();
    return this.update((doc) => {
      const entry = doc.entries.find((e) => e.nonce === lower);
      if (entry) change(entry);
      return entry ? { ...entry } : undefined;
    });
  }

  /** Release an entry only if no signature was made for it. */
  async releaseUnsigned(id: string): Promise<void> {
    await this.patch(id, (e) => {
      if (e.state === "reserved") e.state = "released";
    });
  }
}
