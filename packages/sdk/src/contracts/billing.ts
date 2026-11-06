// Generated file — do not edit.
import { z } from "zod";

// Canonical Guardian pricing + entitlement contract.
// Every consumer — the control-plane API, the console, docs, and the public
// SDK README — reads plan identity, display pricing, and limits from here.
// Pricing upgrades capacity, never safety: ALLOW / ASK / DENY, receipts,
// revocation, and enforcement are identical on every plan.

export const BillingPlanIdSchema = z.enum([
  "free",
  "personal",
  "family",
  "developer",
  "pilot",
]);
export type BillingPlanId = z.infer<typeof BillingPlanIdSchema>;

export const CheckoutIntervalSchema = z.enum(["month", "year"]);
export type CheckoutInterval = z.infer<typeof CheckoutIntervalSchema>;

export type PlanLimits = Readonly<{
  connections: number;
  agents: number;
  protectedActionsPerMonth: number;
}>;

// Plan capacity limits. `pilot` is the non-purchasable fallback for tenants
// that predate billing (a missing entitlement row resolves here so they are
// never more restricted than when billing shipped).
// Family and Developer carry the limits the codebase already enforced for the
// retired Growth and Business tiers; no authoritative Family/Developer limits
// exist yet in product docs (tracked as an open entitlement question).
export const PLAN_LIMITS: Record<BillingPlanId, PlanLimits> = {
  free: { connections: 1, agents: 1, protectedActionsPerMonth: 50 },
  personal: {
    connections: 100,
    agents: 100,
    protectedActionsPerMonth: 50_000,
  },
  family: {
    connections: 50,
    agents: 250,
    protectedActionsPerMonth: 500_000,
  },
  developer: {
    connections: 250,
    agents: 1_000,
    protectedActionsPerMonth: 5_000_000,
  },
  pilot: {
    connections: 100,
    agents: 100,
    protectedActionsPerMonth: 50_000,
  },
};

export const PURCHASABLE_PLANS = [
  "personal",
  "family",
  "developer",
] as const satisfies readonly BillingPlanId[];
export type PurchasablePlan = (typeof PURCHASABLE_PLANS)[number];

// Canonical published pricing. `monthlyUsd`/`annualUsd` are whole-dollar
// amounts shown to customers; `usageMetered` marks Developer, which adds
// metered protected-action usage on top of the $99 base subscription.
export type PlanPricing = Readonly<{
  displayName: string;
  monthlyUsd: number | null;
  annualUsd: number | null;
  usageMetered: boolean;
  tagline: string;
}>;

export const PLAN_PRICING: Record<BillingPlanId, PlanPricing> = {
  free: {
    displayName: "Free",
    monthlyUsd: 0,
    annualUsd: null,
    usageMetered: false,
    tagline: "No card required — the same core authority protections",
  },
  personal: {
    displayName: "Personal",
    monthlyUsd: 19,
    annualUsd: 190,
    usageMetered: false,
    tagline: "One person, multiple agents, approvals, revocation, evidence",
  },
  family: {
    displayName: "Family",
    monthlyUsd: 39,
    annualUsd: 390,
    usageMetered: false,
    tagline: "Shared household resources, recovery, shared administration",
  },
  developer: {
    displayName: "Developer",
    monthlyUsd: 99,
    annualUsd: null,
    usageMetered: true,
    tagline: "Sandbox, integration tools, production enforcement + usage",
  },
  pilot: {
    displayName: "Pilot",
    monthlyUsd: null,
    annualUsd: null,
    usageMetered: false,
    tagline: "By invitation — not purchasable",
  },
};

// Intervals a plan can be checked out at. Developer is monthly-only: its
// usage component bills monthly, so no annual price exists.
export function purchasableIntervals(
  plan: BillingPlanId,
): readonly CheckoutInterval[] {
  return plan === "developer"
    ? ["month"]
    : plan === "free" || plan === "pilot"
      ? []
      : ["month", "year"];
}

export function formatPlanPrice(
  plan: BillingPlanId,
  interval: CheckoutInterval,
): string {
  const pricing = PLAN_PRICING[plan];
  const usd = interval === "year" ? pricing.annualUsd : pricing.monthlyUsd;
  if (usd === null) return "";
  const per = interval === "year" ? "/yr" : "/mo";
  return `$${usd}${per}${pricing.usageMetered ? " + usage" : ""}`;
}
