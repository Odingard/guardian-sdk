import type { GuardianClient } from "@odingard/guardian-sdk";

/** The tool that fetches Guardian's records for a request id. */
export const RECORD_TOOL = "guardian_record";
/**
 * Earlier name of {@link RECORD_TOOL}. Not listed, still callable, so
 * clients that call it keep working.
 */
export const LEGACY_RECORD_TOOL = "guardian_receipt";

/** Description of a `requestId` argument, shared by the tools that take one. */
const REQUEST_ID_FORMAT = "Starts with req_.";

export const TOOLS = [
  {
    name: "guardian_invoke_tool",
    title: "Run a tool through Guardian",
    description:
      "Run a tool registered on a Guardian connection, instead of calling it " +
      "directly. Guardian's rules decide ALLOW, ASK or DENY before anything " +
      "runs. ALLOW runs the tool at once (it can change the target system) " +
      "and returns the decision, requestId and execution record. ASK runs " +
      "nothing and returns a requestId: wait for the person to approve it in " +
      "Guardian, then call guardian_claim. DENY, or Guardian unreachable " +
      "(reasonCode SERVICE_UNAVAILABLE), runs nothing; each call is a new " +
      "request, so after an unknown outcome check guardian_record before " +
      "calling again.",
    inputSchema: {
      type: "object",
      properties: {
        toolName: {
          type: "string",
          description:
            "Name of the tool as registered on the Guardian connection, for " +
            'example "send_email". Lowercase letters and digits joined by ' +
            ". _ or -, at most 64 characters.",
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
        },
        arguments: {
          type: "object",
          description:
            "The tool's own input, as the JSON object the tool takes " +
            "(at most 16,384 bytes of JSON, UTF-8). Guardian decides on these exact " +
            "arguments, and an approved call runs with them unchanged. " +
            "Defaults to {}.",
          additionalProperties: true,
        },
        connectionId: {
          type: "string",
          description:
            "Id of the Guardian connection the tool is registered on " +
            "(starts with pcn_), as shown in the Guardian console. Optional " +
            "when the server sets GUARDIAN_CONNECTION_ID; required otherwise.",
          pattern: "^pcn_[A-Za-z0-9][A-Za-z0-9_-]{7,119}$",
        },
        purpose: {
          type: "string",
          description:
            "Short plain-language reason for this action, recorded with the " +
            "request. At most 1,024 characters.",
          maxLength: 1024,
        },
      },
      required: ["toolName"],
    },
    annotations: {
      title: "Run a tool through Guardian",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "guardian_claim",
    title: "Run an approved request",
    description:
      "Run a request that guardian_invoke_tool held as ASK, once the person " +
      "has approved it in Guardian. Guardian issues the capability and runs " +
      "the approved call with its original arguments (it can change the " +
      "target system), then returns ALLOW with the execution record. Before " +
      "approval it returns ASK again and runs nothing; a denied, expired or " +
      "unknown requestId returns DENY with a reasonCode; Guardian unreachable " +
      "fails closed (SERVICE_UNAVAILABLE) and can be retried. An approval is " +
      "used once: claiming the same requestId again does not run the call a " +
      "second time.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: {
          type: "string",
          description:
            "The requestId that guardian_invoke_tool returned with decision " +
            `ASK. ${REQUEST_ID_FORMAT}`,
          minLength: 1,
        },
      },
      required: ["requestId"],
    },
    annotations: {
      title: "Run an approved request",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: RECORD_TOOL,
    title: "Get the records for a request",
    description:
      "Look up the evidence records Guardian holds for one request, to see " +
      "what was decided and whether the call ran. It changes nothing and " +
      "runs no tool, so calling it again is safe. Returns the requestId and its " +
      "list of records; an unknown requestId, or Guardian unreachable, " +
      "returns ok: false with a reasonCode. Use it after an unknown or " +
      "unclear outcome, before trying a call again.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: {
          type: "string",
          description:
            "The requestId of an earlier call, from guardian_invoke_tool or " +
            `guardian_claim. ${REQUEST_ID_FORMAT}`,
          minLength: 1,
        },
      },
      required: ["requestId"],
    },
    annotations: {
      title: "Get the records for a request",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

export type DispatchOptions = Readonly<{
  client: GuardianClient;
  defaultConnectionId?: string;
  adapterId?: string;
}>;

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
};

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** A JSON payload reported as an MCP tool error: the action is not done. */
function jsonError(payload: unknown): ToolResult {
  return { ...jsonResult(payload), isError: true };
}

const CHECK_FIRST = `Call ${RECORD_TOOL} with this requestId, or check the target system, before retrying.`;

function denied(
  reasonCode: string | undefined,
  requestId?: string,
): ToolResult {
  const code = reasonCode ?? "DENIED";
  return jsonError({
    decision: "DENY",
    reasonCode: code,
    ...(requestId ? { requestId } : {}),
    message:
      code === "SERVICE_UNAVAILABLE"
        ? "Guardian could not be reached, so nothing was done. Try again later."
        : "Guardian denied this call. Nothing was done. Do not retry the same call.",
  });
}

async function requestAndExecute(
  client: GuardianClient,
  result: Awaited<ReturnType<GuardianClient["request"]>>,
): Promise<ToolResult> {
  if (!result.ok) {
    // A held ASK is reported as APPROVAL_REQUIRED with its requestId
    // (guardian-sdk >= 0.2.0), and a claim made before the person approves
    // as APPROVAL_PENDING; keep both resumable. Anything else is DENY.
    const heldRequestId = (result as { requestId?: unknown }).requestId;
    if (
      (result.reasonCode === "APPROVAL_REQUIRED" ||
        result.reasonCode === "APPROVAL_PENDING") &&
      typeof heldRequestId === "string" &&
      heldRequestId.length > 0
    ) {
      return jsonResult({
        decision: "ASK",
        requestId: heldRequestId,
        reasonCode: result.reasonCode,
        next: "Held for human approval. Call guardian_claim with this requestId after approval.",
      });
    }
    return denied(
      result.reasonCode,
      typeof heldRequestId === "string" && heldRequestId.length > 0
        ? heldRequestId
        : undefined,
    );
  }
  if (result.decision === "ALLOW" && result.capabilityToken) {
    const executed = await client.execute({
      requestId: result.requestId,
      capabilityToken: result.capabilityToken,
    });
    if (!executed.ok) {
      // Guardian was asked to perform the call. A lost or refused answer
      // does not prove it did not happen.
      return jsonError({
        decision: "ALLOW",
        requestId: result.requestId,
        outcome: "unknown",
        executionFailed: executed.reasonCode,
        message: `Guardian could not confirm the outcome (${executed.reasonCode}). The call may have been done. ${CHECK_FIRST}`,
      });
    }
    const status = (executed.receipt as { status?: unknown } | undefined)
      ?.status;
    if (status === "sent-verified") {
      return jsonResult({
        decision: "ALLOW",
        requestId: result.requestId,
        receipt: executed.receipt,
      });
    }
    if (status === "not-sent") {
      return jsonError({
        decision: "ALLOW",
        requestId: result.requestId,
        outcome: "not-done",
        receipt: executed.receipt,
        message:
          "Guardian did not send the call (record status not-sent). It was not done.",
      });
    }
    return jsonError({
      decision: "ALLOW",
      requestId: result.requestId,
      outcome: "unknown",
      receipt: executed.receipt,
      message: `The outcome is unknown (record status ${typeof status === "string" ? status : "missing"}). The call may have been done. ${CHECK_FIRST}`,
    });
  }
  if (result.decision === "ASK") {
    return jsonResult({
      decision: "ASK",
      requestId: result.requestId,
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
      message:
        "Held for human approval. Call guardian_claim with this requestId after approval.",
    });
  }
  // DENY, or an ALLOW without a capability token: nothing ran.
  return denied(
    result.reasonCode ??
      (result.decision === "DENY" ? undefined : "MISSING_CAPABILITY"),
    result.requestId,
  );
}

export async function handleToolCall(
  options: DispatchOptions,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<ToolResult> {
  const { client, defaultConnectionId, adapterId } = options;

  if (name === "guardian_invoke_tool") {
    const toolName = arguments_.toolName;
    if (typeof toolName !== "string" || toolName.length === 0) {
      return errorResult("toolName is required");
    }
    const conn =
      typeof arguments_.connectionId === "string" &&
      arguments_.connectionId.length > 0
        ? arguments_.connectionId
        : defaultConnectionId;
    if (!conn) {
      return errorResult(
        "connectionId is required (no GUARDIAN_CONNECTION_ID configured)",
      );
    }
    const toolArguments =
      arguments_.arguments && typeof arguments_.arguments === "object"
        ? (arguments_.arguments as Record<string, unknown>)
        : {};
    const result = await client.request({
      action: "tool.invoke",
      connectionId: conn,
      toolName,
      arguments: toolArguments,
      ...(adapterId ? { adapterId } : {}),
      ...(typeof arguments_.purpose === "string"
        ? { purpose: arguments_.purpose }
        : {}),
    });
    return requestAndExecute(client, result);
  }

  if (name === "guardian_claim") {
    const requestId = arguments_.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return errorResult("requestId is required");
    }
    const result = await client.claim(requestId);
    return requestAndExecute(client, result);
  }

  if (name === RECORD_TOOL || name === LEGACY_RECORD_TOOL) {
    const requestId = arguments_.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return errorResult("requestId is required");
    }
    const result = await client.receipts(requestId);
    return jsonResult(
      result.ok
        ? { requestId, receipts: result.receipts }
        : { ok: false, reasonCode: result.reasonCode },
    );
  }

  return errorResult(`unknown tool: ${name}`);
}
