// The guard's record of each Guardian decision and the one spend request it
// acted on. Kept in a developer-supplied compare-and-set store, so a
// restart forgets neither which decisions were used nor which cards were
// read. Never holds card details.
import type { CanonicalTerms } from "./terms.js";
import { refused } from "./util.js";

/**
 * A durable key-value store with an atomic compare-and-set, supplied by the
 * developer (a database row with a version column, for example).
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
    | "refused";
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

export class Ledger {
  constructor(private readonly store: LinkGuardStore) {}

  private async read(): Promise<{ doc: LedgerDoc; version: string | null }> {
    let current: { value: string; version: string } | null;
    try {
      current = await this.store.get(LEDGER_KEY);
    } catch {
      throw refused("STORE_UNAVAILABLE", "The guard's store cannot be read.");
    }
    if (current === null) return { doc: { decisions: [] }, version: null };
    try {
      const doc = JSON.parse(current.value) as LedgerDoc;
      if (!doc || !Array.isArray(doc.decisions)) throw new Error("bad");
      return { doc, version: current.version };
    } catch {
      throw refused("STORE_UNAVAILABLE", "The guard's store holds data it cannot read.");
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
