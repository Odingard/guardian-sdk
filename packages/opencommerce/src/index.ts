import {
  forModelError,
  parseBuyToolInput,
  type BuyCart,
  type BuyTool,
  type BuyToolInput,
  type BuyToolResult,
  type BuyToolTurn,
} from "@agent-cards/commerce-sdk";
import {
  createGuardianContext,
  runThroughGuardian,
  type GuardianClient,
  type GuardianDecisionResult,
} from "@odingard/guardian-sdk";

/** The Guardian tool name a checkout is proposed under, unless `toolName` says otherwise. */
export const DEFAULT_CHECKOUT_TOOL = "opencommerce.checkout";

/**
 * The amount declaration the package sends with every checkout. Register the
 * checkout tool in the Guardian console (record transport) with exactly this under
 * Connections → Dollar amounts, so the per-amount rules apply.
 */
export const CHECKOUT_AMOUNT_DECLARATION = Object.freeze({
  argument: "amountMinor",
  unit: "minor" as const,
  currency: "usd" as const,
});

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Claim answers that decide nothing yet: the request stays held and the wait goes on. */
const STILL_HELD = new Set([
  "APPROVAL_PENDING",
  "APPROVAL_REQUIRED",
  "SERVICE_UNAVAILABLE",
  "RATE_LIMITED",
  "DB_BUSY",
  "HTTP_429",
]);
const stillHeld = (code: string) =>
  STILL_HELD.has(code) || /^HTTP_5\d\d$/.test(code);

export type GuardianOpencommerceOptions = Readonly<{
  /** A Guardian client (`createGuardianClient` from `@odingard/guardian-sdk`). */
  client: GuardianClient;
  /** The Guardian connection the checkout tool is registered on. */
  connectionId: string;
  /** Guardian tool name for a checkout. Default `opencommerce.checkout`. */
  toolName?: string;
  adapterId?: string;
  agentName?: string;
  /** How long a checkout waits for a person after Guardian answers ASK. Default 10 minutes. */
  approvalTimeoutMs?: number;
  /** How often the held request is claimed while a person decides. Default 2 s. */
  pollIntervalMs?: number;
  /** Each Guardian decision on a checkout (no card data, no Agentcard secrets). */
  onDecision?: (event: CheckoutDecisionEvent) => void;
  /**
   * The purchase reached Agentcard, but Guardian's signed record of it
   * could not be completed (for example, redeeming the capability failed).
   */
  onRecordError?: (error: unknown, checkout: CheckoutFacts) => void;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}>;

export type CheckoutDecisionEvent = Readonly<{
  decision: "ALLOW" | "ASK" | "APPROVED" | "DENY" | "TIMEOUT" | "ERROR";
  requestId?: string;
  reasonCode?: string;
  checkout: CheckoutFacts;
}>;

/** One line of a cart, as Guardian and the person approving see it. */
export type CheckoutLine = Readonly<{
  name: string;
  qty: number;
  priceCents: number | null;
  lineTotalCents: number | null;
  variant: string | null;
}>;

/** One store's cart in a checkout. */
export type CheckoutCart = Readonly<{
  store: string;
  merchant: string;
  cartHash: string;
  totalCents: number;
  /** The most the card can be charged for this cart (total, hold or Link charge, whichever is highest). */
  maxChargeCents: number;
  totalIsEstimate: boolean;
  items: CheckoutLine[];
}>;

/**
 * What is proposed to Guardian for a checkout: these are the tool call's
 * arguments, and the approval screen and the signed record show them.
 */
export type CheckoutFacts = Readonly<{
  /** The sum of every cart's `maxChargeCents`, in cents. */
  amountMinor: number;
  currency: "usd";
  stores: string[];
  carts: CheckoutCart[];
  conversationId: string | null;
  /** `confirm` (the model's yes), `approve` (the wallet's Approve) or `next_step` (a yes carried past a step). */
  step: "confirm" | "approve" | "next_step";
}>;

/** Guardian did not let this purchase go ahead; nothing was sent to Agentcard. */
export class GuardianPurchaseBlocked extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly reasonCode: string | undefined;
  readonly checkout: CheckoutFacts | undefined;
  constructor(args: {
    code: string;
    detail: string;
    requestId?: string;
    reasonCode?: string;
    checkout?: CheckoutFacts;
  }) {
    super(`Guardian blocked this purchase: ${args.detail}`);
    this.name = "GuardianPurchaseBlocked";
    this.code = args.code;
    this.requestId = args.requestId;
    this.reasonCode = args.reasonCode;
    this.checkout = args.checkout;
  }
}

/** The JSON text the model reads when Guardian blocked a purchase. */
export function blockedForModel(error: GuardianPurchaseBlocked): string {
  return JSON.stringify({
    status: "declined",
    decline_code: "guardian_blocked",
    reply: `${error.message} Nothing was ordered or charged.`,
    guardian: {
      code: error.code,
      ...(error.reasonCode ? { reason_code: error.reasonCode } : {}),
      ...(error.requestId ? { request_id: error.requestId } : {}),
    },
  });
}

type AnyTool = BuyTool | BuyToolTurn;

/** What the wrapper last saw on the table, shared by the tool and every turn it opens. */
type Table = { carts: BuyCart[]; conversationId: string | null };

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function maxCharge(cart: BuyCart): number {
  return Math.max(
    cart.totalCents,
    cart.hold?.amountCents ?? 0,
    cart.linkChargeCents ?? 0,
    0,
  );
}

function storeOf(cart: BuyCart): string {
  return cart.store?.name ?? cart.merchant_name ?? cart.merchant;
}

/** The checkout Guardian decides, from the carts on the table. Throws GuardianPurchaseBlocked when it cannot be described. */
export function checkoutFacts(
  carts: readonly BuyCart[],
  conversationId: string | null,
  step: CheckoutFacts["step"],
): CheckoutFacts {
  if (carts.length === 0) {
    throw new GuardianPurchaseBlocked({
      code: "NO_CART_SEEN",
      detail:
        "there is no cart Guardian has seen to approve. Show the shopper the cart again, then confirm.",
    });
  }
  const described: CheckoutCart[] = [];
  let amountMinor = 0;
  for (const cart of carts) {
    const currency = (cart.currency ?? "usd").toLowerCase();
    if (currency !== "usd") {
      throw new GuardianPurchaseBlocked({
        code: "CURRENCY_UNSUPPORTED",
        detail: `the cart at ${storeOf(cart)} is in ${currency.toUpperCase()}, and Guardian's amount rules are in US dollars.`,
      });
    }
    const max = maxCharge(cart);
    if (!Number.isSafeInteger(max) || max < 0) {
      throw new GuardianPurchaseBlocked({
        code: "AMOUNT_UNREADABLE",
        detail: `the total of the cart at ${storeOf(cart)} could not be read.`,
      });
    }
    amountMinor += max;
    described.push({
      store: storeOf(cart),
      merchant: cart.merchant,
      cartHash: cart.hash,
      totalCents: cart.totalCents,
      maxChargeCents: max,
      totalIsEstimate: cart.totalIsEstimate,
      items: cart.items.map((line) => ({
        name: line.name,
        qty: line.qty,
        priceCents: line.priceCents ?? null,
        lineTotalCents: line.lineTotalCents,
        variant: line.variant,
      })),
    });
  }
  return {
    amountMinor,
    currency: "usd",
    stores: [...new Set(described.map((c) => c.store))],
    carts: described,
    conversationId,
    step,
  };
}

function purposeOf(facts: CheckoutFacts): string {
  const lines = facts.carts
    .map(
      (cart) =>
        `${cart.items.map((i) => `${i.qty} × ${i.name}`).join(", ")} at ${cart.store}`,
    )
    .join("; ");
  return `Buy ${lines} for up to ${dollars(facts.amountMinor)} (opencommerce)`.slice(
    0,
    500,
  );
}

function remember(table: Table, result: BuyToolResult): void {
  // The carts the answer shows are the ones a later yes confirms.
  table.carts =
    result.carts.length > 0
      ? [...result.carts]
      : result.cart
        ? [result.cart]
        : [];
  if (result.conversation_id) table.conversationId = result.conversation_id;
}

const isDecision = (value: unknown): value is GuardianDecisionResult =>
  typeof value === "object" &&
  value !== null &&
  "guardian" in value &&
  typeof (value as { guardian?: unknown }).guardian === "object";

/**
 * Put Guardian in front of the step of an opencommerce buy tool that commits
 * money. Returns a tool of the same shape: pass it where you passed `buy`.
 *
 * - A call with `confirm: false` (search, picks, questions) goes to Agentcard
 *   as it is, without Guardian.
 * - A call with `confirm: true`, a wallet's `approve()`, and every call of a
 *   turn `nextStep` opens (which can carry the shopper's earlier yes) are
 *   proposed to Guardian, before Agentcard, as the tool `opencommerce.checkout`, with the
 *   amount in cents, the stores, the cart hashes and every line.
 * - ALLOW: the call goes to Agentcard and Guardian keeps its signed record.
 *   ASK: the call waits for the person, then goes ahead if they
 *   approved. DENY, a timeout, Guardian unreachable or any error: nothing
 *   reaches Agentcard, and the model reads "Guardian blocked this purchase: …".
 * - The approval is for that exact checkout: if a cart, its amount or its store
 *   changes, the next confirm is a new request.
 */
export function guardBuyTool<T extends AnyTool>(
  buy: T,
  options: GuardianOpencommerceOptions,
): T {
  return wrap(buy, options, { carts: [], conversationId: null }, false);
}

function wrap<T extends AnyTool>(
  buy: T,
  options: GuardianOpencommerceOptions,
  table: Table,
  everyCallMayPay: boolean,
): T {
  const original = buy as unknown as Record<string, unknown> & BuyTool;
  const answerOf = original.answer.bind(original) as (
    input: BuyToolInput,
  ) => Promise<BuyToolResult>;

  const answer = async (input: BuyToolInput): Promise<BuyToolResult> => {
    const checked = parseBuyToolInput(input);
    if (!checked.confirm && !everyCallMayPay) {
      const result = await answerOf(input);
      remember(table, result);
      return result;
    }
    const step = checked.confirm ? "confirm" : "next_step";
    const result = await governed(options, table, step, () => answerOf(input));
    remember(table, result);
    return result;
  };

  const handle = async (args: unknown): Promise<string> => {
    let input: BuyToolInput;
    try {
      input = parseBuyToolInput(args);
    } catch (error) {
      throw forModelError(error);
    }
    try {
      return JSON.stringify(original.forModel(await answer(input)));
    } catch (error) {
      if (error instanceof GuardianPurchaseBlocked)
        return blockedForModel(error);
      throw forModelError(error);
    }
  };

  const overrides: Record<string, unknown> = {
    answer,
    run: handle,
    execute: handle,
    handle,
  };
  if (typeof original.approve === "function") {
    const approve = original.approve.bind(original);
    overrides.approve = async (
      approveOptions?: Parameters<typeof approve>[0],
    ) => {
      const result = await governed(options, table, "approve", () =>
        approve(approveOptions),
      );
      remember(table, result);
      return result;
    };
  }
  if (typeof original.turn === "function") {
    const turn = original.turn.bind(original);
    overrides.turn = (...args: Parameters<typeof turn>) =>
      wrap(turn(...args), options, table, false);
  }
  if (typeof original.nextStep === "function") {
    const nextStep = original.nextStep.bind(original);
    overrides.nextStep = (...args: Parameters<typeof nextStep>) => {
      const opened = nextStep(...args);
      return opened === null ? null : wrap(opened, options, table, true);
    };
  }

  // Same fields, the non-enumerable ones too (definition, inputSchema, openai),
  // so every framework reads the tool as before.
  const governedTool = Object.create(Object.getPrototypeOf(original));
  Object.defineProperties(
    governedTool,
    Object.getOwnPropertyDescriptors(original),
  );
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(governedTool, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return governedTool as T;
}

async function governed(
  options: GuardianOpencommerceOptions,
  table: Table,
  step: CheckoutFacts["step"],
  send: () => Promise<BuyToolResult>,
): Promise<BuyToolResult> {
  const facts = checkoutFacts(table.carts, table.conversationId, step);
  const toolName = options.toolName ?? DEFAULT_CHECKOUT_TOOL;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const timeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const notify = (event: Omit<CheckoutDecisionEvent, "checkout">) => {
    try {
      options.onDecision?.({ ...event, checkout: facts });
    } catch {
      // a listener never changes the decision
    }
  };
  const block = (
    code: string,
    detail: string,
    extra: { requestId?: string; reasonCode?: string } = {},
  ) => new GuardianPurchaseBlocked({ code, detail, checkout: facts, ...extra });

  // One context per checkout: a held request is claimed just inside this
  // wait, for exactly these arguments.
  const ctx = createGuardianContext({
    client: options.client,
    connectionId: options.connectionId,
    mode: "inProcess",
    onAsk: "result",
    onDeny: "result",
    amountArgs: { [toolName]: CHECKOUT_AMOUNT_DECLARATION },
    purpose: () => purposeOf(facts),
    ...(options.adapterId ? { adapterId: options.adapterId } : {}),
    ...(options.agentName ? { agentName: options.agentName } : {}),
  });

  let sent = false;
  let result: BuyToolResult | undefined;
  let agentcardError: { error: unknown } | undefined;
  const runTool = async () => {
    // The cart must still be the one Guardian decided on.
    const current = checkoutFacts(table.carts, table.conversationId, step);
    if (JSON.stringify(current) !== JSON.stringify(facts)) {
      throw block(
        "CART_CHANGED",
        "the cart changed after Guardian decided. Show the shopper the new cart and confirm again.",
      );
    }
    sent = true;
    try {
      result = await send();
    } catch (error) {
      agentcardError = { error };
      throw error;
    }
    return result;
  };

  const attempt = async (): Promise<unknown> => {
    try {
      return await runThroughGuardian(ctx, toolName, facts, runTool);
    } catch (error) {
      if (agentcardError) throw agentcardError.error;
      if (sent && result !== undefined) {
        // Agentcard took the call; just Guardian's record of it failed.
        try {
          options.onRecordError?.(error, facts);
        } catch {
          // ignore
        }
        return result;
      }
      if (error instanceof GuardianPurchaseBlocked) throw error;
      notify({ decision: "ERROR" });
      throw block(
        "GUARDIAN_UNREACHABLE",
        "Guardian could not be reached or answered with an error, so the purchase did not go ahead.",
      );
    }
  };

  const deadline = now() + timeoutMs;
  let answer = await attempt();
  let heldRequestId: string | undefined;
  for (;;) {
    if (!isDecision(answer)) {
      if (result === undefined) {
        throw block(
          "GUARDIAN_UNREACHABLE",
          "Guardian's answer could not be read.",
        );
      }
      notify(
        heldRequestId
          ? { decision: "APPROVED", requestId: heldRequestId }
          : { decision: "ALLOW" },
      );
      return result;
    }
    const g = answer.guardian;
    if (g.decision === "ALLOW") {
      // Remote-mode shape; never expected in process. Fail closed.
      throw block(
        "GUARDIAN_UNEXPECTED",
        "Guardian's answer could not be used.",
      );
    }
    if (g.decision === "ASK") {
      if (!heldRequestId) notify({ decision: "ASK", requestId: g.requestId });
      heldRequestId = g.requestId;
    } else if (!(heldRequestId !== undefined && stillHeld(g.reasonCode))) {
      notify({
        decision: "DENY",
        reasonCode: g.reasonCode,
        ...(g.requestId ? { requestId: g.requestId } : {}),
      });
      if (g.reasonCode === "SERVICE_UNAVAILABLE") {
        throw block(
          "GUARDIAN_UNREACHABLE",
          "Guardian could not be reached, so the purchase did not go ahead.",
          { reasonCode: g.reasonCode },
        );
      }
      throw block(
        heldRequestId ? "APPROVAL_DECLINED" : "GUARDIAN_DENIED",
        heldRequestId
          ? `the person declined it (${g.reasonCode}).`
          : `the owner's rules do not allow it (${g.reasonCode}).`,
        {
          reasonCode: g.reasonCode,
          ...(g.requestId ? { requestId: g.requestId } : {}),
        },
      );
    }
    if (now() >= deadline) {
      notify({ decision: "TIMEOUT", requestId: heldRequestId! });
      try {
        await options.client.withdraw?.(heldRequestId!);
      } catch {
        // best effort: the request ends with its TTL anyway
      }
      throw block("APPROVAL_TIMEOUT", "no person approved it in time.", {
        requestId: heldRequestId!,
      });
    }
    await sleep(Math.max(1, Math.min(pollMs, deadline - now())));
    answer = await attempt();
  }
}
