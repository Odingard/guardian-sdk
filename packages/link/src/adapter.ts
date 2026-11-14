// The narrow interface between the guard and Stripe Link. Only the guard
// holds an adapter; the agent gets the guard. `linkCliAdapter` (cli.ts)
// runs the Link CLI in test mode; tests use a fake.

export type LinkLineItem = Readonly<{
  name: string;
  quantity: number;
  /** Minor units of the request's currency. */
  unitAmount: number;
}>;

export type LinkTotal = Readonly<{
  type: string;
  displayText: string;
  /** Minor units of the request's currency. */
  amount: number;
}>;

/** What the guard sends to create a spend request. */
export type LinkCreateInput = Readonly<{
  /** Always true: the guard creates test-mode spend requests only. */
  test: true;
  credentialType: "card";
  merchantName: string;
  merchantUrl: string;
  context: string;
  amount: number;
  currency: string;
  lineItems: readonly LinkLineItem[];
  totals: readonly LinkTotal[];
  /** Derived from the Guardian request id; Link creates at most one request per key. */
  idempotencyKey: string;
  /** Always false: the guard requests Link's approval as its own step. */
  requestApproval: false;
}>;

/** What the guard sends to update a spend request (fields Link can update). */
export type LinkUpdateInput = Readonly<{
  merchantUrl: string;
  amount: number;
  currency: string;
  lineItems: readonly LinkLineItem[];
  totals: readonly LinkTotal[];
}>;

/**
 * A spend request as the adapter read it from Link, without card details.
 * Fields Link did not return are absent.
 */
export type LinkSpendRequestView = Readonly<{
  id: string;
  status: string;
  merchantName?: string;
  merchantUrl?: string;
  context?: string;
  amount?: number;
  currency?: string;
  credentialType?: string;
  lineItems?: readonly Readonly<{ name?: unknown; quantity?: unknown; unitAmount?: unknown }>[];
  totals?: readonly Readonly<{ type?: unknown; displayText?: unknown; amount?: unknown }>[];
  /**
   * Names of fields Link returned that the guard neither compares nor can
   * accept (a recurring schedule, metadata, a line item's URL, an unknown
   * field, an expiry past Link's one-time default). Empty when none; the
   * guard refuses any spend request where it is not empty.
   */
  unexpectedFields: readonly string[];
}>;

/** Raw card details, as the adapter read them. The guard wraps them in a `LinkCard`. */
export type LinkCardData = Readonly<{
  number: string;
  cvc?: string;
  expMonth: number;
  expYear: number;
  brand?: string;
  billingAddress?: Readonly<Record<string, string | undefined>>;
  validUntil?: string;
}>;

/**
 * Link's approval policy. `none` only when Link positively says there is
 * none; anything the adapter cannot read is `unknown`, and the guard
 * refuses on `present` and on `unknown`.
 */
export type LinkApprovalPolicyState =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "present" }>
  | Readonly<{ state: "unknown"; detail?: string }>;

export interface LinkAdapter {
  approvalPolicy(): Promise<LinkApprovalPolicyState>;
  createSpendRequest(input: LinkCreateInput): Promise<LinkSpendRequestView>;
  updateSpendRequest(id: string, input: LinkUpdateInput): Promise<LinkSpendRequestView>;
  requestApproval(id: string): Promise<void>;
  /** Without card details. */
  retrieveSpendRequest(id: string): Promise<LinkSpendRequestView>;
  /**
   * Reads the card for an approved request, once. Returns the request as
   * Link returned it with the card, so the guard can check it again.
   */
  readCard(id: string): Promise<Readonly<{ request: LinkSpendRequestView; card: LinkCardData }>>;
  cancelSpendRequest(id: string): Promise<void>;
}
