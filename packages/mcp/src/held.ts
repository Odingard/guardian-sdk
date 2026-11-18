import type {
  GuardianClient,
  GuardianHeldRequest,
} from "@odingard/guardian-sdk";

/** Lists this agent's own requests that are waiting for a person. */
export const PENDING_TOOL = "guardian_pending";
/** Withdraws one of this agent's own held requests. */
export const CANCEL_TOOL = "guardian_cancel";

/** Largest page `guardian_pending` asks Guardian for. */
const PAGE_MAX = 100;

type Mode = "dispatch" | "proxy";

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
};

function jsonResult(payload: unknown, isError = false): ToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** The two held-request tools, worded for `guardian-mcp` or its proxy. */
export function heldRequestTools(mode: Mode) {
  const claim =
    mode === "proxy"
      ? "guardian_claim forwards it once the person approves"
      : "claim it with guardian_claim once the person approves";
  return [
    {
      name: PENDING_TOOL,
      title: "List my held requests",
      description:
        "List this agent's own requests that Guardian is holding for a " +
        "person's approval (decision ASK), from newest to oldest. Each entry has the " +
        "requestId, action, toolName (null when the request names no tool), " +
        "purpose, createdAtEpochMs and expiresAtEpochMs" +
        (mode === "proxy"
          ? ", and heldByThisProxy: true when this proxy holds the call, so " +
            "guardian_claim here can forward it after approval"
          : "") +
        ". It reads and changes nothing, so calling it again is safe, and it " +
        "never shows other agents' requests or anything about the person or " +
        "the account. Returns { requests, next }; pass next as before to get " +
        "the next page (next is null on the last page). A request leaves the " +
        "list when the person approves or denies it, when it expires, or " +
        "when it is withdrawn with guardian_cancel; an approved request is " +
        "not listed, so keep its requestId and " +
        claim +
        ". Guardian unreachable returns ok: false with reasonCode " +
        "SERVICE_UNAVAILABLE; try again later. Use it to find a requestId to " +
        "claim or to withdraw.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description:
              "Most requests to return on this page, from 1 to 100. " +
              "Defaults to 20.",
            minimum: 1,
            maximum: PAGE_MAX,
          },
          before: {
            type: "string",
            description:
              "The next value from the previous page, to continue the " +
              "list. Omit it to start from the newest request.",
            minLength: 1,
          },
        },
      },
      annotations: {
        title: "List my held requests",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: CANCEL_TOOL,
      title: "Withdraw a held request",
      description:
        "Withdraw one of this agent's own requests that Guardian is holding " +
        "for a person's approval (decision ASK). The person no longer sees " +
        "it, and it can never be approved, claimed or run; to ask again, " +
        "make a new request. It takes authority away and does nothing else: " +
        "it runs no tool and changes nothing in the target system" +
        (mode === "proxy"
          ? ". This proxy also drops the held call, so guardian_claim " +
            "forwards nothing for this requestId"
          : "") +
        ". Returns the requestId with state withdrawn and " +
        "withdrawnAtEpochMs. Calling it again for the same requestId " +
        "returns the same answer, so a retry is safe. If the person already " +
        "decided the request, or it expired, it returns ok: false with " +
        "reasonCode ALREADY_DECIDED and the request's state, and nothing " +
        "changes (an approved request can still be claimed with " +
        "guardian_claim). An unknown requestId, or one that belongs to " +
        "another agent, returns NOT_FOUND. If Guardian cannot be reached or " +
        "its answer is lost, it returns SERVICE_UNAVAILABLE with " +
        "outcomeUnknown: true: the request may or may not have been " +
        "withdrawn, and calling it again with the same requestId is safe" +
        (mode === "proxy"
          ? "; this proxy keeps the held call until Guardian confirms the " +
            "withdrawal"
          : "") +
        ". Withdrawing cannot be undone. Use it when the agent no longer needs an action " +
        "it asked for, so the person is not asked to decide on it.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            description:
              "The requestId of a held request, from a call that returned " +
              "decision ASK or from guardian_pending. Starts with req_.",
            minLength: 1,
          },
        },
        required: ["requestId"],
      },
      annotations: {
        title: "Withdraw a held request",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

const UNSUPPORTED = {
  ok: false,
  reasonCode: "NOT_SUPPORTED",
  message:
    "This version of @odingard/guardian-sdk cannot do this. Update it; nothing changed.",
};

/** No clear answer came back: the withdrawal may have happened. */
const UNCONFIRMED_MESSAGE =
  "No clear answer came back from Guardian, so this request may or may not have been withdrawn. Calling guardian_cancel again with the same requestId is safe.";

function refusalMessage(reasonCode: string, state?: string): string {
  if (reasonCode === "NOT_FOUND") {
    return "This agent has no held request with this requestId. Nothing changed.";
  }
  if (reasonCode === "ALREADY_DECIDED") {
    return state === "approved"
      ? "The person already approved this request, so it was not withdrawn. It can still be claimed with guardian_claim."
      : `This request is already ${state ?? "decided"}, so there is nothing to withdraw. Nothing changed.`;
  }
  return "Nothing was withdrawn.";
}

/**
 * `guardian_pending`. `heldHere` marks the requests a proxy holds the call
 * for (proxy mode).
 */
export async function listHeld(
  client: GuardianClient,
  args: Record<string, unknown>,
  heldHere?: (requestId: string) => boolean,
): Promise<ToolResult> {
  if (!client.pending) return jsonResult(UNSUPPORTED, true);
  const limit = args.limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > PAGE_MAX)
  ) {
    return jsonResult(
      { error: "limit must be a whole number from 1 to 100" },
      true,
    );
  }
  const before = args.before;
  if (
    before !== undefined &&
    (typeof before !== "string" || before.length === 0)
  ) {
    return jsonResult(
      { error: "before must be the next value of a page" },
      true,
    );
  }
  const result = await client.pending({
    ...(limit === undefined ? {} : { limit }),
    ...(before === undefined ? {} : { before }),
  });
  if (!result.ok) {
    return jsonResult(
      {
        ok: false,
        reasonCode: result.reasonCode,
        message:
          result.reasonCode === "SERVICE_UNAVAILABLE"
            ? "Guardian could not be reached. Try again later."
            : "Guardian did not return the held requests.",
      },
      true,
    );
  }
  const requests = result.requests.map((request: GuardianHeldRequest) =>
    heldHere
      ? { ...request, heldByThisProxy: heldHere(request.requestId) }
      : request,
  );
  return jsonResult({ requests, next: result.next });
}

/**
 * `guardian_cancel`. `dropHeld` runs once Guardian confirms the withdrawal
 * (proxy mode: forget the held call).
 */
export async function cancelHeld(
  client: GuardianClient,
  args: Record<string, unknown>,
  dropHeld?: (requestId: string) => void,
): Promise<ToolResult> {
  const requestId = args.requestId;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return jsonResult({ error: "requestId is required" }, true);
  }
  if (!client.withdraw) return jsonResult(UNSUPPORTED, true);
  const result = await client.withdraw(requestId);
  if (result.ok && result.requestId !== requestId) {
    // An answer about another request: fail closed, drop nothing.
    return jsonResult(
      {
        ok: false,
        reasonCode: "MALFORMED_RESPONSE",
        requestId,
        message:
          "Guardian's answer did not match this requestId. Nothing was dropped.",
      },
      true,
    );
  }
  if (result.ok) {
    dropHeld?.(requestId);
    return jsonResult({
      requestId: result.requestId,
      state: "withdrawn",
      withdrawnAtEpochMs: result.withdrawnAtEpochMs,
      message:
        "Withdrawn. The person no longer sees this request and it can never be claimed. Nothing was run.",
    });
  }
  // No clear answer (the SDK says so, or an SDK without the flag reports
  // an outage): the withdrawal may have happened. Keep the held call; a
  // retry with the same requestId gives a clear answer.
  const unconfirmed =
    result.outcomeUnknown === true ||
    result.reasonCode === "SERVICE_UNAVAILABLE";
  return jsonResult(
    {
      ok: false,
      reasonCode: result.reasonCode,
      requestId: result.requestId ?? requestId,
      ...(result.state === undefined ? {} : { state: result.state }),
      ...(unconfirmed ? { outcomeUnknown: true } : {}),
      message: unconfirmed
        ? UNCONFIRMED_MESSAGE
        : refusalMessage(result.reasonCode, result.state),
    },
    true,
  );
}
