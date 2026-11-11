// Generated file — do not edit.
import type {
  GuardianClient,
  GuardianRequestResult,
} from "@odingard/guardian-sdk";

import {
  HOSTED_RECORD_ONLY_RESULT_DIGEST,
  STEEL_CHECKOUT_TOOL,
} from "./record-port.js";
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
      /**
       * Guardian verified the redemption, but the standard hosted
       * record transport recorded it without a protected Steel executor, so
       * no order was placed.
       */
      reasonCode?: "NO_PROTECTED_EXECUTOR";
    }
  | {
      /**
       * The order may have been placed: the outcome was not confirmed
       * (receipt `outcome-pending` / `outcome-unconfirmed`), or the signed
       * receipt could not be read to tell an order from a record-only
       * redemption (`RECEIPT_UNVERIFIED`). Do not retry the order; check the
       * merchant (or the Guardian receipt) first.
       */
      status: "outcome-unknown";
      requestId: string;
      receiptStatus: Receipt["status"];
      receipt: Receipt;
      reasonCode?: "RECEIPT_UNVERIFIED";
    }
  | {
      /**
       * The execute call was sent but no usable answer came back: the
       * connection failed, Guardian answered 5xx, or the answer could not
       * be read. Guardian may have redeemed the capability and placed the
       * order. Do not retry the order; check the merchant (or the Guardian
       * receipt for this requestId) first.
       */
      status: "outcome-unknown";
      requestId: string;
      reasonCode: "EXECUTE_RESPONSE_LOST";
      /** What the client observed, such as `SERVICE_UNAVAILABLE`. */
      detail: string;
      /** No receipt was received. */
      receiptStatus?: undefined;
      receipt?: undefined;
    }
  | { status: "pending-approval"; requestId: string }
  | { status: "denied"; reasonCode: string; requestId?: string }
  | {
      /** Guardian refused the redemption: no order was placed. */
      status: "failed";
      reasonCode: string;
      requestId?: string;
    };

/** True when an execute failure may hide a placed order. */
function executeOutcomeUnknown(executed: {
  reasonCode: string;
  outcomeUnknown?: boolean;
}): boolean {
  return (
    executed.outcomeUnknown === true ||
    executed.reasonCode === "SERVICE_UNAVAILABLE" ||
    /^HTTP_(0|5\d\d)$/.test(executed.reasonCode)
  );
}

/** The record transport's result digest from a portable (greceipt.v1) receipt. */
function resultDigestOf(receipt: unknown): string | null {
  const sentRef = (
    receipt as { execution?: { sentRef?: { resultDigest?: unknown } } | null }
  )?.execution?.sentRef;
  return typeof sentRef?.resultDigest === "string"
    ? sentRef.resultDigest
    : null;
}

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
    let executed: Awaited<ReturnType<GuardianClient["execute"]>>;
    try {
      executed = await input.guardian.execute({ requestId, capabilityToken });
    } catch {
      // The execute may have been sent before the client failed.
      return {
        status: "outcome-unknown",
        requestId,
        reasonCode: "EXECUTE_RESPONSE_LOST",
        detail: "CLIENT_ERROR",
      };
    }
    if (!executed.ok) {
      // Once execute was attempted, only a definitive refusal is `failed`
      // (no order, safe to retry). A lost, 5xx or unreadable answer may
      // hide a placed order.
      if (executeOutcomeUnknown(executed)) {
        return {
          status: "outcome-unknown",
          requestId,
          reasonCode: "EXECUTE_RESPONSE_LOST",
          detail: executed.reasonCode,
        };
      }
      return { status: "failed", reasonCode: executed.reasonCode, requestId };
    }
    // Only a verified effect counts as executed. `not-sent` means no order;
    // any other unverified status means the order may exist, which is
    // reported as outcome-unknown (do not retry), never as success.
    if (executed.receipt.status === "not-sent") {
      return {
        status: "not-executed",
        requestId,
        receiptStatus: executed.receipt.status,
        receipt: executed.receipt,
      };
    }
    if (executed.receipt.status !== "sent-verified") {
      return {
        status: "outcome-unknown",
        requestId,
        receiptStatus: executed.receipt.status,
        receipt: executed.receipt,
      };
    }
    // On a record-transport tool, `sent-verified` only says Guardian
    // recorded the redemption. Standard hosted Guardian (no protected Steel
    // executor installed) records it without running anything: that is not
    // an order. The signed portable receipt carries the recorded result
    // digest that tells the two apart.
    const portable = await Promise.resolve()
      .then(() => input.guardian.portableReceipt(requestId))
      .catch(() => null);
    const digest =
      portable?.ok === true ? resultDigestOf(portable.receipt) : null;
    if (portable?.ok !== true || digest === null) {
      // Unreadable, or no recorded result digest: it could be an order or a
      // record-only redemption.
      // Never claim an order that may not exist, and never invite a retry
      // of one that may.
      return {
        status: "outcome-unknown",
        requestId,
        receiptStatus: executed.receipt.status,
        receipt: executed.receipt,
        reasonCode: "RECEIPT_UNVERIFIED",
      };
    }
    if (digest === HOSTED_RECORD_ONLY_RESULT_DIGEST) {
      return {
        status: "not-executed",
        requestId,
        receiptStatus: executed.receipt.status,
        receipt: executed.receipt,
        reasonCode: "NO_PROTECTED_EXECUTOR",
      };
    }
    return { status: "executed", requestId, receipt: executed.receipt };
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
