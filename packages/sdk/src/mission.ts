// Generated file — do not edit.
import { createPublicKey, verify as edVerify } from "node:crypto";

import { canonicalJson, sha256Text } from "./contracts/index.js";
import { receiptKeyIdFromX } from "./evidence/receipt.js";

import {
  createGuardianClient,
  type GuardianClient,
  type GuardianClientConfig,
  type GuardianInvocation,
  type GuardianRequestResult,
} from "./client.js";

/**
 * Missions: a person approves one mission card (an agent, a budget, an end
 * time, the connections, actions and sites it covers). The approval issues
 * the agent a mission credential. Requests made with it are decided by
 * Guardian against the mission's limits; inside them, no new approval is
 * needed (sending email still asks).
 *
 * `createMissionClient` sends each request with the mission credential.
 * When Guardian refuses it because the mission does not cover the
 * action (a different action or site, over a limit, past the end, the
 * mission cancelled), the same action is sent again as a normal request
 * with the agent's own credential, where the person's usual permissions
 * apply: it asks the person or is refused, as without a mission. A gap
 * costs one extra approval request, never an unapproved action.
 *
 * Claims, executes and record lookups go to the credential that made the
 * request. A request id this client did not make is refused.
 */

/**
 * Refusals of a mission request that mean "the mission does not cover
 * this", so the action falls back to a normal request.
 *
 * Hosted Guardian answers every authorization refusal with the public code
 * `NOT_AUTHORIZED` (the detailed reason is not published), so that code
 * falls back too. The fallback is decided by the person's usual
 * permissions with every check still applied, a pause included, so it can
 * cost one extra approval request, never an unapproved action. Guardian
 * unreachable, a malformed or conflicting request, or an approval already
 * required are returned as they are.
 */
export const MISSION_FALLBACK_REASONS: ReadonlySet<string> = new Set([
  // Hosted Guardian's public code for any authorization refusal.
  "NOT_AUTHORIZED",
  "AUTHORITY_CHAIN_MISSING",
  "ACTION_NOT_ALLOWED",
  "RESOURCE_NOT_ALLOWED",
  "ADAPTER_NOT_ALLOWED",
  "INTERFACE_NOT_ALLOWED",
  "VALUE_LIMIT_EXCEEDED",
  "USE_LIMIT_EXCEEDED",
  "MERCHANT_NOT_ALLOWED",
  "CATEGORY_NOT_ALLOWED",
  "RECURRENCE_NOT_ALLOWED",
  "BUDGET_NOT_FOUND",
  "BUDGET_SCOPE_MISMATCH",
  "BUDGET_NOT_ACTIVE",
  "BUDGET_EXPIRED",
  "BUDGET_EXCEEDED",
  "TRANSACTION_LIMIT_EXCEEDED",
  "GRANT_NOT_ACTIVE",
  "GRANT_REVOKED",
  "GRANT_NOT_YET_VALID",
  "GRANT_EXPIRED",
  "AGENT_NOT_ACTIVE",
  // The mission credential no longer works (the mission ended).
  "UNAUTHENTICATED",
]);

export type MissionRoute = "mission" | "standing";

export type MissionRequestResult = GuardianRequestResult &
  Readonly<{
    /** Which credential decided: the mission's, or the agent's own. */
    via: MissionRoute;
    /** The mission's refusal, when the request fell back. */
    missionReasonCode?: string;
  }>;

export interface MissionClient extends Omit<GuardianClient, "request"> {
  request(invocation: GuardianInvocation): Promise<MissionRequestResult>;
  /** Which credential made a request this client sent, if it sent it. */
  routeOf(requestId: string): MissionRoute | undefined;
}

export type MissionClientConfig = Readonly<{
  baseUrl: string;
  /** The agent's own credential (gak_…): the fallback. */
  agentCredential: string;
  /** The mission credential the approval issued (shown once). */
  missionCredential: string;
  adapterId?: string;
  fetch?: typeof fetch;
  /** Requests remembered for claim and execute (default 10,000). */
  maxTrackedRequests?: number;
}>;

/** True when a mission refusal means the mission does not cover it. */
export function missionFallsBack(result: GuardianRequestResult): boolean {
  if (result.ok) {
    return (
      result.decision === "DENY" &&
      typeof result.reasonCode === "string" &&
      MISSION_FALLBACK_REASONS.has(result.reasonCode)
    );
  }
  return MISSION_FALLBACK_REASONS.has(result.reasonCode);
}

export function createMissionClient(
  config: MissionClientConfig,
): MissionClient {
  if (!config.missionCredential || !config.agentCredential) {
    throw new TypeError("a mission client needs both credentials");
  }
  if (config.missionCredential === config.agentCredential) {
    throw new TypeError("the mission credential must differ from the agent's");
  }
  const shared: Omit<GuardianClientConfig, "credential"> = {
    baseUrl: config.baseUrl,
    ...(config.adapterId === undefined ? {} : { adapterId: config.adapterId }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  };
  const clients: Readonly<Record<MissionRoute, GuardianClient>> = {
    mission: createGuardianClient({
      ...shared,
      credential: config.missionCredential,
    }),
    standing: createGuardianClient({
      ...shared,
      credential: config.agentCredential,
    }),
  };
  const limit = config.maxTrackedRequests ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("maxTrackedRequests must be a positive whole number");
  }
  const routes = new Map<string, MissionRoute>();
  const remember = (requestId: string | undefined, via: MissionRoute) => {
    if (typeof requestId !== "string" || requestId === "") return;
    routes.delete(requestId);
    routes.set(requestId, via);
    while (routes.size > limit) {
      const oldest = routes.keys().next().value;
      if (oldest === undefined) break;
      routes.delete(oldest);
    }
  };
  const unknown = { ok: false as const, reasonCode: "MISSION_REQUEST_UNKNOWN" };

  return {
    async request(invocation) {
      const tried = await clients.mission.request(invocation);
      remember(tried.requestId, "mission");
      if (!missionFallsBack(tried)) return { ...tried, via: "mission" };
      const second = await clients.standing.request(invocation);
      remember(second.requestId, "standing");
      return {
        ...second,
        via: "standing",
        missionReasonCode: tried.reasonCode ?? "DENIED",
      };
    },
    routeOf(requestId) {
      return routes.get(requestId);
    },
    async claim(requestId) {
      const via = routes.get(requestId);
      return via === undefined ? unknown : clients[via].claim(requestId);
    },
    async execute(input) {
      const via = routes.get(input.requestId);
      return via === undefined ? unknown : clients[via].execute(input);
    },
    async portableReceipt(requestId) {
      const via = routes.get(requestId);
      return via === undefined
        ? unknown
        : clients[via].portableReceipt(requestId);
    },
    async receipts(requestId) {
      const via = routes.get(requestId);
      return via === undefined ? unknown : clients[via].receipts(requestId);
    },
  };
}

// ---------------------------------------------------------------------------
// The signed mission record
// ---------------------------------------------------------------------------

/**
 * The signed record of a mission approval: the card the person saw, its
 * limits, the permissions the approval issued, who approved it and when.
 * It is signed with the same key as Guardian's signed decision records,
 * under its own domain, so it is checked with the same published key set
 * (`fetchReceiptVerificationKeys`), and it can never pass as a decision
 * record.
 */
export const MISSION_RECORD_SCHEMA = "guardian.mission-record.v1";
export const MISSION_RECORD_DOMAIN = "odingard.guardian.mission-record.v1";
const MISSION_CARD_SCHEMA = "guardian.mission.v1";

export type MissionRecordVerification =
  | Readonly<{ valid: true; keyId: string }>
  | Readonly<{
      valid: false;
      reasonCode:
        | "RECORD_MALFORMED"
        | "RECORD_KEY_UNKNOWN"
        | "RECORD_SIGNATURE_INVALID"
        | "RECORD_DIGEST_MISMATCH";
    }>;

const BODY_KEYS = [
  "schema",
  "missionId",
  "tenantId",
  "principalId",
  "agentId",
  "title",
  "card",
  "limits",
  "grants",
  "stillAsks",
  "cardDigest",
  "approval",
] as const;

const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value)) as unknown;

/**
 * Checks a signed mission record offline against Guardian's key set
 * (`{ keys: [...] }`, or the result of `fetchReceiptVerificationKeys`).
 * Valid means: Guardian's key signed exactly this record, and the card
 * digest is the digest of the card, limits and permissions it carries.
 * Anything unreadable is invalid.
 */
export function verifyMissionRecordOffline(
  record: unknown,
  keys: unknown,
): MissionRecordVerification {
  const malformed = { valid: false, reasonCode: "RECORD_MALFORMED" } as const;
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return malformed;
  }
  const value = record as Record<string, unknown>;
  const bodyKeys = Object.keys(value).filter((key) => key !== "proof");
  if (
    bodyKeys.length !== BODY_KEYS.length ||
    !BODY_KEYS.every((key) => bodyKeys.includes(key))
  ) {
    return malformed;
  }
  const proof = value.proof as Record<string, unknown> | null | undefined;
  const limits = value.limits as Record<string, unknown> | null | undefined;
  if (
    value.schema !== MISSION_RECORD_SCHEMA ||
    typeof value.cardDigest !== "string" ||
    !Array.isArray(value.grants) ||
    !Array.isArray(value.stillAsks) ||
    limits === null ||
    typeof limits !== "object" ||
    proof === null ||
    typeof proof !== "object" ||
    Object.keys(proof).length !== 5 ||
    proof.algorithm !== "Ed25519" ||
    proof.canonicalization !== "guardian-canonical-json.v1" ||
    proof.domain !== MISSION_RECORD_DOMAIN ||
    typeof proof.keyId !== "string" ||
    typeof proof.signature !== "string"
  ) {
    return malformed;
  }
  const keySet =
    keys !== null && typeof keys === "object" && "ok" in keys
      ? (keys as { ok: unknown; keys?: unknown }).ok === true
        ? (keys as { keys?: unknown }).keys
        : null
      : keys;
  const list = (keySet as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return malformed;
  const jwk = list.find(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { kid?: unknown }).kid === proof.keyId,
  ) as { kty?: unknown; crv?: unknown; x?: unknown } | undefined;
  if (
    jwk === undefined ||
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    receiptKeyIdFromX(jwk.x) !== proof.keyId
  ) {
    return { valid: false, reasonCode: "RECORD_KEY_UNKNOWN" };
  }
  const body = Object.fromEntries(BODY_KEYS.map((key) => [key, value[key]]));
  let signed = false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: jwk.x },
      format: "jwk",
    });
    signed = edVerify(
      null,
      Buffer.from(
        canonicalJson({ domain: MISSION_RECORD_DOMAIN, record: plain(body) }),
        "utf8",
      ),
      key,
      Buffer.from(proof.signature, "base64url"),
    );
  } catch {
    signed = false;
  }
  if (!signed) return { valid: false, reasonCode: "RECORD_SIGNATURE_INVALID" };
  let digest: string;
  try {
    digest = sha256Text(
      canonicalJson({
        schema: MISSION_CARD_SCHEMA,
        card: plain(value.card),
        endsAtEpochMs: limits.endsAtEpochMs,
        currency: limits.currency,
        limitCents: limits.limitCents,
        actionLimit: limits.actionLimit,
        maxSubSeats: limits.maxSubSeats,
        grants: plain(value.grants),
        stillAsks: value.stillAsks,
      }),
    );
  } catch {
    return malformed;
  }
  if (digest !== value.cardDigest) {
    return { valid: false, reasonCode: "RECORD_DIGEST_MISMATCH" };
  }
  return { valid: true, keyId: proof.keyId };
}
