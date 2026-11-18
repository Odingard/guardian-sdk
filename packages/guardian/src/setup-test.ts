/**
 * The test action of `guardian init`: one governed call of the tool
 * `guardian_setup_test`, which does nothing. It goes through the SDK's
 * shared guard (`createGuard`, the same path as every wrapped tool): it is
 * allowed and recorded, held until the person approves it in the console
 * and then recorded, or refused. A record Guardian cannot confirm is
 * reported as such and never retried.
 */
import {
  createGuard,
  GuardianApprovalPending,
  GuardianDenied,
  GuardianExecutionFailed,
  type GuardianClient,
} from "@odingard/guardian-sdk";

export const SETUP_TEST_TOOL = "guardian_setup_test";

export type SetupTestOutcome =
  | { kind: "allowed"; requestId?: string }
  | { kind: "approved"; requestId: string }
  | { kind: "refused"; requestId?: string; reasonCode: string }
  | { kind: "unknown"; requestId: string; reasonCode: string }
  | { kind: "expired"; requestId: string };

function fromError(error: unknown): SetupTestOutcome {
  if (error instanceof GuardianExecutionFailed) {
    return error.outcomeUnknown
      ? {
          kind: "unknown",
          requestId: error.requestId,
          reasonCode: error.reasonCode,
        }
      : {
          kind: "refused",
          requestId: error.requestId,
          reasonCode: error.reasonCode,
        };
  }
  if (error instanceof GuardianDenied) {
    return {
      kind: "refused",
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      reasonCode: error.reasonCode,
    };
  }
  throw error;
}

export async function runSetupTest(input: {
  client: GuardianClient;
  connectionId: string;
  onWaiting(requestId: string): void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How long to wait for the person (the request itself lasts 2 minutes). */
  waitMs?: number;
  now?: () => number;
}): Promise<SetupTestOutcome> {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = input.now ?? Date.now;
  const pollMs = input.pollMs ?? 3_000;
  const waitMs = input.waitMs ?? 120_000;
  let recordedId: string | undefined;
  const guard = createGuard({
    client: input.client,
    connectionId: input.connectionId,
    purpose: "Guardian setup test",
    onReceipt: (event) => {
      recordedId = event.requestId;
    },
  });
  const setupTest = guard(SETUP_TEST_TOOL, async () => ({ ok: true }));
  let held: GuardianApprovalPending<unknown>;
  try {
    await setupTest({});
    return {
      kind: "allowed",
      ...(recordedId === undefined ? {} : { requestId: recordedId }),
    };
  } catch (error) {
    if (!(error instanceof GuardianApprovalPending)) return fromError(error);
    held = error as GuardianApprovalPending<unknown>;
  }
  input.onWaiting(held.requestId);
  const deadline = now() + waitMs;
  while (now() < deadline) {
    await sleep(pollMs);
    try {
      await held.resume();
      return { kind: "approved", requestId: held.requestId };
    } catch (error) {
      if (error instanceof GuardianApprovalPending) continue;
      return fromError(error);
    }
  }
  return { kind: "expired", requestId: held.requestId };
}
