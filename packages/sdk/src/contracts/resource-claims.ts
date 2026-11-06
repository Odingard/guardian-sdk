// Generated file — do not edit.
import { z } from "zod";

import { apiEndpointWithinAllowlist } from "./api.js";
import { canonicalJson } from "./canonical-json.js";

/**
 * Resource Claims v1 (`guardian.resource-claim.v1`).
 *
 * The universal resource model every action binding can be projected into:
 * a leased connection's provider, owner, classifications, capabilities,
 * relationships, attributes, constraints, region, assurance and version.
 * Domain-specific binding facts (mailbox address, endpoint allowlist, tool
 * catalog, path allowlists, delegation ceilings) keep their existing fields —
 * `claimFromConnectionFacts` is the documented shim that derives the claim
 * while the legacy fields stay authoritative for built-in definitions.
 * Pack-defined actions evaluate `resource.*` facts declaratively through
 * claim rules; nothing in this file executes pack-supplied logic.
 */

export const RESOURCE_CLAIM_FORMAT = "guardian.resource-claim.v1";

export const CLAIM_MAX_ATTRIBUTES = 32;
export const CLAIM_MAX_CONSTRAINTS = 32;
export const CLAIM_MAX_CLASSIFICATIONS = 32;
export const CLAIM_MAX_CAPABILITIES = 128;
export const CLAIM_MAX_RELATIONSHIPS = 64;
export const CLAIM_ATTRIBUTE_MAX_BYTES = 8_192;
export const CLAIM_RULES_MAX = 32;
export const BINDING_RULES_MAX = 16;

/** A bounded canonical JSON fact: no cycles, accessors or exotic prototypes. */
export const ClaimFactSchema = z.unknown().refine(
  (value) => {
    try {
      return canonicalJson(value).length <= CLAIM_ATTRIBUTE_MAX_BYTES;
    } catch {
      return false;
    }
  },
  { message: "claim fact must be bounded canonical JSON" },
);
export type ClaimFact = z.infer<typeof ClaimFactSchema>;

export const ClaimPathSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(
    /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/,
    "claim paths are lowerCamelCase dotted identifiers",
  );
export type ClaimPath = z.infer<typeof ClaimPathSchema>;

export const ResourceRelationshipSchema = z
  .object({
    kind: z.string().min(1).max(64),
    target: z.string().min(1).max(256),
  })
  .strict();
export type ResourceRelationship = z.infer<typeof ResourceRelationshipSchema>;

export const ResourceClaimSchema = z
  .object({
    claim: z.literal(RESOURCE_CLAIM_FORMAT),
    type: z.string().min(1).max(128),
    id: z.string().min(1).max(256),
    provider: z.string().min(1).max(64),
    owner: z.string().min(1).max(128),
    classifications: z
      .array(z.string().min(1).max(64))
      .max(CLAIM_MAX_CLASSIFICATIONS),
    capabilities: z
      .array(z.string().min(1).max(128))
      .max(CLAIM_MAX_CAPABILITIES),
    relationships: z
      .array(ResourceRelationshipSchema)
      .max(CLAIM_MAX_RELATIONSHIPS),
    attributes: z.record(z.string().max(64), ClaimFactSchema),
    constraints: z.record(z.string().max(64), ClaimFactSchema),
    region: z.string().max(64).optional(),
    assurance: z.string().max(64).optional(),
    version: z.number().int().positive(),
  })
  .strict();
export type ResourceClaim = z.infer<typeof ResourceClaimSchema>;

/**
 * Declarative rule over `resource.*` facts. Ops:
 * - `eq` / `neq`: canonical equality / inequality of the resolved fact
 * - `in`: the resolved scalar fact is a member of the rule's value list
 * - `includes`: the resolved list fact contains the rule's value
 * - `excludes`: the resolved list fact does not contain the rule's value
 * A rule whose path resolves to `undefined` fails closed.
 */
export const ClaimRuleSchema = z
  .object({
    path: ClaimPathSchema,
    op: z.enum(["eq", "neq", "in", "includes", "excludes"]),
    value: ClaimFactSchema,
  })
  .strict();
export type ClaimRule = z.infer<typeof ClaimRuleSchema>;

/**
 * Declarative binding rule: a material-parameter field checked against a
 * resolved claim list (or the scalar claim fact). Ops:
 * - `within`: the param is an endpoint inside the claim's allowlist entries
 *   (same prefix+host semantics as the api.endpoint allowlist binding)
 * - `memberOf`: the param string equals one of the claim list's entries
 */
export const BindingRuleSchema = z
  .object({
    field: z.string().min(1).max(64),
    claim: ClaimPathSchema,
    op: z.enum(["within", "memberOf"]),
  })
  .strict();
export type BindingRule = z.infer<typeof BindingRuleSchema>;

/** The connection facts the claims shim projects (mirrors the binding shape). */
export type ConnectionClaimFacts = Readonly<{
  provider: string;
  connectionId?: string;
  principalId?: string;
  mailboxAddress?: string;
  endpointAllowlist?: readonly string[];
  toolServer?: Readonly<{
    serverName: string;
    serverVersion: string;
    tools: readonly { name: string }[];
  }>;
  enabledToolNames?: readonly string[];
  calendarId?: string;
  pathAllowlist?: readonly string[];
  shareAllowlist?: readonly string[];
  protectedCatalog?: readonly {
    fieldRef: string;
    allowUse: boolean;
    allowView: boolean;
  }[];
  bondedSubAgentIds?: readonly string[];
  delegationCeilings?: Readonly<
    Record<string, { actionIds: readonly string[] }>
  >;
}>;

const CLAIM_TYPE_BY_PROVIDER: Readonly<Record<string, string>> = {
  gmail: "communication.mailbox",
  graph: "communication.mailbox",
  clawlink: "communication.mailbox",
  api: "network.endpoint-set",
  gcalendar: "calendar.calendar",
  file: "storage.file-root",
  protected_data: "data.protected-catalog",
  tool: "tool.server",
  guardian: "authority.delegation",
};

/**
 * The migration shim: projects today's vertical binding fields into a
 * universal Resource Claim. Built-in definitions keep reading the legacy
 * fields; pack-defined actions read only the claim.
 */
export function claimFromConnectionFacts(
  connection: ConnectionClaimFacts,
): ResourceClaim {
  const type =
    CLAIM_TYPE_BY_PROVIDER[connection.provider] ?? "resource.external";
  const classifications: string[] = ["leased-connection"];
  const capabilities: string[] = [];
  const relationships: ResourceRelationship[] = [];
  const attributes: Record<string, unknown> = {};
  const constraints: Record<string, unknown> = {};
  if (connection.mailboxAddress !== undefined) {
    attributes.mailboxAddress = connection.mailboxAddress;
  }
  if (connection.endpointAllowlist !== undefined) {
    constraints.endpointAllowlist = [...connection.endpointAllowlist];
  }
  if (connection.toolServer !== undefined) {
    attributes.toolServerName = connection.toolServer.serverName;
    attributes.toolServerVersion = connection.toolServer.serverVersion;
    for (const tool of connection.toolServer.tools) {
      capabilities.push(tool.name);
    }
  }
  if (connection.enabledToolNames !== undefined) {
    constraints.enabledToolNames = [...connection.enabledToolNames];
  }
  if (connection.calendarId !== undefined) {
    attributes.calendarId = connection.calendarId;
  }
  if (connection.pathAllowlist !== undefined) {
    constraints.pathAllowlist = [...connection.pathAllowlist];
  }
  if (connection.shareAllowlist !== undefined) {
    constraints.shareAllowlist = [...connection.shareAllowlist];
  }
  if (connection.protectedCatalog !== undefined) {
    classifications.push("protected-data");
    attributes.protectedCatalogFields = connection.protectedCatalog.map(
      (entry) => entry.fieldRef,
    );
    constraints.protectedCatalogAllowUse = connection.protectedCatalog
      .filter((entry) => entry.allowUse)
      .map((entry) => entry.fieldRef);
    constraints.protectedCatalogAllowView = connection.protectedCatalog
      .filter((entry) => entry.allowView)
      .map((entry) => entry.fieldRef);
  }
  if (connection.bondedSubAgentIds !== undefined) {
    for (const target of connection.bondedSubAgentIds) {
      relationships.push({ kind: "bonded-sub-agent", target });
    }
  }
  if (connection.delegationCeilings !== undefined) {
    constraints.delegationCeilings = connection.delegationCeilings;
  }
  return ResourceClaimSchema.parse({
    claim: RESOURCE_CLAIM_FORMAT,
    type,
    id: connection.connectionId ?? "connection:unbound",
    provider: connection.provider,
    owner: connection.principalId ?? "principal:unbound",
    classifications,
    capabilities: capabilities.slice(0, CLAIM_MAX_CAPABILITIES),
    relationships: relationships.slice(0, CLAIM_MAX_RELATIONSHIPS),
    attributes,
    constraints,
    version: 1,
  });
}

/** Resolves a `resource.*` dotted path to the claim fact (or undefined). */
export function resolveClaimPath(claim: ResourceClaim, path: string): unknown {
  const [head, ...rest] = path.split(".");
  switch (head) {
    case "type":
      return rest.length === 0 ? claim.type : undefined;
    case "id":
      return rest.length === 0 ? claim.id : undefined;
    case "provider":
      return rest.length === 0 ? claim.provider : undefined;
    case "owner":
      return rest.length === 0 ? claim.owner : undefined;
    case "classifications":
      return rest.length === 0 ? claim.classifications : undefined;
    case "capabilities":
      return rest.length === 0 ? claim.capabilities : undefined;
    case "region":
      return rest.length === 0 ? claim.region : undefined;
    case "assurance":
      return rest.length === 0 ? claim.assurance : undefined;
    case "version":
      return rest.length === 0 ? claim.version : undefined;
    case "attributes":
    case "constraints":
      if (rest.length !== 1) return undefined;
      return (head === "attributes" ? claim.attributes : claim.constraints)[
        rest[0]!
      ];
    case "relationships":
      if (rest.length !== 1) return undefined;
      return claim.relationships
        .filter((edge) => edge.kind === rest[0])
        .map((edge) => edge.target);
    default:
      return undefined;
  }
}

const canonicalEqual = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
};

const asStringList = (fact: unknown): readonly string[] | undefined =>
  Array.isArray(fact) && fact.every((entry) => typeof entry === "string")
    ? (fact as readonly string[])
    : undefined;

/**
 * Evaluates a declarative claim policy over resolved `resource.*` facts.
 * Deterministic and bounded: no pack-supplied code runs — rules are data.
 */
export function evaluateClaimRules(
  claim: ResourceClaim,
  rules: readonly ClaimRule[],
): { ok: true } | { ok: false; reasonCode: string; path: string } {
  for (const rule of rules) {
    const fact = resolveClaimPath(claim, rule.path);
    const hold = (() => {
      if (fact === undefined) return false;
      switch (rule.op) {
        case "eq":
          return canonicalEqual(fact, rule.value);
        case "neq":
          return !canonicalEqual(fact, rule.value);
        case "in": {
          const options = Array.isArray(rule.value) ? rule.value : undefined;
          return (
            options !== undefined &&
            options.some((option) => canonicalEqual(fact, option))
          );
        }
        case "includes": {
          const list = asStringList(fact);
          return (
            list !== undefined &&
            list.some((entry) => canonicalEqual(entry, rule.value))
          );
        }
        case "excludes": {
          const list = asStringList(fact);
          return (
            list !== undefined &&
            !list.some((entry) => canonicalEqual(entry, rule.value))
          );
        }
      }
    })();
    if (!hold) {
      return { ok: false, reasonCode: "CLAIM_RULE_FAILED", path: rule.path };
    }
  }
  return { ok: true };
}

/**
 * Evaluates declarative binding rules: a material-parameter value checked
 * against a resolved claim fact. Fails closed on a missing or mistyped fact.
 */
export function evaluateBindingRules(
  claim: ResourceClaim,
  params: Record<string, unknown>,
  rules: readonly BindingRule[],
): { ok: true } | { ok: false; reasonCode: string; field: string } {
  for (const rule of rules) {
    const fact = resolveClaimPath(claim, rule.claim);
    const value = params[rule.field];
    if (typeof value !== "string") {
      return {
        ok: false,
        reasonCode: "BINDING_RULE_FAILED",
        field: rule.field,
      };
    }
    const list = asStringList(fact);
    if (list === undefined) {
      return {
        ok: false,
        reasonCode: "BINDING_RULE_FAILED",
        field: rule.field,
      };
    }
    const hold =
      rule.op === "within"
        ? apiEndpointWithinAllowlist(value, list)
        : list.includes(value);
    if (!hold) {
      return {
        ok: false,
        reasonCode: "BINDING_RULE_FAILED",
        field: rule.field,
      };
    }
  }
  return { ok: true };
}
