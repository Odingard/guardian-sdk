// Generated file — do not edit.
import type {
  GuardianClient,
  GuardianRequestResult,
} from "@odingard/guardian-sdk";

import { STEEL_CHECKOUT_TOOL } from "./record-port.js";
import type { SteelCheckoutArguments } from "./executor.js";

type Receipt = Extract<
  Awaited<ReturnType<GuardianClient["execute"]>>,
  { ok: true }
>["receipt"];

export type SteelOrderOutcome =
  | { status: "executed"; requestId: string; receipt: Receipt }
  | {
      status: "not-executed";
      requestId: string;
      receiptStatus: Receipt["status"];
      receipt: Receipt;
    }
  | { status: "pending-approval"; requestId: string }
  | { status: "denied"; reasonCode: string; requestId?: string }
  | { status: "failed"; reasonCode: string; requestId?: string };

/**
 * The agent-side dispatcher. This is everything the untrusted
 * agent holds: a Guardian agent credential (inside `guardian`) and a tool
 * connection id. No Steel URL, CDP socket, or merchant credential exists on
 * this side; the only way to place an order is to propose it to Guardian.
 */
export function createGuardianSteelDispatcher(input: {
  guardian: GuardianClient;
  connectionId: string;
}) {
  const execute = async (
    requestId: string,
    capabilityToken: string,
  ): Promise<SteelOrderOutcome> => {
    const executed = await input.guardian.execute({
      requestId,
      capabilityToken,
    });
    if (!executed.ok) {
      return { status: "failed", reasonCode: executed.reasonCode, requestId };
    }
    // Only a verified effect counts as executed; a refused or unconfirmed
    // commit is reported with its receipt, never as success.
    return executed.receipt.status === "sent-verified"
      ? { status: "executed", requestId, receipt: executed.receipt }
      : {
          status: "not-executed",
          requestId,
          receiptStatus: executed.receipt.status,
          receipt: executed.receipt,
        };
  };
  const settle = async (
    result: GuardianRequestResult,
  ): Promise<SteelOrderOutcome> => {
    if (!result.ok) {
      if (result.reasonCode === "APPROVAL_REQUIRED" && result.requestId) {
        return { status: "pending-approval", requestId: result.requestId };
      }
      return {
        status: "denied",
        reasonCode: result.reasonCode,
        ...(result.requestId === undefined
          ? {}
          : { requestId: result.requestId }),
      };
    }
    if (result.decision !== "ALLOW" || result.capabilityToken === undefined) {
      return result.decision === "ASK"
        ? { status: "pending-approval", requestId: result.requestId }
        : {
            status: "denied",
            reasonCode: result.reasonCode ?? "DENIED",
            requestId: result.requestId,
          };
    }
    return execute(result.requestId, result.capabilityToken);
  };

  return {
    async submitOrder(
      args: SteelCheckoutArguments,
      purpose = "Place a merchant order through a Guardian-governed Steel browser",
    ): Promise<SteelOrderOutcome> {
      let result: GuardianRequestResult;
      try {
        result = await input.guardian.request({
          action: "tool.invoke",
          connectionId: input.connectionId,
          toolName: STEEL_CHECKOUT_TOOL,
          arguments: { ...args, shipTo: { ...args.shipTo } },
          purpose,
        });
      } catch {
        return { status: "denied", reasonCode: "GUARDIAN_UNAVAILABLE" };
      }
      return settle(result);
    },
    /** After a human approves an ASK: claim the bound capability, execute. */
    async resume(requestId: string): Promise<SteelOrderOutcome> {
      let claimed: GuardianRequestResult;
      try {
        claimed = await input.guardian.claim(requestId);
      } catch {
        return {
          status: "denied",
          reasonCode: "GUARDIAN_UNAVAILABLE",
          requestId,
        };
      }
      if (!claimed.ok || claimed.capabilityToken === undefined) {
        return {
          status: "denied",
          reasonCode: claimed.ok ? "CAPABILITY_MISSING" : claimed.reasonCode,
          requestId,
        };
      }
      return execute(requestId, claimed.capabilityToken);
    },
  };
}

export type GuardianSteelDispatcher = ReturnType<
  typeof createGuardianSteelDispatcher
>;
