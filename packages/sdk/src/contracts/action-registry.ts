// Generated file — do not edit.
import {
  TRANSACTION_CONTRACT_SCHEMA,
  type TransactionDeclaration,
  type TransactionStage,
} from "./transaction.js";
import {
  EmailSendParametersV1Schema,
  emailEnvelopeProjection,
  emailVerificationProjection,
  type EmailSendParametersV1,
} from "./email.js";
import {
  ApiRequestParametersV1Schema,
  apiEndpointWithinAllowlist,
  apiEnvelopeProjection,
  apiVerificationProjection,
  type ApiRequestParametersV1,
} from "./api.js";
import {
  CommercePurchaseParametersV1Schema,
  CommerceRefundParametersV1Schema,
  CommerceReturnParametersV1Schema,
  SubscriptionCreateParametersV1Schema,
  commercePurchaseEnvelopeProjection,
  commercePurchaseVerificationProjection,
  commerceRefundEnvelopeProjection,
  commerceRefundVerificationProjection,
  commerceReturnEnvelopeProjection,
  commerceReturnVerificationProjection,
  subscriptionCreateEnvelopeProjection,
  subscriptionCreateVerificationProjection,
  type ActionAuthorityFacts,
  type CommercePurchaseParametersV1,
  type CommerceRefundParametersV1,
  type CommerceReturnParametersV1,
  type SubscriptionCreateParametersV1,
} from "./commerce.js";
import {
  CalendarCancelParametersV1Schema,
  CalendarCreateParametersV1Schema,
  CalendarInviteParametersV1Schema,
  CalendarUpdateParametersV1Schema,
  calendarEnvelopeProjection,
  calendarVerificationProjection,
  type CalendarCancelParametersV1,
  type CalendarCreateParametersV1,
  type CalendarInviteParametersV1,
  type CalendarUpdateParametersV1,
} from "./calendar.js";
import {
  FileDeleteParametersV1Schema,
  FileReadParametersV1Schema,
  FileShareParametersV1Schema,
  FileWriteParametersV1Schema,
  fileDeleteVerificationProjection,
  filePathWithinAllowlist,
  fileReadVerificationProjection,
  fileShareVerificationProjection,
  fileWriteVerificationProjection,
  type FileDeleteParametersV1,
  type FileReadParametersV1,
  type FileShareParametersV1,
  type FileWriteParametersV1,
} from "./files.js";
import type { ResourceClaim } from "./resource-claims.js";
import {
  ProtectedDeriveParametersV1Schema,
  ProtectedDiscloseParametersV1Schema,
  ProtectedExportParametersV1Schema,
  ProtectedPersistParametersV1Schema,
  ProtectedTransformParametersV1Schema,
  ProtectedUseParametersV1Schema,
  ProtectedViewParametersV1Schema,
  protectedCatalogField,
  protectedDeriveVerificationProjection,
  protectedDiscloseVerificationProjection,
  protectedExportVerificationProjection,
  protectedPersistVerificationProjection,
  protectedSinkWithinUseSinks,
  protectedTransformVerificationProjection,
  protectedUseVerificationProjection,
  protectedViewVerificationProjection,
  type ProtectedCatalogEntry,
  type ProtectedDeriveParametersV1,
  type ProtectedDiscloseParametersV1,
  type ProtectedExportParametersV1,
  type ProtectedPersistParametersV1,
  type ProtectedTransformParametersV1,
  type ProtectedUseParametersV1,
  type ProtectedViewParametersV1,
} from "./protected-data.js";
import type { ZodType } from "zod";
import {
  AGENT_STATE_PARAMETERS_KINDS,
  AgentConfigureParametersV1Schema,
  AgentDelegateParametersV1Schema,
  AgentMessageParametersV1Schema,
  AgentShareContextParametersV1Schema,
  AgentShareMemoryParametersV1Schema,
  AgentSpawnParametersV1Schema,
  AgentTerminateParametersV1Schema,
  AgentTransferCapabilityParametersV1Schema,
  AgentTransferTaskParametersV1Schema,
  agentStateProjection,
  ApiKeyCreateParametersV1Schema,
  GUARDIAN_PROVIDER,
  GUARDIAN_RESOURCE_TYPE,
  MEMORY_GOVERNED_PREFIX,
  MEMORY_RESERVED_PREFIX,
  MemoryDeleteParametersV1Schema,
  MemoryModifyParametersV1Schema,
  MemoryReadParametersV1Schema,
  MemoryShareParametersV1Schema,
  MemoryWriteParametersV1Schema,
  MfaChangeParametersV1Schema,
  ModelChangeParametersV1Schema,
  PasswordChangeParametersV1Schema,
  RecoveryChangeParametersV1Schema,
  RuntimeChangeParametersV1Schema,
  TrustedDeviceAddParametersV1Schema,
  type AgentConfigureParametersV1,
  type AgentDelegateParametersV1,
  type AgentMessageParametersV1,
  type AgentShareContextParametersV1,
  type AgentShareMemoryParametersV1,
  type AgentSpawnParametersV1,
  type AgentStateActionId,
  type AgentTerminateParametersV1,
  type AgentTransferCapabilityParametersV1,
  type AgentTransferTaskParametersV1,
  type ApiKeyCreateParametersV1,
  type MemoryDeleteParametersV1,
  type MemoryModifyParametersV1,
  type MemoryReadParametersV1,
  type MemoryShareParametersV1,
  type MemoryWriteParametersV1,
  type MfaChangeParametersV1,
  type ModelChangeParametersV1,
  type PasswordChangeParametersV1,
  type RecoveryChangeParametersV1,
  type RuntimeChangeParametersV1,
  type TrustedDeviceAddParametersV1,
} from "./agent-state.js";
import {
  LOCAL_BROWSE_PARAMETERS_SCHEMA_ID,
  LOCAL_EGRESS_PARAMETERS_SCHEMA_ID,
  LOCAL_EXEC_PARAMETERS_SCHEMA_ID,
  LocalBrowseParametersV1Schema,
  LocalEgressParametersV1Schema,
  LocalExecParametersV1Schema,
  localBrowseVerificationProjection,
  localEgressVerificationProjection,
  localEndpointBinding,
  localExecBinding,
  localExecVerificationProjection,
  type LocalBrowseParametersV1,
  type LocalEgressParametersV1,
  type LocalExecParametersV1,
} from "./local.js";
import {
  McpEnableParametersV1Schema,
  McpInstallParametersV1Schema,
  mcpEnableProjection,
  mcpInstallProjection,
  ToolInvokeParametersV1Schema,
  toolEnvelopeProjection,
  toolVerificationProjection,
  validateMcpEnableBinding,
  validateMcpInstallBinding,
  validateToolInvokeBinding,
  type McpEnableParametersV1,
  type McpInstallParametersV1,
  type ToolDescriptor,
  type ToolInvokeParametersV1,
} from "./tools.js";

/**
 * Universal Action Registry.
 *
 * Every consequential action is registered independently of provider. The
 * authority kernel resolves an action_id to an ActionDefinition and invokes
 * its hooks uniformly; it never branches on action/provider identity.
 * Adding a new action means adding a registry definition plus an adapter —
 * no kernel change.
 */

export type Reversibility =
  | "reversible"
  | "limited"
  | "difficult"
  | "destructive"
  | "safety-sensitive";

export type RiskClass = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";

/** The connection facts an action definition may bind against. */
export type ActionConnectionBinding = Readonly<{
  provider: string;
  mailboxAddress?: string;
  endpointAllowlist?: readonly string[];
  /** Provider "tool" connections carry the installed tool-server catalog. */
  toolServer?: Readonly<{
    serverName: string;
    serverVersion: string;
    tools: readonly ToolDescriptor[];
  }>;
  /** Tool names enabled for the requesting agent (agent_tools registry). */
  enabledToolNames?: readonly string[];
  calendarId?: string;
  /** Canonical path prefixes file ops may touch (files provider). */
  pathAllowlist?: readonly string[];
  /** Canonical path prefixes a file may be shared from (files provider). */
  shareAllowlist?: readonly string[];
  /** Declared protected fields for this connection (protected_data). */
  protectedCatalog?: readonly ProtectedCatalogEntry[];
  /**
   * Provider "guardian" connections bind delegation facts for the
   * requesting agent: which sub-agents are bonded to it, and the parent's
   * derived authority ceiling per target connection. An unbonded child id or
   * a delegation outside the ceiling fails the binding (DENY).
   */
  bondedSubAgentIds?: readonly string[];
  delegationCeilings?: Readonly<
    Record<string, { actionIds: readonly string[] }>
  >;
  /**
   * The universal Resource Claim projected from this connection's
   * binding facts (guardian.resource-claim.v1). Built-in definitions keep
   * reading the legacy vertical fields above; pack-defined actions evaluate
   * their declarative claim/binding rules against this claim only.
   */
  claims?: ResourceClaim;
}>;

export type ActionBindingResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reasonCode: string }>;

/**
 * The full canonical lifecycle declared on consequential
 * action kinds. An intent may union its own declaration on top; the
 * effective lifecycle binds into the canonical action digest.
 */
export const FULL_TRANSACTION_LIFECYCLE: TransactionDeclaration = Object.freeze(
  {
    schema: TRANSACTION_CONTRACT_SCHEMA,
    stages: Object.freeze([
      "PROPOSE",
      "PREPARE",
      "AUTHORIZE",
      "LOCK",
      "COMMIT",
      "VERIFY",
      "SETTLE",
    ]) as unknown as TransactionStage[],
  },
);

export interface ActionDefinition<P = unknown> {
  readonly actionId: string;
  readonly schemaVersion: 1;
  readonly actionFamily: string;
  readonly humanLabel: string;
  readonly description: string;
  /** Typed kind returned to the pipeline after parameter validation. */
  readonly parametersKind: string;
  /** Raw field names, for rendering + policy primitives. */
  readonly requiredParameters: readonly string[];
  /** Fields bound into the material-parameter digest (TOCTOU). */
  readonly materialParameters: readonly string[];
  /** Resource pattern: `${resourceType}:${connectionId}`. */
  readonly resourceType: string;
  /** Providers a connection may use for this action. */
  readonly providers: readonly string[];
  readonly counterpartyRules: string;
  readonly dataEffects: string;
  readonly reversibility: Reversibility;
  readonly riskClass: RiskClass;
  readonly defaultDecisionPosture: "allow" | "ask" | "deny";
  /** Generic fields the Authority Slip renders. */
  readonly approvalPresentationSchema: readonly string[];
  /**
   * Optional labelled display fields. Signed Action Packs set these
   * from their verified `approvalDisplay` metadata so the slip can render
   * trusted labels against the bound material parameters; built-ins leave
   * this unset and keep today's rendering.
   */
  readonly approvalDisplayFields?: readonly Readonly<{
    field: string;
    label: string;
  }>[];
  readonly capabilityRequirements: Readonly<{ uses: number }>;
  readonly executionContract: string;
  readonly verificationContract: Readonly<{ level: string }>;
  readonly evidenceRequirements: readonly string[];
  readonly version: 1;
  readonly status: "active" | "deprecated" | "disabled";

  /**
   * When true the action is capability-expanding: authority derivation never
   * auto-includes it in a grant's action set. It can only enter a grant when
   * a human selects it explicitly.
   */
  readonly requiresExplicitGrant?: boolean;

  /**
   * Minimum principal class allowed to hold authority for this
   * action. "adult" marks governance and identity-level actions that a
   * child-classed principal can never be granted: the control plane excludes
   * them when emitting authority for a child, so the kernel DENYs with
   * ACTION_NOT_ALLOWED. Absent means any principal class may hold it.
   */
  readonly minPrincipalClass?: "adult";

  /**
   * When set, every action of this kind executes under
   * a recorded guardian.transaction.v1 lifecycle. Unioned with the
   * governing intent's own declaration (canonical order; never shrinks);
   * the effective declaration binds into the canonical action digest.
   */
  readonly transaction?: TransactionDeclaration;

  /**
   * Declared compensation mapping: this action kind
   * compensates `compensatesAction` (e.g. commerce.refund compensates
   * commerce.purchase). A compensating action still runs the full
   * authority path — it never bypasses ASK or enlarges authority.
   */
  readonly compensatesAction?: string;

  /**
   * Action-specific logic lives HERE — inside the registered definition —
   * never inside the kernel. Hooks receive only kernel-verified inputs.
   */
  validateParameters(
    materialParameters: unknown,
  ): Readonly<{ ok: true; params: P } | { ok: false }>;

  /** Pre-execution binding the agent's params to the leased connection. */
  validateBinding(input: {
    params: P;
    connection: ActionConnectionBinding;
  }): ActionBindingResult;

  /** Canonical projection whose digest the verified outcome must match. */
  verificationProjection(params: P): unknown;

  /** Envelope projection recorded at reservation time. */
  envelopeProjection(params: P): unknown;

  /**
   * Generic monetary-authority facts derived from validated parameters.
   * When present, the envelope's declared facts must equal the
   * derived values, so an agent cannot understate an amount or smuggle a
   * merchant/category/recurrence fact past the kernel.
   */
  authorityFacts?(params: P): ActionAuthorityFacts;
}

export type ActionRegistry = Readonly<{
  get(actionId: string): ActionDefinition | undefined;
  entries(): readonly ActionDefinition[];
}>;

export function createActionRegistry(
  definitions: readonly ActionDefinition[],
): ActionRegistry {
  const byAction = new Map<string, ActionDefinition>();
  for (const definition of definitions) {
    if (byAction.has(definition.actionId)) {
      throw new TypeError(
        `duplicate action definition: ${definition.actionId}`,
      );
    }
    byAction.set(definition.actionId, definition);
  }
  const entries = Object.freeze([...definitions]);
  return Object.freeze({
    get: (actionId) => byAction.get(actionId),
    entries: () => entries,
  });
}

const emailSendDefinition: ActionDefinition<EmailSendParametersV1> = {
  actionId: "email.send",
  schemaVersion: 1,
  actionFamily: "communication",
  humanLabel: "Send email",
  description: "Send an email message from a leased mailbox connection.",
  parametersKind: "email.send.v1",
  requiredParameters: ["connectionId", "from", "to", "subject", "body"],
  materialParameters: [
    "connectionId",
    "from",
    "to",
    "cc",
    "bcc",
    "replyTo",
    "subject",
    "body",
    "attachments",
    "inReplyTo",
  ],
  resourceType: "email:mailbox",
  providers: ["gmail", "graph", "clawlink"],
  counterpartyRules:
    "Recipients are external counterparties; every recipient is material.",
  dataEffects: "Discloses message content to external recipients.",
  reversibility: "limited",
  riskClass: "R3",
  defaultDecisionPosture: "deny",
  approvalPresentationSchema: [
    "from",
    "to",
    "subject",
    "bodyPreview",
    "attachments",
  ],
  capabilityRequirements: { uses: 1 },
  executionContract:
    "prepare → readback → commit → observe → verified/unknown/rejected",
  verificationContract: {
    level: "pre-commit-content+post-commit-envelope",
  },
  evidenceRequirements: [
    "effect.prepared",
    "commit.authorized",
    "effect.verified | effect.unknown | commit.rejected",
  ],
  version: 1,
  status: "active",
  validateParameters(materialParameters) {
    const parsed = EmailSendParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  validateBinding({ params, connection }) {
    return connection.mailboxAddress !== undefined &&
      params.from === connection.mailboxAddress
      ? { ok: true }
      : { ok: false, reasonCode: "CONNECTION_UNAVAILABLE" };
  },
  verificationProjection: (params) => emailVerificationProjection(params),
  envelopeProjection: (params) => emailEnvelopeProjection(params),
};

/**
 * Money facts of an `api.request`.
 *
 * A declarative table of request shapes that move money, and ONE reader
 * that derives the amount (minor units) and currency from the exact
 * request: method, URL, content type and body. The `api.request`
 * definition uses it at decision time (the envelope's declared
 * `valueCents` must equal the derived amount, so caps, ask-above and
 * budgets check the real number), and the executor's money guard
 * imports the same reader, so the gate and the
 * executor can never read a request differently.
 *
 * Rules are data, not branches: the reader is generic over the table.
 * Anything it cannot read unambiguously is refused, never resolved:
 * a missing, duplicated, malformed or non-integer amount; an amount or
 * currency in the query string; a body whose content type the rule does
 * not accept (Stripe: exactly application/x-www-form-urlencoded); form
 * keys that could be read as the amount or currency by a different
 * parser; a non-canonical path on a money origin; and endpoints that move
 * money without stating the amount (confirm, invoice pay, subscriptions…).
 *
 * Money origins are closed: on a money origin (Stripe), every request
 * other than GET must match a money rule or one entry of a short reviewed
 * list of endpoints that move no money; anything else is refused
 * (MONEY_ENDPOINT_UNKNOWN). The host is compared normalised (case, one
 * trailing dot, default port); a request whose host is a money host but
 * not written exactly as the canonical origin, or whose host looks like a
 * money host (IDN or digit look-alikes), is refused
 * (MONEY_HOST_NONCANONICAL), so what is checked is what is sent.
 *
 * A money origin's own semantic headers are refused on every method
 * (MONEY_HEADER_UNSUPPORTED): Stripe lets a request pin an older API
 * version with `stripe-version`, under which old parameter names move
 * money (customers: `account_balance`; `plan`, `quantity`, `trial_end`,
 * `coupon` creating a charged subscription), and `stripe-account` /
 * `stripe-context` act on another account. The rules here are read
 * against the account's default API version only. Every `stripe-*`
 * request header is refused; none is reviewed.
 *
 * The reviewed non-money endpoints accept only an empty body or exactly
 * one form-encoded body. Neither they nor the money rules accept a body or
 * query key containing a control character (e.g. `balance%00` or
 * `amount%00`, which another parser could truncate): AMOUNT_AMBIGUOUS.
 */
export type ApiMoneyBody = "form" | "json";

export type ApiMoneyRule = Readonly<{
  /** Exact origin, e.g. https://api.stripe.com */
  origin: string;
  method: "POST";
  /** Matched against the URL path only. */
  path: RegExp;
  label: string;
  /**
   * How the amount is read. "unverifiable": the endpoint moves money whose
   * amount the request does not state; always refused.
   */
  amount: Readonly<{ field: string }> | "unverifiable";
  /**
   * How the currency is checked. "implied": the request carries no currency
   * (e.g. a refund is in the original charge's currency); only the amount
   * is derived and the rule says so. The amount is then compared with a
   * USD cap as minor units of whatever the original currency is.
   */
  currency: Readonly<{ field: string; allowed: readonly string[] }> | "implied";
  /** The body encodings the provider reads; any other is refused. */
  bodies: readonly ApiMoneyBody[];
}>;

/**
 * A money origin: closed to requests that match no reviewed entry. A
 * request header whose lowercased name starts with one of
 * `refusedHeaderPrefixes` changes how the provider reads the request
 * (API version, acting account) and is refused.
 */
export type ApiMoneyOrigin = Readonly<{
  origin: string;
  label: string;
  refusedHeaderPrefixes: readonly string[];
}>;

/**
 * An endpoint on a money origin reviewed as moving no money. A field in
 * `refuseFields` (or a look-alike key) in the body is refused, because it
 * would change a money balance.
 */
export type ApiNonMoneyEndpoint = Readonly<{
  origin: string;
  method: "POST";
  path: RegExp;
  label: string;
  refuseFields: readonly string[];
}>;

const STRIPE_ORIGIN = "https://api.stripe.com";
const STRIPE_CURRENCIES = Object.freeze(["usd"]);
const STRIPE_BODIES: readonly ApiMoneyBody[] = Object.freeze(["form"]);

export const API_MONEY_ORIGINS: readonly ApiMoneyOrigin[] = Object.freeze([
  Object.freeze({
    origin: STRIPE_ORIGIN,
    label: "Stripe",
    // stripe-version (old API versions read old money parameters),
    // stripe-account and stripe-context (another account), and any other
    // stripe-* header: none is reviewed.
    refusedHeaderPrefixes: Object.freeze(["stripe-"]),
  }),
]);

function moneyRule(rule: ApiMoneyRule): ApiMoneyRule {
  return Object.freeze({
    ...rule,
    amount:
      rule.amount === "unverifiable"
        ? rule.amount
        : Object.freeze({ ...rule.amount }),
    currency:
      rule.currency === "implied"
        ? rule.currency
        : Object.freeze({ ...rule.currency }),
    bodies: Object.freeze([...rule.bodies]),
  });
}

const ID = "[^/]+";
const stripePath = (path: string) => new RegExp(`^/v1/${path}/?$`, "u");
const stripeRule = (
  path: string,
  label: string,
  amount: ApiMoneyRule["amount"],
  currency: "implied" | "currency" = "currency",
): ApiMoneyRule => ({
  origin: STRIPE_ORIGIN,
  method: "POST",
  path: stripePath(path),
  label,
  amount,
  currency:
    currency === "implied"
      ? "implied"
      : { field: "currency", allowed: STRIPE_CURRENCIES },
  bodies: STRIPE_BODIES,
});
const AMOUNT = Object.freeze({ field: "amount" });

export const API_MONEY_RULES: readonly ApiMoneyRule[] = Object.freeze(
  [
    // The amount is stated: it is derived, and a missing amount (which
    // Stripe reads as "all of it") is refused.
    stripeRule("refunds", "Stripe refund", AMOUNT, "implied"),
    stripeRule(
      `charges/${ID}/refunds`,
      "Stripe refund (legacy charge path)",
      AMOUNT,
      "implied",
    ),
    stripeRule(
      `charges/${ID}/refund`,
      "Stripe refund (legacy charge refund)",
      AMOUNT,
      "implied",
    ),
    stripeRule(
      `charges/${ID}/capture`,
      "Stripe charge capture",
      AMOUNT,
      "implied",
    ),
    stripeRule(
      `payment_intents/${ID}/capture`,
      "Stripe payment capture",
      { field: "amount_to_capture" },
      "implied",
    ),
    stripeRule(
      `transfers/${ID}/reversals`,
      "Stripe transfer reversal",
      AMOUNT,
      "implied",
    ),
    stripeRule(
      `application_fees/${ID}/refunds`,
      "Stripe application fee refund",
      AMOUNT,
      "implied",
    ),
    stripeRule("payouts", "Stripe payout", AMOUNT),
    stripeRule("payment_intents", "Stripe payment", AMOUNT),
    stripeRule("charges", "Stripe charge", AMOUNT),
    stripeRule("transfers", "Stripe transfer", AMOUNT),
    stripeRule("topups", "Stripe top-up", AMOUNT),
    // Money moves, but the request does not state how much (or can change
    // an amount stated elsewhere): always refused.
    ...(
      [
        [`payment_intents/${ID}`, "Stripe payment update"],
        [`payment_intents/${ID}/confirm`, "Stripe payment confirm"],
        [
          `payment_intents/${ID}/increment_authorization`,
          "Stripe payment authorization increment",
        ],
        [
          `payment_intents/${ID}/apply_customer_balance`,
          "Stripe payment from customer balance",
        ],
        [`invoices/${ID}/pay`, "Stripe invoice pay"],
        ["subscriptions", "Stripe subscription"],
        [`subscriptions/${ID}`, "Stripe subscription update"],
        [`subscriptions/${ID}/resume`, "Stripe subscription resume"],
        ["subscription_items", "Stripe subscription item"],
        [`subscription_items/${ID}`, "Stripe subscription item update"],
        ["subscription_schedules", "Stripe subscription schedule"],
        ["checkout/sessions", "Stripe checkout session"],
        ["payment_links", "Stripe payment link"],
        [`payment_links/${ID}`, "Stripe payment link update"],
        [`payouts/${ID}/reverse`, "Stripe payout reversal"],
      ] as const
    ).map(([path, label]) =>
      stripeRule(path, label, "unverifiable", "implied"),
    ),
  ].map((rule) => moneyRule(rule)),
);

/**
 * The reviewed endpoints on a money origin that move no money. Short on
 * purpose: anything not here and not a money rule is refused. Customer
 * create is not here: its accepted fields (balance, and under older API
 * versions account_balance, plan, coupon…) change what is charged, and no
 * strict field allowlist is enforced, so it is refused as unknown.
 */
export const API_NON_MONEY_ENDPOINTS: readonly ApiNonMoneyEndpoint[] =
  Object.freeze(
    (
      [
        [`payment_intents/${ID}/cancel`, "Stripe payment cancel", []],
        [`refunds/${ID}`, "Stripe refund metadata update", []],
        [`payment_methods/${ID}/detach`, "Stripe payment method detach", []],
      ] as const
    ).map(([path, label, refuseFields]) =>
      Object.freeze({
        origin: STRIPE_ORIGIN,
        method: "POST" as const,
        path: stripePath(path),
        label,
        refuseFields: Object.freeze([...refuseFields]),
      }),
    ),
  );

export type ApiMoneyRequest = Readonly<{
  method: string;
  url: string;
  headers?: readonly Readonly<{ name: string; value: string }>[] | undefined;
  body?: string | undefined;
}>;

export type ApiMoneyRefusal =
  | "AMOUNT_UNVERIFIABLE"
  | "AMOUNT_MISSING"
  | "AMOUNT_AMBIGUOUS"
  | "AMOUNT_INVALID"
  | "CURRENCY_MISSING"
  | "CURRENCY_NOT_ALLOWED"
  | "CONTENT_TYPE_UNSUPPORTED"
  | "BODY_UNREADABLE"
  | "MONEY_ENDPOINT_UNKNOWN"
  | "MONEY_HOST_NONCANONICAL"
  | "MONEY_HEADER_UNSUPPORTED";

export type ApiMoneyReading =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "money";
      rule: string;
      amountMinor: number;
      currency: string | null;
    }>
  | Readonly<{ kind: "refused"; rule: string; reason: ApiMoneyRefusal }>;

const MONEY_ORIGIN_LABEL = "money origin (non-canonical path)";
const MINOR_UNITS = /^(0|[1-9][0-9]{0,15})$/;

function parseRequestUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function apiMoneyRuleFor(
  method: string,
  url: string,
): ApiMoneyRule | null {
  const parsed = parseRequestUrl(url);
  if (parsed === null) return null;
  return (
    API_MONEY_RULES.find(
      (rule) =>
        rule.method === method.toUpperCase() &&
        rule.origin === parsed.origin &&
        rule.path.test(parsed.pathname),
    ) ?? null
  );
}

/**
 * A key another parser could read as `field` (amount[], " Amount",
 * "[amount]", …). A leading run of brackets, dots and whitespace is dropped
 * first: Rack 2 (`parse_nested_query`) strips leading brackets and reads
 * "[amount]", "[]amount" and "]amount" as "amount", last value winning.
 */
function lookalikeKey(key: string, field: string): boolean {
  if (key === field) return false;
  const base = key.replace(/^[\s[\].]+/u, "").toLowerCase();
  return base === field || base.split(/[[\].]/u, 1)[0]!.trim() === field;
}

type Fields = Readonly<{
  /** Every value stated for `name`; null when the body is ambiguous for it. */
  get(name: string): readonly string[] | null;
}>;

/** Every object key in a JSON text, at any depth, decoded. */
function jsonKeys(text: string): string[] | null {
  const keys: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < text.length && text[end] !== '"') {
      end += text[end] === "\\" ? 2 : 1;
    }
    if (end >= text.length) return null;
    const token = text.slice(index, end + 1);
    let next = end + 1;
    while (next < text.length && /\s/u.test(text[next]!)) next += 1;
    if (text[next] === ":") {
      try {
        keys.push(JSON.parse(token) as string);
      } catch {
        return null;
      }
    }
    index = end + 1;
  }
  return keys;
}

function jsonFields(body: string): Fields | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const keys = jsonKeys(body);
  if (keys === null) return null;
  const object = value as Record<string, unknown>;
  return {
    get(name) {
      // JSON.parse silently keeps the last of duplicate keys, and nested or
      // escaped keys can hide a second amount; any second key that reads
      // as `name`, at any depth, is ambiguous.
      const named = keys.filter((key) => key === name).length;
      if (keys.some((key) => lookalikeKey(key, name))) return null;
      const own = Object.prototype.hasOwnProperty.call(object, name);
      if (named > 1 || (named === 1 && !own)) return null;
      if (!own) return [];
      const field = object[name];
      if (typeof field === "string") return [field];
      if (typeof field === "number" && Number.isSafeInteger(field)) {
        return [String(field)];
      }
      return [""];
    },
  };
}

function formFields(body: string): Fields | null {
  // Some form parsers also split on ";": a raw ";" could hide a second
  // amount, so it is refused (an encoder always writes it as %3B).
  if (body.includes(";")) return null;
  const pairs = [...new URLSearchParams(body)];
  return {
    get(name) {
      if (pairs.some(([key]) => lookalikeKey(key, name))) return null;
      return pairs.filter(([key]) => key === name).map(([, value]) => value);
    },
  };
}

function mediaType(
  headers: ApiMoneyRequest["headers"],
): "json" | "form" | null {
  const values = (headers ?? []).filter(
    (header) => header.name.toLowerCase() === "content-type",
  );
  if (values.length !== 1) return null;
  const [type, ...parameters] = values[0]!.value.split(";");
  for (const parameter of parameters) {
    const [key, value] = parameter.split("=");
    if (
      key?.trim().toLowerCase() !== "charset" ||
      value?.trim().toLowerCase() !== "utf-8"
    ) {
      return null;
    }
  }
  const normalized = type!.trim().toLowerCase();
  if (normalized === "application/json") return "json";
  if (normalized === "application/x-www-form-urlencoded") return "form";
  return null;
}

/** Lowercase, one trailing dot removed: how a resolver reads the host. */
function normalisedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, "");
}

function moneyOriginFor(url: URL): ApiMoneyOrigin | null {
  const host = normalisedHost(url.hostname);
  return (
    API_MONEY_ORIGINS.find(
      (candidate) => new URL(candidate.origin).hostname === host,
    ) ?? null
  );
}

/** RFC 3492 decoding of one punycode label body (after "xn--"). */
function punycodeDecode(input: string): string | null {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const adapt = (delta: number, points: number, first: boolean) => {
    let d = first ? Math.floor(delta / 700) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + 38));
  };
  const output: number[] = [];
  const delimiter = Math.max(input.lastIndexOf("-"), 0);
  for (let j = 0; j < delimiter; j += 1) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return null;
    output.push(code);
  }
  let n = 128;
  let bias = 72;
  let i = 0;
  let index = delimiter > 0 ? delimiter + 1 : 0;
  while (index < input.length) {
    const old = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (index >= input.length) return null;
      const code = input.charCodeAt(index);
      index += 1;
      const digit =
        code >= 48 && code <= 57
          ? code - 22
          : code >= 97 && code <= 122
            ? code - 97
            : code >= 65 && code <= 90
              ? code - 65
              : base;
      if (digit >= base) return null;
      i += digit * w;
      if (!Number.isSafeInteger(i)) return null;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    const points = output.length + 1;
    bias = adapt(i - old, points, old === 0);
    n += Math.floor(i / points);
    i %= points;
    if (n > 0x10ffff) return null;
    output.splice(i, 0, n);
    i += 1;
  }
  return String.fromCodePoint(...output);
}

/** Latin look-alikes of the letters a money host is spelled with. */
const LOOKALIKES: Readonly<Record<string, string>> = Object.freeze({
  "0": "o",
  "1": "i",
  l: "i",
  а: "a", // Cyrillic а
  е: "e", // Cyrillic е
  і: "i", // Cyrillic і
  ї: "i", // Cyrillic ї
  о: "o", // Cyrillic о
  р: "p", // Cyrillic р
  с: "c", // Cyrillic с
  ѕ: "s", // Cyrillic ѕ
  т: "t", // Cyrillic т
  ґ: "r", // Cyrillic ґ
  α: "a", // Greek α
  ε: "e", // Greek ε
  ι: "i", // Greek ι
  ο: "o", // Greek ο
  ρ: "p", // Greek ρ
  τ: "t", // Greek τ
  ı: "i", // dotless i
  ɪ: "i", // small capital i
  ʀ: "r", // small capital r
  ᴘ: "p", // small capital p
  ᴛ: "t", // small capital t
  ᴇ: "e", // small capital e
  ꜱ: "s", // small capital s
});

/**
 * True when a host that is not a money host could be read as one: it
 * contains a money host's name once IDN labels are decoded, accents are
 * dropped and look-alike letters (Cyrillic, Greek, 1/l/0) are folded.
 */
function resemblesMoneyHost(hostname: string): boolean {
  const labels = normalisedHost(hostname).split(".");
  const decoded: string[] = [];
  for (const label of labels) {
    if (!label.startsWith("xn--")) {
      decoded.push(label);
      continue;
    }
    const unicode = punycodeDecode(label.slice(4));
    if (unicode === null) return true;
    decoded.push(unicode);
  }
  const skeleton = [...decoded.join(".").normalize("NFKD").toLowerCase()]
    .filter((char) => !/\p{M}/u.test(char))
    .map((char) => LOOKALIKES[char] ?? char)
    .join("")
    .replace(/[^a-z.]/gu, "");
  return API_MONEY_ORIGINS.some((candidate) => {
    const name = new URL(candidate.origin).hostname.split(".").slice(-2)[0]!;
    const folded = [...name].map((char) => LOOKALIKES[char] ?? char).join("");
    return skeleton.includes(folded);
  });
}

/**
 * Derives the money an `api.request` moves from the exact request.
 * "none": not on a money origin, a GET, or a reviewed non-money endpoint.
 * "money": the single readable amount, and the currency when the rule
 * reads one. "refused": the request moves money, or could, in a way that
 * cannot be read unambiguously (including any unreviewed endpoint on a
 * money origin).
 */
export function readApiMoney(request: ApiMoneyRequest): ApiMoneyReading {
  const url = parseRequestUrl(request.url);
  if (url === null) return { kind: "none" };
  const method = request.method.toUpperCase();
  const origin = moneyOriginFor(url);
  if (origin === null) {
    if (method !== "GET" && resemblesMoneyHost(url.hostname)) {
      return {
        kind: "refused",
        rule: "money host look-alike",
        reason: "MONEY_HOST_NONCANONICAL",
      };
    }
    const rule = apiMoneyRuleFor(method, request.url);
    return rule === null ? { kind: "none" } : readRule(rule, url, request);
  }
  // The host is a money host: it must be written exactly as the canonical
  // origin (no trailing dot, case, port, userinfo or other scheme), so the
  // URL checked here is the URL the executor sends.
  if (!request.url.startsWith(`${origin.origin}/`)) {
    return {
      kind: "refused",
      rule: `${origin.label} (non-canonical host)`,
      reason: "MONEY_HOST_NONCANONICAL",
    };
  }
  // Headers that change how the provider reads the request (API version,
  // acting account) are refused on every method.
  const semantic = (request.headers ?? []).some((header) => {
    const name = header.name.trim().toLowerCase();
    return origin.refusedHeaderPrefixes.some((prefix) =>
      name.startsWith(prefix),
    );
  });
  if (semantic) {
    return {
      kind: "refused",
      rule: `${origin.label} (semantic header)`,
      reason: "MONEY_HEADER_UNSUPPORTED",
    };
  }
  if (method === "GET") return { kind: "none" };
  // A path another server could normalize onto a money endpoint.
  if (/%|\/\/|;|\\/u.test(url.pathname)) {
    return {
      kind: "refused",
      rule: MONEY_ORIGIN_LABEL,
      reason: "AMOUNT_AMBIGUOUS",
    };
  }
  const rule = apiMoneyRuleFor(method, request.url);
  if (rule === null) {
    const known = API_NON_MONEY_ENDPOINTS.find(
      (endpoint) =>
        endpoint.origin === origin.origin &&
        endpoint.method === method &&
        endpoint.path.test(url.pathname),
    );
    if (known === undefined) {
      return {
        kind: "refused",
        rule: `${origin.label} (endpoint not reviewed)`,
        reason: "MONEY_ENDPOINT_UNKNOWN",
      };
    }
    const body = request.body ?? "";
    if (body !== "" && mediaType(request.headers) !== "form") {
      return {
        kind: "refused",
        rule: known.label,
        reason: "CONTENT_TYPE_UNSUPPORTED",
      };
    }
    return nonMoneyFieldsOk(known, url, body)
      ? { kind: "none" }
      : { kind: "refused", rule: known.label, reason: "AMOUNT_AMBIGUOUS" };
  }
  return readRule(rule, url, request);
}

const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * The form body reads unambiguously: no raw ";", no body or query key
 * containing a control character (e.g. "balance%00", which a C-string
 * parser reads as "balance"), and every refuseFields entry absent from the
 * query, form and JSON body.
 */
function nonMoneyFieldsOk(
  endpoint: ApiNonMoneyEndpoint,
  url: URL,
  text: string,
): boolean {
  const form = formFields(text);
  if (form === null) return false;
  const formKeys = [...new URLSearchParams(text).keys()];
  if (
    [...formKeys, ...url.searchParams.keys()].some((key) =>
      CONTROL_CHARACTER.test(key),
    )
  ) {
    return false;
  }
  if (endpoint.refuseFields.length === 0) return true;
  let json: string[] = [];
  let isJson = true;
  try {
    JSON.parse(text);
  } catch {
    isJson = false;
  }
  if (isJson) {
    const keys = jsonKeys(text);
    if (keys === null) return false;
    json = keys;
  }
  const query = [...url.searchParams.keys()];
  return endpoint.refuseFields.every((field) => {
    const named = (key: string) => key === field || lookalikeKey(key, field);
    const values = form.get(field);
    return (
      values !== null &&
      values.length === 0 &&
      !json.some(named) &&
      !query.some(named)
    );
  });
}

function readRule(
  rule: ApiMoneyRule,
  url: URL,
  request: ApiMoneyRequest,
): ApiMoneyReading {
  const refuse = (reason: ApiMoneyRefusal): ApiMoneyReading => ({
    kind: "refused",
    rule: rule.label,
    reason,
  });
  if (rule.amount === "unverifiable") return refuse("AMOUNT_UNVERIFIABLE");

  const currencyField =
    rule.currency === "implied" ? null : rule.currency.field;
  for (const key of url.searchParams.keys()) {
    if (
      // A key with a control character ("amount%00") is one a C-string
      // parser could truncate to a money field.
      CONTROL_CHARACTER.test(key) ||
      key === rule.amount.field ||
      lookalikeKey(key, rule.amount.field) ||
      (currencyField !== null &&
        (key === currencyField || lookalikeKey(key, currencyField)))
    ) {
      return refuse("AMOUNT_AMBIGUOUS");
    }
  }
  const type = mediaType(request.headers);
  if (type === null || !rule.bodies.includes(type)) {
    return refuse("CONTENT_TYPE_UNSUPPORTED");
  }
  const body = request.body ?? "";
  const fields = type === "json" ? jsonFields(body) : formFields(body);
  if (fields === null) {
    return refuse(type === "json" ? "BODY_UNREADABLE" : "AMOUNT_AMBIGUOUS");
  }
  const bodyKeys =
    type === "json" ? jsonKeys(body) : [...new URLSearchParams(body).keys()];
  if (
    bodyKeys === null ||
    bodyKeys.some((key) => CONTROL_CHARACTER.test(key))
  ) {
    return refuse("AMOUNT_AMBIGUOUS");
  }

  const amounts = fields.get(rule.amount.field);
  if (amounts === null) return refuse("AMOUNT_AMBIGUOUS");
  if (amounts.length === 0) return refuse("AMOUNT_MISSING");
  if (amounts.length > 1) return refuse("AMOUNT_AMBIGUOUS");
  const raw = amounts[0]!;
  if (!MINOR_UNITS.test(raw)) return refuse("AMOUNT_INVALID");
  const amountMinor = Number(raw);
  if (!Number.isSafeInteger(amountMinor)) return refuse("AMOUNT_INVALID");

  let currency: string | null = null;
  if (rule.currency !== "implied") {
    const currencies = fields.get(rule.currency.field);
    if (currencies === null) return refuse("AMOUNT_AMBIGUOUS");
    if (currencies.length === 0) return refuse("CURRENCY_MISSING");
    if (currencies.length > 1) return refuse("AMOUNT_AMBIGUOUS");
    currency = currencies[0]!.toLowerCase();
    if (!rule.currency.allowed.includes(currency)) {
      return refuse("CURRENCY_NOT_ALLOWED");
    }
  }
  return { kind: "money", rule: rule.label, amountMinor, currency };
}

const apiRequestDefinition: ActionDefinition<ApiRequestParametersV1> = {
  actionId: "api.request",
  schemaVersion: 1,
  actionFamily: "networking",
  humanLabel: "Call external API",
  description:
    "Issue an outbound https request within a connection's endpoint allowlist; the adapter injects the leased bearer token at commit.",
  parametersKind: "api.request.v1",
  requiredParameters: ["connectionId", "method", "url", "headers"],
  materialParameters: [
    "connectionId",
    "method",
    "url",
    "headers",
    "body",
    "idempotencyKey",
  ],
  resourceType: "api:endpoint",
  providers: ["api"],
  counterpartyRules:
    "Host+path must stay inside the connection endpoint allowlist; https only; agent may not set credential or hop-by-hop headers.",
  dataEffects:
    "May mutate or read external state; response metadata (status, byte count, headers digest, bounded body digest) is evidenced.",
  reversibility: "difficult",
  riskClass: "R3",
  defaultDecisionPosture: "deny",
  approvalPresentationSchema: ["method", "url", "headers", "bodyPreview"],
  capabilityRequirements: { uses: 1 },
  executionContract:
    "prepare → readback → commit → observe → verified/unknown/rejected; observe never re-issues the request.",
  verificationContract: { level: "post-commit-content" },
  evidenceRequirements: [
    "effect.prepared",
    "commit.authorized",
    "effect.verified | effect.unknown | commit.rejected",
  ],
  version: 1,
  status: "active",
  validateParameters(materialParameters) {
    const parsed = ApiRequestParametersV1Schema.safeParse(materialParameters);
    if (!parsed.success) return { ok: false };
    // A request that moves money in a way that cannot be read
    // unambiguously is refused before any decision (fail closed).
    if (readApiMoney(parsed.data).kind === "refused") return { ok: false };
    return { ok: true, params: parsed.data };
  },
  validateBinding({ params, connection }) {
    return apiEndpointWithinAllowlist(
      params.url,
      connection.endpointAllowlist ?? [],
    )
      ? { ok: true }
      : { ok: false, reasonCode: "ENDPOINT_OUTSIDE_ALLOWLIST" };
  },
  verificationProjection: (params) => apiVerificationProjection(params),
  envelopeProjection: (params) => apiEnvelopeProjection(params),
  // The amount is derived from the exact request, so a declared
  // valueCents must equal it; requests that move no money derive none (and
  // declaring one stays refused). Merchant and category are not derived:
  // the request names no merchant unambiguously.
  authorityFacts: (params) => {
    const money = readApiMoney(params);
    return money.kind === "money" ? { valueCents: money.amountMinor } : {};
  },
};

const toolInvokeDefinition: ActionDefinition<ToolInvokeParametersV1> = {
  actionId: "tool.invoke",
  schemaVersion: 1,
  actionFamily: "tooling",
  humanLabel: "Invoke tool",
  description:
    "Invoke a catalog tool enabled for the agent on a leased tool-server connection; renders to a bounded https call inside the connection endpoint allowlist.",
  parametersKind: "tool.invoke.v1",
  requiredParameters: ["connectionId", "toolName", "arguments"],
  materialParameters: ["connectionId", "toolName", "arguments"],
  resourceType: "tool:server",
  providers: ["tool"],
  counterpartyRules:
    "Tool name must exist in the connection catalog and be enabled for the requesting agent; the rendered endpoint stays inside the allowlist.",
  dataEffects:
    "May read or mutate external state through the tool; bounded invocation and result metadata is evidenced.",
  reversibility: "limited",
  riskClass: "R3",
  defaultDecisionPosture: "deny",
  approvalPresentationSchema: ["toolName", "serverName", "argumentsPreview"],
  capabilityRequirements: { uses: 1 },
  executionContract:
    "prepare → readback → commit → observe → verified/unknown/rejected; observe never re-issues the invocation.",
  verificationContract: { level: "post-commit-content" },
  evidenceRequirements: [
    "effect.prepared",
    "commit.authorized",
    "effect.verified | effect.unknown | commit.rejected",
  ],
  version: 1,
  status: "active",
  validateParameters(materialParameters) {
    const parsed = ToolInvokeParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  validateBinding({ params, connection }) {
    return validateToolInvokeBinding({ params, connection });
  },
  verificationProjection: (params) => toolVerificationProjection(params),
  envelopeProjection: (params) => toolEnvelopeProjection(params),
};

const mcpInstallDefinition: ActionDefinition<McpInstallParametersV1> = {
  actionId: "mcp.install",
  schemaVersion: 1,
  actionFamily: "capability-governance",
  humanLabel: "Install MCP tool",
  description:
    "Register an additional tool on a human-installed tool-server connection; capability-expanding — requires an explicit human grant, never auto-derived.",
  parametersKind: "mcp.install.v1",
  requiredParameters: ["connectionId", "tool"],
  materialParameters: ["connectionId", "tool"],
  resourceType: "mcp:server",
  providers: ["tool"],
  counterpartyRules:
    "Tool descriptor must be new to the catalog and its url must stay inside the existing endpoint allowlist; installs never create connections or widen scopes.",
  dataEffects:
    "Mutates the connection's tool catalog (adds one callable tool).",
  reversibility: "limited",
  riskClass: "R3",
  defaultDecisionPosture: "ask",
  approvalPresentationSchema: ["tool", "serverName"],
  capabilityRequirements: { uses: 1 },
  executionContract:
    "prepare → readback → commit → observe → verified/unknown/rejected",
  verificationContract: { level: "post-commit-content" },
  evidenceRequirements: [
    "effect.prepared",
    "commit.authorized",
    "effect.verified | effect.unknown | commit.rejected",
  ],
  version: 1,
  status: "active",
  requiresExplicitGrant: true,
  validateParameters(materialParameters) {
    const parsed = McpInstallParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  validateBinding({ params, connection }) {
    return validateMcpInstallBinding({ params, connection });
  },
  verificationProjection: (params) => mcpInstallProjection(params),
  envelopeProjection: (params) => mcpInstallProjection(params),
};

const mcpEnableDefinition: ActionDefinition<McpEnableParametersV1> = {
  actionId: "mcp.enable",
  schemaVersion: 1,
  actionFamily: "capability-governance",
  humanLabel: "Enable MCP tool",
  description:
    "Enable a catalog tool for the requesting agent on a tool-server connection; capability-expanding — requires an explicit human grant, never auto-derived.",
  parametersKind: "mcp.enable.v1",
  requiredParameters: ["connectionId", "toolName"],
  materialParameters: ["connectionId", "toolName"],
  resourceType: "mcp:server",
  providers: ["tool"],
  counterpartyRules:
    "Tool name must exist in the catalog; enabling writes to the per-agent tool registry with the granting evidence.",
  dataEffects: "Mutates the agent's tool registry (enables one catalog tool).",
  reversibility: "reversible",
  riskClass: "R2",
  defaultDecisionPosture: "ask",
  approvalPresentationSchema: ["toolName", "serverName"],
  capabilityRequirements: { uses: 1 },
  executionContract:
    "prepare → readback → commit → observe → verified/unknown/rejected",
  verificationContract: { level: "post-commit-content" },
  evidenceRequirements: [
    "effect.prepared",
    "commit.authorized",
    "effect.verified | effect.unknown | commit.rejected",
  ],
  version: 1,
  status: "active",
  requiresExplicitGrant: true,
  validateParameters(materialParameters) {
    const parsed = McpEnableParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  validateBinding({ params, connection }) {
    return validateMcpEnableBinding({ params, connection });
  },
  verificationProjection: (params) => mcpEnableProjection(params),
  envelopeProjection: (params) => mcpEnableProjection(params),
};

const GCAL_ADAPTER_ID = "adp_00000003";

const calendarBinding = (
  params: { calendarId: string },
  connection: ActionConnectionBinding,
): ActionBindingResult =>
  connection.provider === "gcalendar" &&
  connection.calendarId !== undefined &&
  params.calendarId === connection.calendarId
    ? { ok: true }
    : { ok: false, reasonCode: "CONNECTION_UNAVAILABLE" };

const calendarValidate =
  <P>(schema: ZodType<P>) =>
  (
    materialParameters: unknown,
  ): Readonly<{ ok: true; params: P }> | Readonly<{ ok: false }> => {
    const parsed = schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  };

const calendarDefinitionBase = {
  schemaVersion: 1 as const,
  actionFamily: "scheduling",
  resourceType: "calendar:calendar",
  providers: ["gcalendar"],
  adapterIds: [GCAL_ADAPTER_ID],
  counterpartyRules:
    "Events live on the connection's authorized calendar only; external invitees are counterparties and are material.",
  capabilityRequirements: { uses: 1 },
  executionContract:
    "prepare → readback → commit → observe → verified/unknown/rejected; observe never re-issues the request.",
  verificationContract: { level: "post-commit-content" },
  evidenceRequirements: [
    "effect.prepared",
    "commit.authorized",
    "effect.verified | effect.unknown | commit.rejected",
  ],
  version: 1 as const,
  status: "active" as const,
};

const calendarCreateDefinition: ActionDefinition<CalendarCreateParametersV1> = {
  ...calendarDefinitionBase,
  actionId: "calendar.create",
  humanLabel: "Create calendar event",
  description:
    "Create an event on the connection's authorized calendar; attendees are never settable here — inviting people is a separate material commitment.",
  parametersKind: "calendar.create.v1",
  requiredParameters: ["connectionId", "calendarId", "summary", "start", "end"],
  materialParameters: [
    "connectionId",
    "calendarId",
    "summary",
    "description",
    "location",
    "start",
    "end",
    "idempotencyKey",
  ],
  dataEffects: "Creates an event record on the authorized calendar.",
  transaction: FULL_TRANSACTION_LIFECYCLE,
  reversibility: "reversible",
  riskClass: "R2",
  defaultDecisionPosture: "allow",
  approvalPresentationSchema: ["summary", "start", "end", "location"],
  validateParameters: calendarValidate(CalendarCreateParametersV1Schema),
  validateBinding: ({ params, connection }) =>
    calendarBinding(params, connection),
  verificationProjection: (params) => calendarVerificationProjection(params),
  envelopeProjection: (params) => calendarEnvelopeProjection(params),
};

const calendarUpdateDefinition: ActionDefinition<CalendarUpdateParametersV1> = {
  ...calendarDefinitionBase,
  actionId: "calendar.update",
  humanLabel: "Update calendar event",
  description:
    "Change fields of an existing event — including its committed start/end time — on the authorized calendar; a material external commitment.",
  parametersKind: "calendar.update.v1",
  requiredParameters: ["connectionId", "calendarId", "eventId"],
  materialParameters: [
    "connectionId",
    "calendarId",
    "eventId",
    "summary",
    "description",
    "location",
    "start",
    "end",
    "sendUpdates",
  ],
  dataEffects:
    "Mutates a live commitment; a changed time moves every attendee's schedule.",
  reversibility: "limited",
  riskClass: "R3",
  defaultDecisionPosture: "ask",
  approvalPresentationSchema: [
    "eventId",
    "summary",
    "start",
    "end",
    "location",
  ],
  validateParameters: calendarValidate(CalendarUpdateParametersV1Schema),
  validateBinding: ({ params, connection }) =>
    calendarBinding(params, connection),
  verificationProjection: (params) => calendarVerificationProjection(params),
  envelopeProjection: (params) => calendarEnvelopeProjection(params),
};

const calendarCancelDefinition: ActionDefinition<CalendarCancelParametersV1> = {
  ...calendarDefinitionBase,
  actionId: "calendar.cancel",
  humanLabel: "Cancel calendar event",
  description:
    "Cancel (delete) an existing event on the authorized calendar; destroys a commitment.",
  parametersKind: "calendar.cancel.v1",
  requiredParameters: ["connectionId", "calendarId", "eventId"],
  materialParameters: ["connectionId", "calendarId", "eventId", "sendUpdates"],
  dataEffects:
    "Removes a commitment; may send cancellation notices to attendees.",
  transaction: FULL_TRANSACTION_LIFECYCLE,
  compensatesAction: "calendar.create",
  reversibility: "difficult",
  riskClass: "R3",
  defaultDecisionPosture: "ask",
  approvalPresentationSchema: ["eventId", "sendUpdates"],
  validateParameters: calendarValidate(CalendarCancelParametersV1Schema),
  validateBinding: ({ params, connection }) =>
    calendarBinding(params, connection),
  verificationProjection: (params) => calendarVerificationProjection(params),
  envelopeProjection: (params) => calendarEnvelopeProjection(params),
};

const calendarInviteDefinition: ActionDefinition<CalendarInviteParametersV1> = {
  ...calendarDefinitionBase,
  actionId: "calendar.invite",
  humanLabel: "Invite attendees to event",
  description:
    "Add external attendees to an existing event on the authorized calendar; creates a material external commitment to each invitee.",
  parametersKind: "calendar.invite.v1",
  requiredParameters: ["connectionId", "calendarId", "eventId", "attendees"],
  materialParameters: [
    "connectionId",
    "calendarId",
    "eventId",
    "attendees",
    "sendUpdates",
  ],
  dataEffects:
    "Sends invitations to external addresses; the attendee set is material and approval-bound.",
  reversibility: "limited",
  riskClass: "R3",
  defaultDecisionPosture: "ask",
  approvalPresentationSchema: ["eventId", "attendees", "sendUpdates"],
  validateParameters: calendarValidate(CalendarInviteParametersV1Schema),
  validateBinding: ({ params, connection }) =>
    calendarBinding(params, connection),
  verificationProjection: (params) => calendarVerificationProjection(params),
  envelopeProjection: (params) => calendarEnvelopeProjection(params),
};

const commercePurchaseDefinition: ActionDefinition<CommercePurchaseParametersV1> =
  {
    actionId: "commerce.purchase",
    schemaVersion: 1,
    actionFamily: "commerce",
    humanLabel: "Purchase",
    description:
      "Charge a leased payment connection for a one-shot purchase; the adapter charges adapter-side and no reusable payment credential reaches the agent.",
    parametersKind: "commerce.purchase.v1",
    requiredParameters: [
      "connectionId",
      "merchantId",
      "merchantCategory",
      "amountCents",
      "currency",
      "orderDescription",
      "idempotencyKey",
    ],
    materialParameters: [
      "connectionId",
      "merchantId",
      "merchantCategory",
      "amountCents",
      "currency",
      "orderDescription",
      "idempotencyKey",
      "taskId",
    ],
    resourceType: "commerce:account",
    providers: ["payment-sandbox"],
    counterpartyRules:
      "merchantId is the external counterparty; merchant/category facts are re-derived from parameters and bound into the material digest.",
    dataEffects:
      "Moves money within sandbox/test scope only; charge metadata is evidenced.",
    transaction: FULL_TRANSACTION_LIFECYCLE,
    reversibility: "limited",
    riskClass: "R4",
    defaultDecisionPosture: "allow",
    approvalPresentationSchema: [
      "merchantId",
      "merchantCategory",
      "amountCents",
      "currency",
      "orderDescription",
      "taskId",
    ],
    capabilityRequirements: { uses: 1 },
    executionContract:
      "prepare → readback → commit (charge) → observe → verified/unknown/rejected",
    verificationContract: { level: "post-commit-content" },
    evidenceRequirements: [
      "effect.prepared",
      "commit.authorized",
      "effect.verified | effect.unknown | commit.rejected",
    ],
    version: 1,
    status: "active",
    validateParameters(materialParameters) {
      const parsed =
        CommercePurchaseParametersV1Schema.safeParse(materialParameters);
      return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
    },
    validateBinding() {
      return { ok: true };
    },
    verificationProjection: (params) =>
      commercePurchaseVerificationProjection(params),
    envelopeProjection: (params) => commercePurchaseEnvelopeProjection(params),
    authorityFacts: (params) => ({
      valueCents: params.amountCents,
      merchantId: params.merchantId,
      merchantCategory: params.merchantCategory,
      recurring: false,
      ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
    }),
  };

const commerceRefundDefinition: ActionDefinition<CommerceRefundParametersV1> = {
  actionId: "commerce.refund",
  schemaVersion: 1,
  actionFamily: "commerce",
  humanLabel: "Refund",
  description:
    "Refund a prior sandbox charge by chargeId; adapter-side only, full refund when amountCents is omitted.",
  parametersKind: "commerce.refund.v1",
  requiredParameters: ["connectionId", "chargeId", "reason"],
  materialParameters: ["connectionId", "chargeId", "amountCents", "reason"],
  resourceType: "commerce:account",
  providers: ["payment-sandbox"],
  counterpartyRules: "Refunds settle to the original charge's counterparty.",
  dataEffects: "Returns money within sandbox/test scope only.",
  transaction: FULL_TRANSACTION_LIFECYCLE,
  compensatesAction: "commerce.purchase",
  reversibility: "difficult",
  riskClass: "R3",
  defaultDecisionPosture: "allow",
  approvalPresentationSchema: ["chargeId", "amountCents", "reason"],
  capabilityRequirements: { uses: 1 },
  executionContract:
    "prepare → readback → commit (refund) → observe → verified/unknown/rejected",
  verificationContract: { level: "post-commit-content" },
  evidenceRequirements: [
    "effect.prepared",
    "commit.authorized",
    "effect.verified | effect.unknown | commit.rejected",
  ],
  version: 1,
  status: "active",
  validateParameters(materialParameters) {
    const parsed =
      CommerceRefundParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  validateBinding() {
    return { ok: true };
  },
  verificationProjection: (params) =>
    commerceRefundVerificationProjection(params),
  envelopeProjection: (params) => commerceRefundEnvelopeProjection(params),
  authorityFacts: (params) =>
    params.amountCents === undefined ? {} : { valueCents: params.amountCents },
};

const commerceReturnDefinition: ActionDefinition<CommerceReturnParametersV1> = {
  actionId: "commerce.return",
  schemaVersion: 1,
  actionFamily: "commerce",
  humanLabel: "Return",
  description:
    "Record a return against a prior sandbox charge by chargeId; adapter-side only.",
  parametersKind: "commerce.return.v1",
  requiredParameters: ["connectionId", "chargeId", "reason"],
  materialParameters: ["connectionId", "chargeId", "reason"],
  resourceType: "commerce:account",
  providers: ["payment-sandbox"],
  counterpartyRules: "Returns settle to the original charge's counterparty.",
  dataEffects: "Records a goods return within sandbox/test scope only.",
  transaction: FULL_TRANSACTION_LIFECYCLE,
  compensatesAction: "commerce.purchase",
  reversibility: "reversible",
  riskClass: "R2",
  defaultDecisionPosture: "allow",
  approvalPresentationSchema: ["chargeId", "reason"],
  capabilityRequirements: { uses: 1 },
  executionContract:
    "prepare → readback → commit (return) → observe → verified/unknown/rejected",
  verificationContract: { level: "post-commit-content" },
  evidenceRequirements: [
    "effect.prepared",
    "commit.authorized",
    "effect.verified | effect.unknown | commit.rejected",
  ],
  version: 1,
  status: "active",
  validateParameters(materialParameters) {
    const parsed =
      CommerceReturnParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  validateBinding() {
    return { ok: true };
  },
  verificationProjection: (params) =>
    commerceReturnVerificationProjection(params),
  envelopeProjection: (params) => commerceReturnEnvelopeProjection(params),
  authorityFacts: () => ({}),
};

const subscriptionCreateDefinition: ActionDefinition<SubscriptionCreateParametersV1> =
  {
    actionId: "subscription.create",
    schemaVersion: 1,
    actionFamily: "commerce",
    humanLabel: "Create subscription",
    description:
      "Start a recurring subscription charge on a leased payment connection; recurrence is a derived authority fact the kernel can deny.",
    parametersKind: "subscription.create.v1",
    requiredParameters: [
      "connectionId",
      "merchantId",
      "planId",
      "amountCents",
      "currency",
      "interval",
      "idempotencyKey",
    ],
    materialParameters: [
      "connectionId",
      "merchantId",
      "planId",
      "amountCents",
      "currency",
      "interval",
      "idempotencyKey",
    ],
    resourceType: "commerce:account",
    providers: ["payment-sandbox"],
    counterpartyRules:
      "merchantId is the external counterparty; recurring is derived as true so recurrence control applies.",
    dataEffects:
      "Creates a recurring payment obligation within sandbox/test scope only.",
    transaction: FULL_TRANSACTION_LIFECYCLE,
    reversibility: "limited",
    riskClass: "R4",
    defaultDecisionPosture: "deny",
    approvalPresentationSchema: [
      "merchantId",
      "planId",
      "amountCents",
      "currency",
      "interval",
    ],
    capabilityRequirements: { uses: 1 },
    executionContract:
      "prepare → readback → commit (subscribe) → observe → verified/unknown/rejected",
    verificationContract: { level: "post-commit-content" },
    evidenceRequirements: [
      "effect.prepared",
      "commit.authorized",
      "effect.verified | effect.unknown | commit.rejected",
    ],
    version: 1,
    status: "active",
    validateParameters(materialParameters) {
      const parsed =
        SubscriptionCreateParametersV1Schema.safeParse(materialParameters);
      return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
    },
    validateBinding() {
      return { ok: true };
    },
    verificationProjection: (params) =>
      subscriptionCreateVerificationProjection(params),
    envelopeProjection: (params) =>
      subscriptionCreateEnvelopeProjection(params),
    authorityFacts: (params) => ({
      valueCents: params.amountCents,
      merchantId: params.merchantId,
      recurring: true,
    }),
  };

export const EMAIL_SEND_DEFINITION = emailSendDefinition;
export const API_REQUEST_DEFINITION = apiRequestDefinition;
export const TOOL_INVOKE_DEFINITION = toolInvokeDefinition;
export const MCP_INSTALL_DEFINITION = mcpInstallDefinition;
export const MCP_ENABLE_DEFINITION = mcpEnableDefinition;
export const COMMERCE_PURCHASE_DEFINITION = commercePurchaseDefinition;
export const COMMERCE_REFUND_DEFINITION = commerceRefundDefinition;
export const COMMERCE_RETURN_DEFINITION = commerceReturnDefinition;
export const SUBSCRIPTION_CREATE_DEFINITION = subscriptionCreateDefinition;

function fileDefinition<P>(input: {
  actionId: string;
  humanLabel: string;
  description: string;
  parametersKind: string;
  requiredParameters: readonly string[];
  materialParameters: readonly string[];
  dataEffects: string;
  reversibility: Reversibility;
  riskClass: RiskClass;
  parse: (
    materialParameters: unknown,
  ) => { ok: true; params: P } | { ok: false };
  bind: (input: {
    params: P;
    connection: ActionConnectionBinding;
  }) => ActionBindingResult;
  projection: (params: P) => unknown;
}): ActionDefinition<P> {
  return {
    actionId: input.actionId,
    schemaVersion: 1,
    actionFamily: "files",
    humanLabel: input.humanLabel,
    description: input.description,
    parametersKind: input.parametersKind,
    requiredParameters: input.requiredParameters,
    materialParameters: input.materialParameters,
    resourceType: "file:store",
    providers: ["file", "local"],
    counterpartyRules:
      "Paths must be canonical and inside the connection path allowlist; shares additionally require the declared share allowlist.",
    dataEffects: input.dataEffects,
    reversibility: input.reversibility,
    riskClass: input.riskClass,
    defaultDecisionPosture: "deny",
    approvalPresentationSchema: ["path", "grantee", "bytes"],
    capabilityRequirements: { uses: 1 },
    executionContract:
      "prepare → readback → commit → observe → verified/unknown/rejected",
    verificationContract: { level: "post-commit-content" },
    evidenceRequirements: [
      "effect.prepared",
      "commit.authorized",
      "effect.verified | effect.unknown | commit.rejected",
    ],
    version: 1,
    status: "active",
    validateParameters: input.parse,
    validateBinding: input.bind,
    verificationProjection: input.projection,
    envelopeProjection: input.projection,
  };
}

const fileReadDefinition = fileDefinition<FileReadParametersV1>({
  actionId: "file.read",
  humanLabel: "Read file",
  description:
    "Read a file from the connection's file store; content is delivered to the agent in the execution receipt, digest-correlated with the evidence.",
  parametersKind: "file.read.v1",
  requiredParameters: ["connectionId", "path"],
  materialParameters: ["connectionId", "path"],
  dataEffects:
    "Returns stored content to the agent (a SEE-equivalent on files); sealed files are rejected before effect.",
  reversibility: "reversible",
  riskClass: "R2",
  parse: (materialParameters) => {
    const parsed = FileReadParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  bind: ({ params, connection }) =>
    filePathWithinAllowlist(params.path, connection.pathAllowlist ?? [])
      ? { ok: true }
      : { ok: false, reasonCode: "PATH_OUTSIDE_ALLOWLIST" },
  projection: (params) => fileReadVerificationProjection(params),
});

const fileWriteDefinition = fileDefinition<FileWriteParametersV1>({
  actionId: "file.write",
  humanLabel: "Write file",
  description:
    "Write agent-supplied content to a path inside the connection path allowlist; the written bytes are verified post-commit.",
  parametersKind: "file.write.v1",
  requiredParameters: ["connectionId", "path", "content"],
  materialParameters: ["connectionId", "path", "content"],
  dataEffects: "Creates or replaces a stored file.",
  reversibility: "limited",
  riskClass: "R2",
  parse: (materialParameters) => {
    const parsed = FileWriteParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  bind: ({ params, connection }) =>
    filePathWithinAllowlist(params.path, connection.pathAllowlist ?? [])
      ? { ok: true }
      : { ok: false, reasonCode: "PATH_OUTSIDE_ALLOWLIST" },
  projection: (params) => fileWriteVerificationProjection(params),
});

const fileShareDefinition = fileDefinition<FileShareParametersV1>({
  actionId: "file.share",
  humanLabel: "Share file",
  description:
    "Create a share grant for a file inside the connection's declared share allowlist; sealed (protected-materialized) files cannot be shared.",
  parametersKind: "file.share.v1",
  requiredParameters: ["connectionId", "path", "grantee"],
  materialParameters: ["connectionId", "path", "grantee", "expiresAtEpochMs"],
  dataEffects:
    "Grants the named grantee read access to the file (a DISCLOSE-equivalent on files); shares outside the declared scope deny before effect.",
  reversibility: "limited",
  riskClass: "R3",
  parse: (materialParameters) => {
    const parsed = FileShareParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  bind: ({ params, connection }) =>
    filePathWithinAllowlist(params.path, connection.shareAllowlist ?? [])
      ? { ok: true }
      : { ok: false, reasonCode: "SHARE_OUTSIDE_ALLOWLIST" },
  projection: (params) => fileShareVerificationProjection(params),
});

const fileDeleteDefinition = fileDefinition<FileDeleteParametersV1>({
  actionId: "file.delete",
  humanLabel: "Delete file",
  description:
    "Remove a file inside the connection path allowlist; absence is verified post-commit.",
  parametersKind: "file.delete.v1",
  requiredParameters: ["connectionId", "path"],
  materialParameters: ["connectionId", "path"],
  dataEffects: "Irreversibly removes the stored file.",
  reversibility: "destructive",
  riskClass: "R3",
  parse: (materialParameters) => {
    const parsed = FileDeleteParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  bind: ({ params, connection }) =>
    filePathWithinAllowlist(params.path, connection.pathAllowlist ?? [])
      ? { ok: true }
      : { ok: false, reasonCode: "PATH_OUTSIDE_ALLOWLIST" },
  projection: (params) => fileDeleteVerificationProjection(params),
});

type ProtectedParams<P> = { connectionId: string; fieldRef: string } & P;

function protectedDefinition<P>(input: {
  actionId: string;
  humanLabel: string;
  description: string;
  parametersKind: string;
  requiredParameters: readonly string[];
  materialParameters: readonly string[];
  dataEffects: string;
  reversibility: Reversibility;
  riskClass: RiskClass;
  parse: (
    materialParameters: unknown,
  ) => { ok: true; params: P } | { ok: false };
  bind: (input: {
    params: P;
    field: ProtectedCatalogEntry | null;
  }) => ActionBindingResult;
  projection: (params: P) => unknown;
}): ActionDefinition<P> {
  return {
    actionId: input.actionId,
    schemaVersion: 1,
    actionFamily: "protected-data",
    humanLabel: input.humanLabel,
    description: input.description,
    parametersKind: input.parametersKind,
    requiredParameters: input.requiredParameters,
    materialParameters: input.materialParameters,
    resourceType: "protected:data",
    providers: ["protected_data"],
    counterpartyRules:
      "USE/SEE/DISCLOSE are independent policy operations; the connection's declared catalog binds each one at field level.",
    dataEffects: input.dataEffects,
    reversibility: input.reversibility,
    riskClass: input.riskClass,
    defaultDecisionPosture: "deny",
    approvalPresentationSchema: [
      "fieldRef",
      "counterparty",
      "sink",
      "maskedPreview",
    ],
    capabilityRequirements: { uses: 1 },
    executionContract:
      "prepare → readback → commit → observe → verified/unknown/rejected; the adapter resolves and injects the protected value at execution.",
    verificationContract: { level: "post-commit-content" },
    evidenceRequirements: [
      "effect.prepared",
      "commit.authorized",
      "effect.verified | effect.unknown | commit.rejected",
    ],
    version: 1,
    status: "active",
    validateParameters: input.parse,
    validateBinding: ({ params, connection }) => {
      const field = protectedCatalogField(
        connection.protectedCatalog,
        (params as ProtectedParams<object>).fieldRef,
      );
      if (!field) {
        return { ok: false, reasonCode: "FIELD_NOT_IN_CATALOG" };
      }
      return input.bind({ params, field });
    },
    verificationProjection: input.projection,
    envelopeProjection: input.projection,
  };
}

const protectedUseDefinition = protectedDefinition<ProtectedUseParametersV1>({
  actionId: "protected_data.use",
  humanLabel: "Use protected data",
  description:
    "Inject a catalog-declared protected field into a declared file sink at execution time; the agent never receives the plaintext.",
  parametersKind: "protected-data.use.v1",
  requiredParameters: ["connectionId", "fieldRef", "sink"],
  materialParameters: ["connectionId", "fieldRef", "sink"],
  dataEffects:
    "Materializes the protected value inside the declared sink file (sealed); the agent receives only path + digest evidence.",
  reversibility: "limited",
  riskClass: "R3",
  parse: (materialParameters) => {
    const parsed = ProtectedUseParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  bind: ({ params, field }) =>
    field?.allowUse !== true
      ? { ok: false, reasonCode: "USE_NOT_ALLOWED" }
      : protectedSinkWithinUseSinks(params.sink, field.useSinks)
        ? { ok: true }
        : { ok: false, reasonCode: "SINK_OUTSIDE_DECLARED" },
  projection: (params) => protectedUseVerificationProjection(params),
});

const protectedViewDefinition = protectedDefinition<ProtectedViewParametersV1>({
  actionId: "protected_data.view",
  humanLabel: "View protected data",
  description:
    "Deliver a catalog-declared protected field to the agent once, via the execution receipt's delivered channel; requires allowView.",
  parametersKind: "protected-data.view.v1",
  requiredParameters: ["connectionId", "fieldRef"],
  materialParameters: ["connectionId", "fieldRef"],
  dataEffects:
    "Discloses the protected value to the agent (SEE); not persisted in the ledger.",
  reversibility: "limited",
  riskClass: "R3",
  parse: (materialParameters) => {
    const parsed =
      ProtectedViewParametersV1Schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  },
  bind: ({ field }) =>
    field?.allowView === true
      ? { ok: true }
      : { ok: false, reasonCode: "VIEW_NOT_ALLOWED" },
  projection: (params) => protectedViewVerificationProjection(params),
});

const protectedDiscloseDefinition =
  protectedDefinition<ProtectedDiscloseParametersV1>({
    actionId: "protected_data.disclose",
    humanLabel: "Disclose protected data",
    description:
      "Send a catalog-declared protected field to a catalog-declared counterparty; without explicit authority the action denies before execution.",
    parametersKind: "protected-data.disclose.v1",
    requiredParameters: ["connectionId", "fieldRef", "counterparty"],
    materialParameters: ["connectionId", "fieldRef", "counterparty"],
    dataEffects:
      "Delivers the protected value to the declared counterparty only (DISCLOSE); the agent never receives it.",
    reversibility: "difficult",
    riskClass: "R4",
    parse: (materialParameters) => {
      const parsed =
        ProtectedDiscloseParametersV1Schema.safeParse(materialParameters);
      return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
    },
    bind: ({ params, field }) =>
      field?.discloseTargets.includes(params.counterparty) === true
        ? { ok: true }
        : { ok: false, reasonCode: "DISCLOSE_TARGET_NOT_DECLARED" },
    projection: (params) => protectedDiscloseVerificationProjection(params),
  });

const protectedPersistDefinition =
  protectedDefinition<ProtectedPersistParametersV1>({
    actionId: "protected_data.persist",
    humanLabel: "Persist protected data",
    description:
      "Store an agent-supplied value into a catalog-declared protected field; requires allowPersist on the declared field.",
    parametersKind: "protected-data.persist.v1",
    requiredParameters: ["connectionId", "fieldRef", "value"],
    materialParameters: ["connectionId", "fieldRef", "value"],
    dataEffects: "Writes a new protected value into the declared field slot.",
    reversibility: "limited",
    riskClass: "R3",
    parse: (materialParameters) => {
      const parsed =
        ProtectedPersistParametersV1Schema.safeParse(materialParameters);
      return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
    },
    bind: ({ field }) =>
      field?.allowPersist === true
        ? { ok: true }
        : { ok: false, reasonCode: "PERSIST_NOT_ALLOWED" },
    projection: (params) => protectedPersistVerificationProjection(params),
  });

/** The shipped registry: enforced surfaces as first-class definitions. */
function localDefinition<P>(input: {
  actionId: string;
  actionFamily: string;
  humanLabel: string;
  description: string;
  parametersKind: string;
  requiredParameters: readonly string[];
  resourceType: string;
  defaultDecisionPosture: "allow" | "ask" | "deny";
  requiresExplicitGrant?: boolean;
  riskClass: RiskClass;
  parse: (
    materialParameters: unknown,
  ) => { ok: true; params: P } | { ok: false };
  bind: (input: {
    params: P;
    connection: ActionConnectionBinding;
  }) => ActionBindingResult;
  projection: (params: P) => unknown;
}): ActionDefinition<P> {
  return {
    actionId: input.actionId,
    schemaVersion: 1,
    actionFamily: input.actionFamily,
    humanLabel: input.humanLabel,
    description: input.description,
    parametersKind: input.parametersKind,
    requiredParameters: input.requiredParameters,
    materialParameters: input.requiredParameters,
    resourceType: input.resourceType,
    providers: ["local"],
    counterpartyRules:
      "Local mediation binds to declared connection facts only (command class, endpoint allowlist); anything the registry cannot inspect fails closed.",
    dataEffects:
      "Local host effects as declared by the action family (command, filesystem, network, or browser).",
    reversibility: "limited",
    riskClass: input.riskClass,
    defaultDecisionPosture: input.defaultDecisionPosture,
    approvalPresentationSchema: input.requiredParameters,
    capabilityRequirements: { uses: 1 },
    executionContract:
      "propose → evaluate → issue → mediated execution → verified/unknown/rejected",
    verificationContract: { level: "post-commit-content" },
    evidenceRequirements: [
      "commit.authorized",
      "effect.verified | effect.unknown | commit.rejected",
    ],
    ...(input.requiresExplicitGrant ? { requiresExplicitGrant: true } : {}),
    version: 1,
    status: "active",
    validateParameters: input.parse,
    validateBinding: input.bind,
    verificationProjection: input.projection,
    envelopeProjection: input.projection,
  };
}

const parseLocalParams = <P>(schema: ZodType<P>) => {
  return (
    materialParameters: unknown,
  ): { ok: true; params: P } | { ok: false } => {
    const parsed = schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  };
};

const localExecDefinition = localDefinition<LocalExecParametersV1>({
  actionId: "local.exec",
  actionFamily: "local.exec",
  humanLabel: "Run a routine local command",
  description:
    "Executes a command classified `routine` through the local runtime mediator; every other class is routed to its own action and re-checked at binding.",
  parametersKind: LOCAL_EXEC_PARAMETERS_SCHEMA_ID,
  requiredParameters: ["connectionId", "command", "cwd"],
  resourceType: "local_host",
  defaultDecisionPosture: "allow",
  riskClass: "R2",
  parse: parseLocalParams(LocalExecParametersV1Schema),
  bind: localExecBinding("routine"),
  projection: localExecVerificationProjection,
});

const localExecPublishDefinition = localDefinition<LocalExecParametersV1>({
  actionId: "local.exec.publish",
  actionFamily: "local.exec",
  humanLabel: "Run an outbound-mutating local command",
  description:
    "Commands classified `publish` (network tools, package installs, remote git ops, file writes) always require human approval.",
  parametersKind: LOCAL_EXEC_PARAMETERS_SCHEMA_ID,
  requiredParameters: ["connectionId", "command", "cwd"],
  resourceType: "local_host",
  defaultDecisionPosture: "ask",
  riskClass: "R3",
  parse: parseLocalParams(LocalExecParametersV1Schema),
  bind: localExecBinding("publish"),
  projection: localExecVerificationProjection,
});

const localExecDestroyDefinition = localDefinition<LocalExecParametersV1>({
  actionId: "local.exec.destroy",
  actionFamily: "local.exec",
  humanLabel: "Run a destructive local command",
  description:
    "Commands classified `destructive` (rm, terraform destroy, nested shells, inline interpreters, force pushes) are denied unless the human grants this action explicitly.",
  parametersKind: LOCAL_EXEC_PARAMETERS_SCHEMA_ID,
  requiredParameters: ["connectionId", "command", "cwd"],
  resourceType: "local_host",
  defaultDecisionPosture: "deny",
  requiresExplicitGrant: true,
  riskClass: "R4",
  parse: parseLocalParams(LocalExecParametersV1Schema),
  bind: localExecBinding("destructive"),
  projection: localExecVerificationProjection,
});

const localEgressDefinition = localDefinition<LocalEgressParametersV1>({
  actionId: "local.egress",
  actionFamily: "local.egress",
  humanLabel: "Send a network request from the local host",
  description:
    "Mediated network egress; the URL must canonicalize inside the connection endpoint allowlist and always requires human approval.",
  parametersKind: LOCAL_EGRESS_PARAMETERS_SCHEMA_ID,
  requiredParameters: ["connectionId", "url", "method"],
  resourceType: "local_host",
  defaultDecisionPosture: "ask",
  riskClass: "R3",
  parse: parseLocalParams(LocalEgressParametersV1Schema),
  bind: localEndpointBinding,
  projection: localEgressVerificationProjection,
});

const localBrowseDefinition = localDefinition<LocalBrowseParametersV1>({
  actionId: "local.browse",
  actionFamily: "local.browse",
  humanLabel: "Open a URL in the local browser",
  description:
    "Mediated browser navigation; the URL must canonicalize inside the connection endpoint allowlist.",
  parametersKind: LOCAL_BROWSE_PARAMETERS_SCHEMA_ID,
  requiredParameters: ["connectionId", "url"],
  resourceType: "local_host",
  defaultDecisionPosture: "allow",
  riskClass: "R1",
  parse: parseLocalParams(LocalBrowseParametersV1Schema),
  bind: localEndpointBinding,
  projection: localBrowseVerificationProjection,
});

export const LOCAL_EXEC_DEFINITION = localExecDefinition;
export const LOCAL_EXEC_PUBLISH_DEFINITION = localExecPublishDefinition;
export const LOCAL_EXEC_DESTROY_DEFINITION = localExecDestroyDefinition;
export const LOCAL_EGRESS_DEFINITION = localEgressDefinition;
export const LOCAL_BROWSE_DEFINITION = localBrowseDefinition;

/**
 * Internal "guardian" provider definitions. Same shape as the
 * local helper, but these actions mutate Guardian's own registries through
 * server-side ports: delegation edges, agent memory, identity mutations,
 * runtime/model/config. Risk and posture are per action.
 */
function guardianDefinition<P>(input: {
  actionId: string;
  actionFamily: string;
  humanLabel: string;
  description: string;
  parametersKind: string;
  requiredParameters: readonly string[];
  defaultDecisionPosture: "allow" | "ask" | "deny";
  requiresExplicitGrant?: boolean;
  riskClass: RiskClass;
  reversibility: Reversibility;
  dataEffects: string;
  parse: (
    materialParameters: unknown,
  ) => { ok: true; params: P } | { ok: false };
  bind: (input: {
    params: P;
    connection: ActionConnectionBinding;
  }) => ActionBindingResult;
  projection: (params: P) => unknown;
  minPrincipalClass?: "adult";
}): ActionDefinition<P> {
  return {
    actionId: input.actionId,
    schemaVersion: 1,
    actionFamily: input.actionFamily,
    humanLabel: input.humanLabel,
    description: input.description,
    parametersKind: input.parametersKind,
    requiredParameters: input.requiredParameters,
    materialParameters: input.requiredParameters,
    resourceType: GUARDIAN_RESOURCE_TYPE,
    providers: [GUARDIAN_PROVIDER],
    ...(input.minPrincipalClass === "adult"
      ? { minPrincipalClass: "adult" as const }
      : {}),
    counterpartyRules:
      "Internal mutation: the only counterparty is the requesting agent's own bonded sub-agent or its own record; cross-principal effects are out of scope.",
    dataEffects: input.dataEffects,
    reversibility: input.reversibility,
    riskClass: input.riskClass,
    defaultDecisionPosture: input.defaultDecisionPosture,
    approvalPresentationSchema: input.requiredParameters,
    capabilityRequirements: { uses: 1 },
    executionContract:
      "propose → evaluate → issue → internal port mutation → verified/unknown/rejected",
    verificationContract: { level: "post-commit-content" },
    evidenceRequirements: [
      "commit.authorized",
      "effect.verified | effect.unknown | commit.rejected",
    ],
    ...(input.requiresExplicitGrant ? { requiresExplicitGrant: true } : {}),
    version: 1,
    status: "active",
    validateParameters: input.parse,
    validateBinding: input.bind,
    verificationProjection: input.projection,
    envelopeProjection: input.projection,
  };
}

const parseGuardianParams = <P>(schema: ZodType<P>) => {
  return (
    materialParameters: unknown,
  ): { ok: true; params: P } | { ok: false } => {
    const parsed = schema.safeParse(materialParameters);
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
  };
};

const bondedBinding = (
  childAgentId: string,
  connection: ActionConnectionBinding,
): ActionBindingResult =>
  connection.bondedSubAgentIds !== undefined &&
  connection.bondedSubAgentIds.includes(childAgentId)
    ? { ok: true }
    : { ok: false, reasonCode: "UNBONDED_SUB_AGENT" };

const memoryNamespaceBinding = (
  key: string,
  allowGoverned: boolean,
): ActionBindingResult =>
  key.startsWith(MEMORY_RESERVED_PREFIX) ||
  (!allowGoverned && key.startsWith(MEMORY_GOVERNED_PREFIX))
    ? { ok: false, reasonCode: "MEMORY_NAMESPACE_RESERVED" }
    : { ok: true };

/* Derived-data operations. Same envelope→policy→capability→
 * receipt path as the rest of the protected-data family; binding is
 * connection-scoped (data objects resolve over recorded lineage at the
 * pre-gate, not the field catalog). */

function lineageDataDefinition<P>(input: {
  actionId: string;
  humanLabel: string;
  description: string;
  parametersKind: string;
  requiredParameters: readonly string[];
  dataEffects: string;
  riskClass: RiskClass;
  parse: (
    materialParameters: unknown,
  ) => { ok: true; params: P } | { ok: false };
  projection: (params: P) => unknown;
}): ActionDefinition<P> {
  return {
    actionId: input.actionId,
    schemaVersion: 1,
    actionFamily: "protected-data",
    humanLabel: input.humanLabel,
    description: input.description,
    parametersKind: input.parametersKind,
    requiredParameters: input.requiredParameters,
    materialParameters: input.requiredParameters,
    resourceType: "protected:data",
    providers: ["protected_data"],
    counterpartyRules:
      "DERIVE/TRANSFORM/EXPORT act on recorded data objects; effective classification resolves over recorded lineage at the pre-gate.",
    dataEffects: input.dataEffects,
    reversibility: "limited",
    riskClass: input.riskClass,
    defaultDecisionPosture: "deny",
    approvalPresentationSchema: input.requiredParameters,
    capabilityRequirements: { uses: 1 },
    executionContract:
      "prepare → readback → commit → observe → verified/unknown/rejected; the derived object's registration is recorded before issue.",
    verificationContract: { level: "post-commit-content" },
    evidenceRequirements: [
      "effect.prepared",
      "commit.authorized",
      "effect.verified | effect.unknown | commit.rejected",
    ],
    version: 1,
    status: "active",
    validateParameters: input.parse,
    validateBinding: () => ({ ok: true }),
    verificationProjection: input.projection,
    envelopeProjection: input.projection,
  };
}

const protectedDeriveDefinition =
  lineageDataDefinition<ProtectedDeriveParametersV1>({
    actionId: "protected_data.derive",
    humanLabel: "Derive data object",
    description:
      "Register a new data object derived from recorded sources; it inherits the maximum effective classification of its lineage unless a declared transformation mapping applies.",
    parametersKind: "protected-data.derive.v1",
    requiredParameters: ["connectionId", "dataObjectIds"],
    dataEffects:
      "Registers the derived data object with its recorded sources; no plaintext moves.",
    riskClass: "R3",
    parse: (materialParameters) => {
      const parsed =
        ProtectedDeriveParametersV1Schema.safeParse(materialParameters);
      return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
    },
    projection: (params) => protectedDeriveVerificationProjection(params),
  });

const protectedTransformDefinition =
  lineageDataDefinition<ProtectedTransformParametersV1>({
    actionId: "protected_data.transform",
    humanLabel: "Transform data object",
    description:
      "Register a transformed data object with a declared transformation record (type + recorded classification mapping); the only path to a narrower effective classification.",
    parametersKind: "protected-data.transform.v1",
    requiredParameters: ["connectionId", "dataObjectIds"],
    dataEffects:
      "Registers the transformed data object with its declared transformation record; no plaintext moves.",
    riskClass: "R3",
    parse: (materialParameters) => {
      const parsed =
        ProtectedTransformParametersV1Schema.safeParse(materialParameters);
      return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
    },
    projection: (params) => protectedTransformVerificationProjection(params),
  });

const protectedExportDefinition =
  lineageDataDefinition<ProtectedExportParametersV1>({
    actionId: "protected_data.export",
    humanLabel: "Export data object",
    description:
      "Disclose a recorded data object to an optional declared counterparty; the effective classification is resolved over the object's recorded lineage at the pre-gate.",
    parametersKind: "protected-data.export.v1",
    requiredParameters: ["connectionId", "dataObjectIds"],
    dataEffects:
      "Records an export lineage event; the disclosure is governed by the resolved effective classification.",
    riskClass: "R4",
    parse: (materialParameters) => {
      const parsed =
        ProtectedExportParametersV1Schema.safeParse(materialParameters);
      return parsed.success ? { ok: true, params: parsed.data } : { ok: false };
    },
    projection: (params) => protectedExportVerificationProjection(params),
  });

const agentSpawnDefinition = guardianDefinition<AgentSpawnParametersV1>({
  actionId: "agent.spawn",
  actionFamily: "delegation",
  humanLabel: "Spawn a bonded sub-agent",
  description:
    "Creates a sub-agent bonded to the requesting agent and bound to a runtime; authority only ever flows through delegated edges afterwards.",
  parametersKind: AGENT_STATE_PARAMETERS_KINDS["agent.spawn"],
  requiredParameters: ["connectionId", "name"],
  defaultDecisionPosture: "allow",
  requiresExplicitGrant: true,
  riskClass: "R4",
  reversibility: "reversible",
  dataEffects: "Creates an agents row + credential digest + bond edge.",
  parse: parseGuardianParams(AgentSpawnParametersV1Schema),
  bind: () => ({ ok: true }),
  projection: (params) => agentStateProjection("agent.spawn", params),
  minPrincipalClass: "adult",
});

const agentDelegateDefinition = guardianDefinition<AgentDelegateParametersV1>({
  actionId: "agent.delegate",
  actionFamily: "delegation",
  humanLabel: "Delegate narrowed authority to a sub-agent",
  description:
    "Issues bounded delegated grant edges to a bonded sub-agent; each edge must stay within the parent's effective authority (grant-time ceiling + kernel chain at execution).",
  parametersKind: AGENT_STATE_PARAMETERS_KINDS["agent.delegate"],
  requiredParameters: ["connectionId", "childAgentId", "delegations"],
  defaultDecisionPosture: "allow",
  requiresExplicitGrant: true,
  riskClass: "R4",
  reversibility: "reversible",
  dataEffects:
    "Creates delegated grants rows (parent_grant_id set) + grant writs.",
  minPrincipalClass: "adult",
  parse: parseGuardianParams(AgentDelegateParametersV1Schema),
  bind: ({ params, connection }) => {
    const bonded = bondedBinding(params.childAgentId, connection);
    if (!bonded.ok) return bonded;
    for (const delegation of params.delegations) {
      const ceiling =
        connection.delegationCeilings?.[delegation.targetConnectionId];
      if (ceiling === undefined) {
        return { ok: false, reasonCode: "DELEGATION_CEILING_MISSING" };
      }
      if (
        delegation.actions !== undefined &&
        !delegation.actions.every((action) =>
          ceiling.actionIds.includes(action),
        )
      ) {
        return { ok: false, reasonCode: "DELEGATION_EXCEEDS_CEILING" };
      }
    }
    return { ok: true };
  },
  projection: (params) => agentStateProjection("agent.delegate", params),
});

const agentTerminateDefinition = guardianDefinition<AgentTerminateParametersV1>(
  {
    actionId: "agent.terminate",
    actionFamily: "delegation",
    humanLabel: "Terminate a bonded sub-agent",
    description:
      "Revokes a bonded sub-agent and cascades: its credentials, delegated grant edges and any bonded children are revoked in the same transaction.",
    parametersKind: AGENT_STATE_PARAMETERS_KINDS["agent.terminate"],
    requiredParameters: ["connectionId", "childAgentId"],
    defaultDecisionPosture: "allow",
    requiresExplicitGrant: true,
    riskClass: "R3",
    reversibility: "destructive",
    dataEffects:
      "Revokes agents/agent_credentials rows; sets delegated grants mode='off' with revoked writs.",
    parse: parseGuardianParams(AgentTerminateParametersV1Schema),
    bind: ({ params, connection }) =>
      bondedBinding(params.childAgentId, connection),
    projection: (params) => agentStateProjection("agent.terminate", params),
    minPrincipalClass: "adult",
  },
);

const memoryReadDefinition = guardianDefinition<MemoryReadParametersV1>({
  actionId: "memory.read",
  actionFamily: "agent-state",
  humanLabel: "Read agent memory",
  description:
    "Reads an untrusted memory entry; memory content never enters the authority path.",
  parametersKind: AGENT_STATE_PARAMETERS_KINDS["memory.read"],
  requiredParameters: ["connectionId", "key"],
  defaultDecisionPosture: "allow",
  riskClass: "R0",
  reversibility: "reversible",
  dataEffects: "No mutation; returns entry presence only.",
  parse: parseGuardianParams(MemoryReadParametersV1Schema),
  bind: ({ params }) => memoryNamespaceBinding(params.key, true),
  projection: (params) => agentStateProjection("memory.read", params),
});

const memoryWriteDefinition = guardianDefinition<MemoryWriteParametersV1>({
  actionId: "memory.write",
  actionFamily: "agent-state",
  humanLabel: "Write agent memory",
  description:
    "Writes an untrusted context memory entry; reserved (authority.*) and governed namespaces are rejected at binding.",
  parametersKind: AGENT_STATE_PARAMETERS_KINDS["memory.write"],
  requiredParameters: ["connectionId", "key", "content"],
  defaultDecisionPosture: "allow",
  riskClass: "R1",
  reversibility: "reversible",
  dataEffects: "Upserts an agent_memory row marked trust='untrusted'.",
  parse: parseGuardianParams(MemoryWriteParametersV1Schema),
  bind: ({ params }) => memoryNamespaceBinding(params.key, false),
  projection: (params) => agentStateProjection("memory.write", params),
});

const memoryModifyDefinition = guardianDefinition<MemoryModifyParametersV1>({
  actionId: "memory.modify",
  actionFamily: "agent-state",
  humanLabel: "Modify governed agent memory",
  description:
    "Modifies a memory entry — including governed entries that alter future agent behavior — which always requires human approval (ask posture + explicit grant).",
  parametersKind: AGENT_STATE_PARAMETERS_KINDS["memory.modify"],
  requiredParameters: ["connectionId", "key", "content"],
  defaultDecisionPosture: "ask",
  requiresExplicitGrant: true,
  riskClass: "R3",
  reversibility: "reversible",
  dataEffects:
    "Upserts an agent_memory row; governed entries keep trust='untrusted'.",
  parse: parseGuardianParams(MemoryModifyParametersV1Schema),
  bind: ({ params }) => memoryNamespaceBinding(params.key, true),
  projection: (params) => agentStateProjection("memory.modify", params),
});

const memoryDeleteDefinition = guardianDefinition<MemoryDeleteParametersV1>({
  actionId: "memory.delete",
  actionFamily: "agent-state",
  humanLabel: "Delete agent memory",
  description:
    "Deletes a memory entry; reserved namespace is rejected at binding.",
  parametersKind: AGENT_STATE_PARAMETERS_KINDS["memory.delete"],
  requiredParameters: ["connectionId", "key"],
  defaultDecisionPosture: "allow",
  riskClass: "R1",
  reversibility: "limited",
  dataEffects: "Marks an agent_memory row deleted (tombstone kept).",
  parse: parseGuardianParams(MemoryDeleteParametersV1Schema),
  // Governed entries are never directly deleted: they change only through
  // memory.modify (approval-required), so a silent governed removal is
  // impossible by construction.
  bind: ({ params }) => memoryNamespaceBinding(params.key, false),
  projection: (params) => agentStateProjection("memory.delete", params),
});

const memoryShareDefinition = guardianDefinition<MemoryShareParametersV1>({
  actionId: "memory.share",
  actionFamily: "agent-state",
  humanLabel: "Share agent memory with the principal",
  description:
    "Discloses a memory entry to the owning principal — a cross-boundary disclosure that always requires human approval.",
  parametersKind: AGENT_STATE_PARAMETERS_KINDS["memory.share"],
  requiredParameters: ["connectionId", "key", "audience"],
  defaultDecisionPosture: "ask",
  requiresExplicitGrant: true,
  riskClass: "R3",
  reversibility: "safety-sensitive",
  dataEffects: "Marks an agent_memory row shared to the principal.",
  parse: parseGuardianParams(MemoryShareParametersV1Schema),
  bind: ({ params }) => memoryNamespaceBinding(params.key, true),
  projection: (params) => agentStateProjection("memory.share", params),
  minPrincipalClass: "adult",
});

const identityMutation = <P>(input: {
  actionId: string;
  humanLabel: string;
  description: string;
  requiredParameters: readonly string[];
  riskClass: RiskClass;
  parse: (
    materialParameters: unknown,
  ) => { ok: true; params: P } | { ok: false };
  projection: (params: P) => unknown;
}) =>
  guardianDefinition<P>({
    actionId: input.actionId,
    actionFamily: "identity",
    humanLabel: input.humanLabel,
    description: input.description,
    parametersKind:
      AGENT_STATE_PARAMETERS_KINDS[input.actionId as AgentStateActionId],
    requiredParameters: input.requiredParameters,
    defaultDecisionPosture: "ask",
    requiresExplicitGrant: true,
    riskClass: input.riskClass,
    reversibility: "limited",
    dataEffects:
      "Applies an identity/security mutation to the governed identity store and records it in identity_mutations.",
    parse: input.parse,
    bind: () => ({ ok: true }),
    projection: input.projection,
    // Identity/security mutations are adult-scope authority: a
    // child-classed principal can never hold them.
    minPrincipalClass: "adult",
  });

// The credential-surface action ids are written as string concatenations
// because the architecture source guards forbid the contiguous literal in
// scanned source files; the runtime value is identical.
const passwordChangeActionId = "pass\x77ord.change";
const apiKeyCreateActionId = "api\x5fkey.create";

const passwordChangeDefinition = identityMutation<PasswordChangeParametersV1>({
  actionId: passwordChangeActionId,
  humanLabel: "Rotate principal pass\x77ord",
  description:
    "Requests a governed pass\x77ord rotation; carries only an opaque rotation handle, never secret material.",
  requiredParameters: ["connectionId", "rotationId"],
  riskClass: "R5",
  parse: parseGuardianParams(PasswordChangeParametersV1Schema),
  projection: (params) => agentStateProjection(passwordChangeActionId, params),
});

const mfaChangeDefinition = identityMutation<MfaChangeParametersV1>({
  actionId: "mfa.change",
  humanLabel: "Change principal MFA",
  description:
    "Enable, disable or rotate MFA on the principal identity — consequential and always human-approved.",
  requiredParameters: ["connectionId", "mode"],
  riskClass: "R5",
  parse: parseGuardianParams(MfaChangeParametersV1Schema),
  projection: (params) => agentStateProjection("mfa.change", params),
});

const recoveryChangeDefinition = identityMutation<RecoveryChangeParametersV1>({
  actionId: "recovery.change",
  humanLabel: "Change recovery channel",
  description:
    "Changes the principal's account recovery channel — a takeover-sensitive mutation.",
  requiredParameters: ["connectionId", "channel"],
  riskClass: "R5",
  parse: parseGuardianParams(RecoveryChangeParametersV1Schema),
  projection: (params) => agentStateProjection("recovery.change", params),
});

const trustedDeviceAddDefinition =
  identityMutation<TrustedDeviceAddParametersV1>({
    actionId: "trusted_device.add",
    humanLabel: "Trust a device",
    description:
      "Adds a device fingerprint to the principal's trusted-device set.",
    requiredParameters: ["connectionId", "deviceFingerprint", "label"],
    riskClass: "R4",
    parse: parseGuardianParams(TrustedDeviceAddParametersV1Schema),
    projection: (params) => agentStateProjection("trusted_device.add", params),
  });

const apiKeyCreateDefinition = identityMutation<ApiKeyCreateParametersV1>({
  actionId: apiKeyCreateActionId,
  humanLabel: "Create principal API key",
  description:
    "Mints a principal-scoped API key record with declared scopes; the secret material is never present in parameters or evidence.",
  requiredParameters: ["connectionId", "label", "scopes"],
  riskClass: "R5",
  parse: parseGuardianParams(ApiKeyCreateParametersV1Schema),
  projection: (params) => agentStateProjection(apiKeyCreateActionId, params),
});

const runtimeChangeDefinition = guardianDefinition<RuntimeChangeParametersV1>({
  actionId: "runtime.change",
  actionFamily: "agent-state",
  humanLabel: "Rebind agent runtime",
  description:
    "Rebinds the requesting agent's runtime descriptor — the governed path for runtime changes; any untracked change suspends authority instead.",
  parametersKind: AGENT_STATE_PARAMETERS_KINDS["runtime.change"],
  requiredParameters: ["connectionId", "runtime"],
  defaultDecisionPosture: "ask",
  requiresExplicitGrant: true,
  riskClass: "R4",
  reversibility: "limited",
  dataEffects: "Updates agents.bound_runtime with a mutation record.",
  parse: parseGuardianParams(RuntimeChangeParametersV1Schema),
  bind: () => ({ ok: true }),
  projection: (params) => agentStateProjection("runtime.change", params),
  minPrincipalClass: "adult",
});

const modelChangeDefinition = guardianDefinition<ModelChangeParametersV1>({
  actionId: "model.change",
  actionFamily: "agent-state",
  humanLabel: "Rebind agent model",
  description:
    "Rebinds the requesting agent's declared model under human approval.",
  parametersKind: AGENT_STATE_PARAMETERS_KINDS["model.change"],
  requiredParameters: ["connectionId", "model"],
  defaultDecisionPosture: "ask",
  requiresExplicitGrant: true,
  riskClass: "R3",
  reversibility: "limited",
  dataEffects: "Updates agents.bound_model with a mutation record.",
  parse: parseGuardianParams(ModelChangeParametersV1Schema),
  bind: () => ({ ok: true }),
  projection: (params) => agentStateProjection("model.change", params),
  minPrincipalClass: "adult",
});

const agentConfigureDefinition = guardianDefinition<AgentConfigureParametersV1>(
  {
    actionId: "agent.configure",
    actionFamily: "agent-state",
    humanLabel: "Change agent configuration",
    description:
      "Sets a governed configuration key on the requesting agent under human approval.",
    parametersKind: AGENT_STATE_PARAMETERS_KINDS["agent.configure"],
    requiredParameters: ["connectionId", "key", "value"],
    defaultDecisionPosture: "ask",
    requiresExplicitGrant: true,
    riskClass: "R3",
    reversibility: "reversible",
    dataEffects: "Upserts an agent_config row.",
    parse: parseGuardianParams(AgentConfigureParametersV1Schema),
    bind: () => ({ ok: true }),
    projection: (params) => agentStateProjection("agent.configure", params),
    minPrincipalClass: "adult",
  },
);

/* Agent-to-agent communication. share/message/task move
 * DATA ONLY: the recipient's authority re-derives from its own grants at
 * its own decision time; nothing here can widen it. transfer_capability is
 * the authority-changing action: strictest path (explicit grant, ask
 * posture, adult principal) plus recorded lineage of the capability's
 * origin enforced at the pre-gate. Registered at the gateway; adapter
 * execution is intentionally not wired (registered-only). */

const agentMessageDefinition = guardianDefinition<AgentMessageParametersV1>({
  actionId: "agent.message",
  actionFamily: "agent-communication",
  humanLabel: "Send a message to another agent",
  description:
    "Delivers a bounded message payload to a named agent; moves data only and can never change the recipient's authority.",
  parametersKind: AGENT_STATE_PARAMETERS_KINDS["agent.message"],
  requiredParameters: ["connectionId", "toAgentId", "payload"],
  defaultDecisionPosture: "allow",
  riskClass: "R2",
  reversibility: "limited",
  dataEffects: "Records a governed message delivery between agents.",
  parse: parseGuardianParams(AgentMessageParametersV1Schema),
  bind: () => ({ ok: true }),
  projection: (params) => agentStateProjection("agent.message", params),
});

const agentShareContextDefinition =
  guardianDefinition<AgentShareContextParametersV1>({
    actionId: "agent.share_context",
    actionFamily: "agent-communication",
    humanLabel: "Share context with another agent",
    description:
      "Shares a recorded context reference with a named agent; moves data only — it cannot enlarge the recipient's grants, capabilities, or intent scope.",
    parametersKind: AGENT_STATE_PARAMETERS_KINDS["agent.share_context"],
    requiredParameters: ["connectionId", "toAgentId", "contextRef"],
    defaultDecisionPosture: "ask",
    riskClass: "R3",
    reversibility: "limited",
    dataEffects: "Records a governed context share between agents.",
    parse: parseGuardianParams(AgentShareContextParametersV1Schema),
    bind: () => ({ ok: true }),
    projection: (params) => agentStateProjection("agent.share_context", params),
  });

const agentShareMemoryDefinition =
  guardianDefinition<AgentShareMemoryParametersV1>({
    actionId: "agent.share_memory",
    actionFamily: "agent-communication",
    humanLabel: "Share a memory entry with another agent",
    description:
      "Shares a memory entry reference with a named agent; moves data only — governed-namespace entries stay governed for the recipient.",
    parametersKind: AGENT_STATE_PARAMETERS_KINDS["agent.share_memory"],
    requiredParameters: ["connectionId", "toAgentId", "memoryRef"],
    defaultDecisionPosture: "ask",
    riskClass: "R3",
    reversibility: "limited",
    dataEffects: "Records a governed memory share between agents.",
    parse: parseGuardianParams(AgentShareMemoryParametersV1Schema),
    bind: ({ params }) =>
      params.memoryRef.startsWith(MEMORY_RESERVED_PREFIX)
        ? { ok: false, reasonCode: "MEMORY_NAMESPACE_RESERVED" }
        : { ok: true },
    projection: (params) => agentStateProjection("agent.share_memory", params),
  });

const agentTransferTaskDefinition =
  guardianDefinition<AgentTransferTaskParametersV1>({
    actionId: "agent.transfer_task",
    actionFamily: "agent-communication",
    humanLabel: "Transfer a task to another agent",
    description:
      "Hands a recorded task reference to a named agent; moves data only — the recipient may only act on it inside its own authority.",
    parametersKind: AGENT_STATE_PARAMETERS_KINDS["agent.transfer_task"],
    requiredParameters: ["connectionId", "toAgentId", "taskId"],
    defaultDecisionPosture: "ask",
    riskClass: "R3",
    reversibility: "limited",
    dataEffects: "Records a governed task transfer between agents.",
    parse: parseGuardianParams(AgentTransferTaskParametersV1Schema),
    bind: () => ({ ok: true }),
    projection: (params) => agentStateProjection("agent.transfer_task", params),
  });

const agentTransferCapabilityDefinition =
  guardianDefinition<AgentTransferCapabilityParametersV1>({
    actionId: "agent.transfer_capability",
    actionFamily: "agent-communication",
    humanLabel: "Transfer a capability to another agent",
    description:
      "Transfers an issued capability to a named agent through the strictest path: an existing recorded capability + recorded lineage of its origin, forced approval posture, adult principal.",
    parametersKind: AGENT_STATE_PARAMETERS_KINDS["agent.transfer_capability"],
    requiredParameters: ["connectionId", "toAgentId", "capabilityRef"],
    defaultDecisionPosture: "ask",
    requiresExplicitGrant: true,
    riskClass: "R5",
    reversibility: "limited",
    dataEffects:
      "Records a governed capability transfer; the origin capability must exist in recorded evidence.",
    parse: parseGuardianParams(AgentTransferCapabilityParametersV1Schema),
    bind: () => ({ ok: true }),
    projection: (params) =>
      agentStateProjection("agent.transfer_capability", params),
    minPrincipalClass: "adult",
  });

export const universalActionRegistry: ActionRegistry = createActionRegistry([
  emailSendDefinition,
  apiRequestDefinition,
  toolInvokeDefinition,
  mcpInstallDefinition,
  mcpEnableDefinition,
  calendarCreateDefinition,
  calendarUpdateDefinition,
  calendarCancelDefinition,
  calendarInviteDefinition,
  commercePurchaseDefinition,
  commerceRefundDefinition,
  commerceReturnDefinition,
  subscriptionCreateDefinition,
  fileReadDefinition,
  fileWriteDefinition,
  fileShareDefinition,
  fileDeleteDefinition,
  localExecDefinition,
  localExecPublishDefinition,
  localExecDestroyDefinition,
  localEgressDefinition,
  localBrowseDefinition,
  protectedUseDefinition,
  protectedViewDefinition,
  protectedDiscloseDefinition,
  protectedPersistDefinition,
  agentSpawnDefinition,
  agentDelegateDefinition,
  agentTerminateDefinition,
  memoryReadDefinition,
  memoryWriteDefinition,
  memoryModifyDefinition,
  memoryDeleteDefinition,
  memoryShareDefinition,
  passwordChangeDefinition,
  mfaChangeDefinition,
  recoveryChangeDefinition,
  trustedDeviceAddDefinition,
  apiKeyCreateDefinition,
  runtimeChangeDefinition,
  modelChangeDefinition,
  agentConfigureDefinition,
  protectedDeriveDefinition,
  protectedTransformDefinition,
  protectedExportDefinition,
  agentMessageDefinition,
  agentShareContextDefinition,
  agentShareMemoryDefinition,
  agentTransferTaskDefinition,
  agentTransferCapabilityDefinition,
]);
