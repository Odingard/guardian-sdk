// Generated file — do not edit.
import {
  universalActionRegistry,
  type ActionDefinition,
  type ActionRegistry,
} from "./action-registry.js";
import type { ActionAuthorityFacts } from "./commerce.js";
import type { TaskId } from "./identifiers.js";

export type ActionParameterValidation =
  | {
      ok: true;
      kind: string;
      definition: ActionDefinition;
      params: unknown;
    }
  | { ok: true; kind: "generic" }
  | { ok: false };

const FACT_KEYS = [
  "valueCents",
  "merchantId",
  "merchantCategory",
  "recurring",
  "taskId",
] as const;

type FactInput = {
  valueCents?: number | undefined;
  merchantId?: string | undefined;
  merchantCategory?: string | undefined;
  recurring?: boolean | undefined;
  taskId?: TaskId | undefined;
};

/**
 * The envelope's declared monetary facts must equal the facts the registered
 * definition derives from its validated parameters. A definition without an
 * authorityFacts hook accepts none of them — monetary facts fail closed.
 */
function factsMatch(input: FactInput, expected: ActionAuthorityFacts): boolean {
  for (const key of FACT_KEYS) {
    const want = expected[key];
    const got = input[key];
    if (want === undefined) {
      if (got !== undefined) return false;
    } else if (got !== want) {
      return false;
    }
  }
  return true;
}

/**
 * Generic parameter gate: resolves the action
 * through the Universal Action Registry and applies only action-agnostic
 * checks — capability uses, declared monetary facts vs derived facts, and
 * the `${resourceType}:${connectionId}` resource binding. Action semantics
 * live in the registered definition's hooks.
 */
export function validateActionParameters(
  input: {
    action: string;
    resource: string;
    uses: number;
    materialParameters: unknown;
  } & FactInput,
  registry: ActionRegistry = universalActionRegistry,
): ActionParameterValidation {
  const definition = registry.get(input.action);
  if (definition === undefined || definition.status !== "active") {
    return { ok: true, kind: "generic" };
  }
  if (input.uses !== definition.capabilityRequirements.uses) {
    return { ok: false };
  }
  const parsed = definition.validateParameters(input.materialParameters);
  if (!parsed.ok) return { ok: false };
  const connectionId = (parsed.params as { connectionId?: unknown })
    .connectionId;
  if (
    typeof connectionId !== "string" ||
    input.resource !== `${definition.resourceType}:${connectionId}`
  ) {
    return { ok: false };
  }
  const expected: ActionAuthorityFacts =
    definition.authorityFacts === undefined
      ? {}
      : definition.authorityFacts(parsed.params as never);
  if (!factsMatch(input, expected)) {
    return { ok: false };
  }
  return {
    ok: true,
    kind: definition.parametersKind,
    definition,
    params: parsed.params,
  };
}
