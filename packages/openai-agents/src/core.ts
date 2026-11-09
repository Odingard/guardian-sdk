/**
 * The governed-execution triad lives in the core SDK
 * (`@odingard/guardian-sdk`, src/guard.ts) so every framework adapter, the
 * MCP proxy and the plain `createGuard` helper share one implementation.
 * This module re-exports it unchanged for the adapter.
 */
export {
  createGuardianContext,
  runThroughGuardian,
  toArgumentsRecord,
  GuardianApprovalPending,
  GuardianDenied,
  GuardianExecutionFailed,
  GuardianRecordTransportRequired,
  type GuardianAdapterOptions,
  type GuardianContext,
  type GuardianDecisionResult,
  type GuardianMode,
  type GuardianResume,
  type GuardianToolMode,
} from "@odingard/guardian-sdk";
