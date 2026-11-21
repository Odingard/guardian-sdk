// Guardian in front of the Agentcard buy tool's checkout.
//
// Not built on the SDK's shared runThroughGuardian (see CONTRIBUTING.md,
// "Payment guards"): in `inProcess` mode the triad sends the action before
// it redeems the capability, so revocation, expiry and single use would land
// after the order was placed. This guard calls `request` / `claim` /
// `execute` itself and sends the confirm to Agentcard only once Guardian
// redeemed the decision.
//
// The gate sits where the confirm leaves the buy tool: the Agentcard client's
// `buy` request. Every request that pays (a `confirm`, or a Link payment)
// goes through Guardian, whichever method of the tool sent it: a model call,
// `approve()`, a `nextStep` turn, or `handled()`.
import { AsyncLocalStorage } from "node:async_hooks";

import {
  AgentcardApiError,
  forModelError,
  parseBuyToolInput,
  type BuyCart,
  type BuyTool,
  type BuyToolInput,
  type BuyToolResult,
  type BuyToolTurn,
} from "@agent-cards/commerce-sdk";
import {
  classifyRequestResult,
  GUARDIAN_MAX_REQUEST_TTL_MS,
  type GuardianClient,
  type GuardianInvocation,
  verifyReceiptOffline,
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

/**
 * How long a checkout request stays open at Guardian, and so the longest a
 * checkout waits for a person after ASK: the gateway's limit, 5 minutes.
 */
export const DEFAULT_REQUEST_TTL_MS = GUARDIAN_MAX_REQUEST_TTL_MS;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;

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
/** A claim answer that says the request ran out of time, which is no person's decline. */
const expired = (code: string) => /EXPIRED/.test(code);

/** What the guard uses of the Agentcard client the buy tool was built with. */
export type GuardedAgentcard = {
  buy: (body: never, ...rest: never[]) => Promise<unknown>;
  conversation: (
    conversationId: string,
    who?: { externalUserId?: string; userId?: string },
  ) => Promise<{ conversation_id?: string; carts: BuyCart[] }>;
};

export type GuardianOpencommerceOptions = Readonly<{
  /** A Guardian client (`createGuardianClient` from `@odingard/guardian-sdk`). */
  client: GuardianClient;
  /** The Guardian connection the checkout tool is registered on. */
  connectionId: string;
  /**
   * The `AgentcardClient` the buy tool was built with (`buyTool({ agentcard })`).
   * Every request of it that pays goes through Guardian; such a request made
   * outside the governed tool is refused.
   */
  agentcard: GuardedAgentcard;
  /** Guardian tool name for a checkout. Default `opencommerce.checkout`. */
  toolName?: string;
  adapterId?: string;
  /**
   * How long the checkout request stays open at Guardian, in ms, and so how
   * long a checkout waits for a person after ASK. Default and maximum 5
   * minutes (the gateway's limit).
   */
  requestTtlMs?: number;
  /** How often the held request is claimed while a person decides. Default 2 s. */
  pollIntervalMs?: number;
  /** The longest each call to Guardian or the conversation read may take. Default 15 s. */
  callTimeoutMs?: number;
  /**
   * Receipt verification keys (`fetchReceiptVerificationKeys`). When given,
   * the signed record of a person's approval must verify against them.
   */
  receiptVerificationKeys?: unknown;
  /** Each Guardian decision on a checkout (no card data, no Agentcard secrets). */
  onDecision?: (event: CheckoutDecisionEvent) => void;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}>;

export type CheckoutDecisionEvent = Readonly<{
  decision:
    | "ALLOW"
    | "ASK"
    | "APPROVED"
    | "DENY"
    | "EXPIRED"
    | "TIMEOUT"
    | "ERROR";
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
  /** The sum of every confirmed cart's `maxChargeCents` (or the Link charge, if higher), in cents. */
  amountMinor: number;
  currency: "usd";
  stores: string[];
  /** Exactly the carts this confirm pays. */
  carts: CheckoutCart[];
  /** `one_cart`: the confirm names one cart by its hash. `every_cart`: one approval for every cart of the conversation. */
  confirms: "one_cart" | "every_cart";
  conversationId: string | null;
  /** `confirm` (a yes), `approve` (the wallet's Approve) or `next_step` (a yes carried past a step). */
  step: "confirm" | "approve" | "next_step";
}>;

/**
 * Guardian did not let this purchase go ahead; nothing was sent to Agentcard.
 *
 * It is an `AgentcardApiError` with status 403, so the buy tool reads it as a
 * refusal answered before anything was sent (a Stripe Link confirm releases
 * its payment and frees the cart) and never as a lost answer. Its `code` is
 * Guardian's own (`GUARDIAN_DENIED`, `APPROVAL_TIMEOUT`, ...); the model reads
 * `decline_code: "guardian_blocked"`.
 */
export class GuardianPurchaseBlocked extends AgentcardApiError {
  readonly requestId: string | undefined;
  readonly reasonCode: string | undefined;
  readonly checkout: CheckoutFacts | undefined;
  /** True when Guardian may have redeemed the decision; look the request up before retrying. */
  readonly outcomeUnknown: boolean;
  constructor(args: {
    code: string;
    detail: string;
    requestId?: string;
    reasonCode?: string;
    checkout?: CheckoutFacts;
    outcomeUnknown?: boolean;
  }) {
    super(403, args.code, `Guardian blocked this purchase: ${args.detail}`, {
      error_code: "guardian_blocked",
      decline_code: "guardian_blocked",
    });
    this.name = "GuardianPurchaseBlocked";
    this.requestId = args.requestId;
    this.reasonCode = args.reasonCode;
    this.checkout = args.checkout;
    this.outcomeUnknown = args.outcomeUnknown === true;
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
type Table = {
  carts: BuyCart[];
  conversationId: string | null;
  /** True once a paying request went through the gate for this tool. */
  paid: boolean;
};

/** The tool call a request to Agentcard is made inside. */
type Scope = Readonly<{
  options: GuardianOpencommerceOptions;
  table: Table;
  step: CheckoutFacts["step"];
  /** Set when a paying request went through the gate in this call. */
  run: Run;
}>;

/** What the gate did in one call of the tool. */
type Run = {
  /** A paying request went through the gate. */
  paid: boolean;
  /** The gate refused a paying request: the result answers that refusal. */
  blocked?: GuardianPurchaseBlocked;
};

const scope = new AsyncLocalStorage<Scope>();

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/** The checkout Guardian decides, from the carts the confirm pays. Throws GuardianPurchaseBlocked when it cannot be described. */
export function checkoutFacts(
  carts: readonly BuyCart[],
  conversationId: string | null,
  step: CheckoutFacts["step"],
  confirms: CheckoutFacts["confirms"] = "every_cart",
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
    confirms,
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

/** What an Agentcard answer says about the purchase, for the confirm that follows. */
function observe(table: Table, turn: unknown): void {
  if (!isRecord(turn)) return;
  if (typeof turn.conversation_id === "string" && turn.conversation_id) {
    table.conversationId = turn.conversation_id;
  }
  if (Array.isArray(turn.carts) && turn.carts.length > 0) {
    table.carts = [...(turn.carts as BuyCart[])];
  }
}

const GATED = Symbol.for("@odingard/guardian-opencommerce.gate");

/**
 * Puts Guardian in the Agentcard client's `buy`: a request that pays goes
 * to Agentcard only after Guardian redeemed its decision. Once per client.
 */
function installGate(agentcard: GuardedAgentcard): void {
  const target = agentcard as unknown as Record<PropertyKey, unknown>;
  if (target[GATED] === true) return;
  const original = (
    agentcard.buy as unknown as (...args: unknown[]) => Promise<unknown>
  ).bind(agentcard);
  const gated = async (...args: unknown[]): Promise<unknown> => {
    const body = args[0];
    const current = scope.getStore();
    const pays =
      isRecord(body) &&
      (body.confirm !== undefined || Object.hasOwn(body, "link_payment"));
    if (!pays) {
      const turn = await original(...args);
      if (current) observe(current.table, turn);
      return turn;
    }
    if (!current) {
      throw new GuardianPurchaseBlocked({
        code: "UNGOVERNED_CALL",
        detail:
          "a purchase request reached the Agentcard client outside the governed buy tool, so it was not sent.",
      });
    }
    let turn: unknown;
    try {
      turn = await checkout(current, agentcard, body, () => {
        current.run.paid = true;
        current.table.paid = true;
        return original(...args);
      });
    } catch (error) {
      if (error instanceof GuardianPurchaseBlocked) current.run.blocked = error;
      throw error;
    }
    observe(current.table, turn);
    return turn;
  };
  Object.defineProperty(target, "buy", {
    value: gated,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(target, GATED, { value: true });
}

/**
 * Put Guardian in front of every step of an opencommerce buy tool that
 * commits money. Returns a tool of the same shape: pass it where you passed
 * `buy`, and pass the `AgentcardClient` the tool was built with as
 * `agentcard`.
 *
 * - Requests that do not pay (search, picks, questions, a `nextStep` turn
 *   that replays the shopper's words) go to Agentcard as they are.
 * - Every request that pays (a `confirm`, from the model, a wallet's
 *   `approve()`, a `nextStep` turn carrying an earlier yes, or `handled()`'s
 *   fast path; or a Link payment) is proposed to Guardian first, as
 *   `opencommerce.checkout`, with exactly the carts it pays, read from the
 *   conversation as they stand.
 * - ALLOW, or ASK and a person approved: Guardian redeems the decision
 *   (revocation, expiry and single use apply), then the request goes to
 *   Agentcard. DENY, expiry, a timeout, Guardian unreachable, a failed
 *   redemption or any error: nothing reaches Agentcard, and the model reads
 *   "Guardian blocked this purchase: …".
 * - If the carts change while the person decides, the request is refused.
 */
export function guardBuyTool<T extends AnyTool>(
  buy: T,
  options: GuardianOpencommerceOptions,
): T {
  const agentcard = options?.agentcard;
  if (
    !agentcard ||
    typeof agentcard.buy !== "function" ||
    typeof agentcard.conversation !== "function"
  ) {
    throw new TypeError(
      "Pass agentcard: the AgentcardClient the buy tool was built with.",
    );
  }
  const ttl = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    ttl > GUARDIAN_MAX_REQUEST_TTL_MS
  ) {
    throw new TypeError(
      `requestTtlMs must be a whole number from 1 to ${GUARDIAN_MAX_REQUEST_TTL_MS}.`,
    );
  }
  installGate(agentcard);
  return wrap(buy, options, { carts: [], conversationId: null, paid: false });
}

const ungoverned = () =>
  new GuardianPurchaseBlocked({
    code: "UNGOVERNED_CLIENT",
    detail:
      "Agentcard reports a purchase that did not go through Guardian. The buy tool was built on another Agentcard client than the one passed as agentcard; build it with buyTool({ agentcard }) and pass that same client.",
  });

/**
 * Fail closed when the tool's own client is not the gated one: a result
 * that says a confirm was sent while no paying request went through the
 * gate in this call, or an order placed while none ever did for this tool.
 */
function checkGoverned(table: Table, run: Run, result: unknown): void {
  // The gate refused a request in this call and nothing paid: the buy tool
  // answered Guardian's refusal in its own words (a Stripe Link confirm says
  // "not charged"), so the refusal itself is the answer, on every path.
  if (run.blocked && !run.paid) throw run.blocked;
  if (!isRecord(result) || run.paid) return;
  if (result.confirm_sent === true) throw ungoverned();
  const placed =
    (typeof result.order_id === "string" && result.order_id !== "") ||
    result.status === "placing" ||
    result.status === "order_placed";
  if (placed && !table.paid) throw ungoverned();
}

/** Runs `out`'s result (awaited when it is a promise) through checkGoverned. */
function governed<R>(table: Table, run: Run, out: R): R {
  if (out instanceof Promise) {
    return out.then((value: unknown) => {
      checkGoverned(table, run, value);
      return value;
    }) as R;
  }
  checkGoverned(table, run, out);
  return out;
}

const isTool = (value: unknown): value is AnyTool =>
  isRecord(value) && typeof value.answer === "function";

function wrap<T extends AnyTool>(
  buy: T,
  options: GuardianOpencommerceOptions,
  table: Table,
  defaultStep: CheckoutFacts["step"] = "confirm",
): T {
  const original = buy as unknown as Record<string, unknown> & BuyTool;
  const inScope = <R>(step: CheckoutFacts["step"], fn: () => R): R => {
    const run: Run = { paid: false };
    return governed(table, run, scope.run({ options, table, step, run }, fn));
  };
  const answerOf = original.answer.bind(original) as (
    input: BuyToolInput,
  ) => Promise<BuyToolResult>;

  const answer = async (input: BuyToolInput): Promise<BuyToolResult> => {
    const result = await inScope(defaultStep, () => answerOf(input));
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
      const result = await inScope("approve", () => approve(approveOptions));
      remember(table, result);
      return result;
    };
  }
  if (typeof original.turn === "function") {
    const turn = original.turn.bind(original);
    overrides.turn = (...args: Parameters<typeof turn>) =>
      wrap(
        inScope(defaultStep, () => turn(...args)),
        options,
        table,
      );
  }
  if (typeof original.nextStep === "function") {
    const nextStep = original.nextStep.bind(original);
    overrides.nextStep = (...args: Parameters<typeof nextStep>) => {
      const opened = inScope("next_step", () => nextStep(...args));
      return opened === null ? null : wrap(opened, options, table, "next_step");
    };
  }

  // Same fields, the non-enumerable ones too (definition, inputSchema,
  // openai, handled), so every framework reads the tool as before. Every
  // other method (handled, payWith, awaitWallet, walletOutcome, …) runs in
  // this tool's scope, so a request it sends that pays goes to Guardian.
  const governedTool = Object.create(Object.getPrototypeOf(original));
  const descriptors = Object.getOwnPropertyDescriptors(original);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key in overrides) continue;
    if (typeof descriptor.value === "function") {
      const fn = descriptor.value as (...a: unknown[]) => unknown;
      descriptor.value = (...a: unknown[]) => {
        const out = inScope(defaultStep, () => fn.apply(original, a));
        return isTool(out) ? wrap(out, options, table, defaultStep) : out;
      };
    }
    Object.defineProperty(governedTool, key, descriptor);
  }
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

type Shopper = { externalUserId?: string; userId?: string };

async function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The checkout a request pays, read from Agentcard's conversation as it
 * stands now (not from the last answer the wrapper saw): a `nextStep`
 * confirm carries the yes to the cart as it is now, at today's total.
 */
async function readCheckout(
  current: Scope,
  agentcard: GuardedAgentcard,
  body: Record<string, unknown>,
  step: CheckoutFacts["step"],
): Promise<CheckoutFacts> {
  const conversationId =
    typeof body.conversation_id === "string" && body.conversation_id
      ? body.conversation_id
      : current.table.conversationId;
  if (!conversationId) {
    return checkoutFacts([], null, step);
  }
  const who: Shopper | undefined =
    typeof body.external_user_id === "string"
      ? { externalUserId: body.external_user_id }
      : typeof body.user_id === "string"
        ? { userId: body.user_id }
        : undefined;
  const unreadable = (detail: string) =>
    new GuardianPurchaseBlocked({ code: "CART_UNREADABLE", detail });
  let carts: BuyCart[];
  try {
    const conversation = await withTimeout(
      () => agentcard.conversation(conversationId, who),
      current.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    );
    if (!isRecord(conversation) || !Array.isArray(conversation.carts)) {
      throw new Error("no carts");
    }
    carts = conversation.carts as BuyCart[];
  } catch {
    throw unreadable(
      "the cart this purchase would pay could not be read from Agentcard.",
    );
  }
  let confirms: CheckoutFacts["confirms"] = "every_cart";
  if (typeof body.confirm === "string") {
    const hash = body.confirm;
    carts = carts.filter((cart) => cart.hash === hash);
    if (carts.length === 0) {
      throw unreadable(
        "the cart this purchase names is no longer in the conversation. Show the shopper the cart again.",
      );
    }
    confirms = "one_cart";
  }
  const facts = checkoutFacts(carts, conversationId, step, confirms);
  // A Link payment names the amount it charges: the most it can charge counts.
  const link = body.link_payment;
  if (isRecord(link) && link.amount_cents !== undefined) {
    const cents = link.amount_cents;
    const currency = String(link.currency ?? "usd").toLowerCase();
    if (
      typeof cents !== "number" ||
      !Number.isSafeInteger(cents) ||
      cents < 0
    ) {
      throw new GuardianPurchaseBlocked({
        code: "AMOUNT_UNREADABLE",
        detail: "the amount of the Link payment could not be read.",
      });
    }
    if (currency !== "usd") {
      throw new GuardianPurchaseBlocked({
        code: "CURRENCY_UNSUPPORTED",
        detail: `the Link payment is in ${currency.toUpperCase()}, and Guardian's amount rules are in US dollars.`,
      });
    }
    if (cents > facts.amountMinor) return { ...facts, amountMinor: cents };
  }
  return facts;
}

/** Stable JSON of plain data, keys sorted, for comparing arguments. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new TypeError("too deep");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  }
  if (!isRecord(value)) throw new TypeError("not plain data");
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k], depth + 1)}`)
    .join(",")}}`;
}

function sameData(a: unknown, b: unknown): boolean {
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

/**
 * The portable signed record must show a person approved this exact
 * request, on this tool and connection, with these exact arguments. A
 * record for an earlier request (a replayed approval) or other terms is
 * refused, and so is one that does not verify against the given keys.
 */
async function checkApprovedRecord(
  options: GuardianOpencommerceOptions,
  requestId: string,
  toolName: string,
  facts: CheckoutFacts,
  refuse: (detail: string) => GuardianPurchaseBlocked,
): Promise<void> {
  const fail = (why: string) =>
    refuse(`the signed record of the approval does not match (${why}).`);
  let got: unknown;
  try {
    got = await withTimeout(
      () => options.client.portableReceipt(requestId),
      options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    );
  } catch {
    throw fail("no record");
  }
  if (!isRecord(got) || got.ok !== true) throw fail("no record");
  const receipt = got.receipt;
  if (options.receiptVerificationKeys !== undefined) {
    let valid = false;
    try {
      valid =
        verifyReceiptOffline(
          receipt as Parameters<typeof verifyReceiptOffline>[0],
          options.receiptVerificationKeys as Parameters<
            typeof verifyReceiptOffline
          >[1],
        ).valid === true;
    } catch {
      valid = false;
    }
    if (!valid) throw fail("record does not verify");
  }
  if (!isRecord(receipt)) throw fail("malformed record");
  const { subject, action, decision, approval } = receipt;
  if (!isRecord(subject) || subject.requestId !== requestId) {
    throw fail("other request");
  }
  if (!isRecord(action) || action.requestId !== requestId) {
    throw fail("other request");
  }
  if (action.action !== "tool.invoke") throw fail("action");
  const params = action.materialParameters;
  const args = JSON.parse(JSON.stringify(facts)) as unknown;
  if (
    !isRecord(params) ||
    params.toolName !== toolName ||
    params.connectionId !== options.connectionId ||
    !sameData(params.arguments, args)
  ) {
    throw fail("terms differ");
  }
  if (!isRecord(decision) || decision.decision !== "ASK") {
    throw fail("not an ASK");
  }
  if (
    !isRecord(approval) ||
    (approval.state !== "approved" && approval.state !== "consumed")
  ) {
    throw fail("not approved");
  }
}

/** True when an execute failure may hide a redemption. Same rule as the SDK's triad. */
function executeOutcomeUnknown(executed: {
  reasonCode?: unknown;
  outcomeUnknown?: unknown;
}): boolean {
  const code =
    typeof executed.reasonCode === "string" ? executed.reasonCode : "";
  return (
    executed.outcomeUnknown === true ||
    code === "SERVICE_UNAVAILABLE" ||
    /^HTTP_(0|5\d\d)$/.test(code)
  );
}

/**
 * After a lost or unconfirmed execute: Guardian's recorded attempts for the
 * request. Only a verified attempt or a definitive abort settles it. Same
 * rules as the SDK's triad.
 */
async function lookUpExecution(
  client: GuardianClient,
  requestId: string,
): Promise<"verified" | "not-sent" | "unknown"> {
  let answer: unknown;
  try {
    answer = await client.receipts(requestId);
  } catch {
    return "unknown";
  }
  if (
    !isRecord(answer) ||
    answer.ok !== true ||
    !Array.isArray(answer.receipts)
  ) {
    return "unknown";
  }
  const records = answer.receipts as readonly { state?: unknown }[];
  if (records.some((r) => r?.state === "verified")) return "verified";
  if (
    records.length > 0 &&
    records.every(
      (r) => r?.state === "aborted" || r?.state === "commit-rejected",
    )
  ) {
    return "not-sent";
  }
  return "unknown";
}

/**
 * Request → (ASK: claim until a person decides, within the request's TTL) →
 * the carts read again → execute (redeem) → the request to Agentcard. Nothing
 * reaches Agentcard before Guardian redeemed the decision.
 */
async function checkout(
  current: Scope,
  agentcard: GuardedAgentcard,
  body: Record<string, unknown>,
  send: () => Promise<unknown>,
): Promise<unknown> {
  const { options } = current;
  const step: CheckoutFacts["step"] =
    body.carried !== undefined ? "next_step" : current.step;
  const facts = await readCheckout(current, agentcard, body, step);
  const toolName = options.toolName ?? DEFAULT_CHECKOUT_TOOL;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const ttlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
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
    extra: {
      requestId?: string;
      reasonCode?: string;
      outcomeUnknown?: boolean;
    } = {},
  ) => new GuardianPurchaseBlocked({ code, detail, checkout: facts, ...extra });
  const unreachable = (detail: string, reasonCode?: string) => {
    notify({ decision: "ERROR", ...(reasonCode ? { reasonCode } : {}) });
    return block(
      "GUARDIAN_UNREACHABLE",
      detail,
      reasonCode ? { reasonCode } : {},
    );
  };
  const guardian = async <R>(fn: () => Promise<R>): Promise<R> => {
    try {
      return await withTimeout(fn, callTimeoutMs);
    } catch {
      throw unreachable(
        "Guardian could not be reached or did not answer in time, so the purchase did not go ahead.",
      );
    }
  };

  const invocation = {
    action: "tool.invoke",
    connectionId: options.connectionId,
    toolName,
    arguments: facts,
    amountArgument: CHECKOUT_AMOUNT_DECLARATION,
    valueCents: facts.amountMinor,
    purpose: purposeOf(facts),
    ttlMs,
    ...(options.adapterId ? { adapterId: options.adapterId } : {}),
  } as unknown as GuardianInvocation;
  const requested = await guardian(() => options.client.request(invocation));
  const startedAt = now();
  if (!isRecord(requested) || typeof requested.ok !== "boolean") {
    throw unreachable("Guardian's answer could not be read.");
  }
  const decided = classifyRequestResult(
    requested as Parameters<typeof classifyRequestResult>[0],
  );
  let requestId: string;
  let capabilityToken: string;
  let viaAsk = false;
  if (decided.decision === "ALLOW") {
    requestId = decided.requestId;
    capabilityToken = decided.capabilityToken;
  } else if (decided.decision === "DENY") {
    if (decided.reasonCode === "SERVICE_UNAVAILABLE") {
      throw unreachable(
        "Guardian could not be reached, so the purchase did not go ahead.",
        decided.reasonCode,
      );
    }
    notify({
      decision: "DENY",
      reasonCode: decided.reasonCode,
      ...(decided.requestId ? { requestId: decided.requestId } : {}),
    });
    throw block(
      "GUARDIAN_DENIED",
      `the owner's rules do not allow it (${decided.reasonCode}).`,
      {
        reasonCode: decided.reasonCode,
        ...(decided.requestId ? { requestId: decided.requestId } : {}),
      },
    );
  } else {
    // ASK: wait for a person, within the request's TTL.
    viaAsk = true;
    requestId = decided.requestId;
    notify({ decision: "ASK", requestId });
    const deadline = startedAt + ttlMs;
    let token: string | undefined;
    for (;;) {
      if (now() >= deadline) {
        notify({ decision: "TIMEOUT", requestId });
        try {
          await options.client.withdraw?.(requestId);
        } catch {
          // best effort: the request ends with its TTL anyway
        }
        throw block(
          "APPROVAL_TIMEOUT",
          `no person approved it within ${Math.round(ttlMs / 1000)} seconds, so the request expired.`,
          { requestId },
        );
      }
      await sleep(Math.max(1, Math.min(pollMs, deadline - now())));
      let claimed: unknown;
      try {
        claimed = await withTimeout(
          () => options.client.claim(requestId),
          callTimeoutMs,
        );
      } catch {
        continue; // transient; the deadline still holds
      }
      if (!isRecord(claimed) || typeof claimed.ok !== "boolean") {
        throw unreachable("Guardian's answer could not be read.");
      }
      if (claimed.ok === true && claimed.requestId !== requestId) {
        throw unreachable("Guardian answered for a different request.");
      }
      const code =
        typeof claimed.reasonCode === "string" ? claimed.reasonCode : "DENIED";
      if (claimed.ok === true && claimed.decision === "ALLOW") {
        if (
          typeof claimed.capabilityToken !== "string" ||
          !claimed.capabilityToken
        ) {
          notify({
            decision: "DENY",
            requestId,
            reasonCode: "CAPABILITY_MISSING",
          });
          throw block("GUARDIAN_DENIED", "Guardian issued no capability.", {
            requestId,
            reasonCode: "CAPABILITY_MISSING",
          });
        }
        token = claimed.capabilityToken;
        break;
      }
      if (claimed.ok === true && claimed.decision === "ASK") continue;
      if (claimed.ok === false && stillHeld(code)) continue;
      if (expired(code)) {
        notify({ decision: "EXPIRED", requestId, reasonCode: code });
        throw block(
          "APPROVAL_EXPIRED",
          `the approval request expired before anyone decided (${code}).`,
          { requestId, reasonCode: code },
        );
      }
      notify({ decision: "DENY", requestId, reasonCode: code });
      throw block("APPROVAL_DECLINED", `the person declined it (${code}).`, {
        requestId,
        reasonCode: code,
      });
    }
    capabilityToken = token;
  }

  // The carts must still be the ones Guardian decided on.
  const again = await readCheckout(current, agentcard, body, step);
  if (JSON.stringify(again) !== JSON.stringify(facts)) {
    throw block(
      "CART_CHANGED",
      "the cart changed after Guardian decided. Show the shopper the new cart and confirm again.",
      { requestId },
    );
  }

  // After a person approved: the portable signed record must name this
  // request, tool, connection and exactly these arguments.
  if (viaAsk) {
    await checkApprovedRecord(options, requestId, toolName, facts, (detail) =>
      block("RECORD_MISMATCH", detail, { requestId }),
    );
  }

  // Redeem before the purchase: revocation, expiry and single use apply
  // before anything reaches Agentcard.
  let executed: unknown;
  let lost = false;
  try {
    executed = await withTimeout(
      () => options.client.execute({ requestId, capabilityToken }),
      callTimeoutMs,
    );
  } catch {
    lost = true;
  }
  const ex = isRecord(executed) ? executed : {};
  const receipt = isRecord(ex.receipt) ? ex.receipt : undefined;
  const verified =
    !lost &&
    ex.ok === true &&
    receipt?.status === "sent-verified" &&
    receipt.requestId === requestId;
  if (!verified) {
    const reasonCode =
      typeof ex.reasonCode === "string" ? ex.reasonCode : "EXECUTE_FAILED";
    const definitive =
      !lost &&
      ((ex.ok === false && !executeOutcomeUnknown(ex)) ||
        (ex.ok === true && receipt?.status === "not-sent"));
    const found = definitive
      ? "not-sent"
      : await lookUpExecution(options.client, requestId);
    if (found !== "verified") {
      const unknown = found === "unknown";
      notify({ decision: "ERROR", requestId, reasonCode });
      throw block(
        "EXECUTE_FAILED",
        unknown
          ? `Guardian may have redeemed this decision, but did not confirm it; nothing was sent to Agentcard. Look up request ${requestId} before retrying; a retry needs a new decision.`
          : `Guardian did not redeem the decision (${reasonCode}).`,
        { requestId, reasonCode, outcomeUnknown: unknown },
      );
    }
  }
  notify(
    viaAsk
      ? { decision: "APPROVED", requestId }
      : { decision: "ALLOW", requestId },
  );
  return send();
}
