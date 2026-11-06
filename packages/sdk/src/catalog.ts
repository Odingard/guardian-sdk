import catalog from "./catalog/public-catalog.v1.json" with { type: "json" };

/**
 * Guardian's public catalog metadata, generated from Guardian's
 * catalog (`@odingard/guardian-catalog`) verbatim. Declarative
 * only: reading it grants nothing — every action is still decided at
 * runtime by the Guardian authority path under a human's policy.
 */
export type GuardianPublicCatalog = typeof catalog;
export type GuardianCatalogVertical =
  GuardianPublicCatalog["verticals"][number];
export type GuardianCatalogAgentSystem =
  GuardianPublicCatalog["agentSystems"][number];

export const guardianCatalog: GuardianPublicCatalog = catalog;

/** Verticals whose catalog rows include `actionId`, with honest maturity. */
export function verticalsForAction(
  actionId: string,
): readonly GuardianCatalogVertical[] {
  return catalog.verticals.filter((v) =>
    v.actions.some((a) => a.actionId === actionId),
  );
}

export function findAgentSystem(
  systemPackId: string,
): GuardianCatalogAgentSystem | undefined {
  return catalog.agentSystems.find((s) => s.systemPackId === systemPackId);
}
