import type { GuardianClient } from "@odingard/guardian-sdk";

export const TOOLS = [
  {
    name: "guardian_invoke_tool",
    description:
      "Propose a tool invocation to Guardian. ALLOW executes immediately and " +
      "returns the execution receipt; ASK is held for human approval (call " +
      "guardian_claim with the returned requestId after the human approves); " +
      "DENY refuses the action with a reason code.",
    inputSchema: {
      type: "object",
      properties: {
        toolName: { type: "string", description: "Registered tool name." },
        arguments: {
          type: "object",
          description: "Arguments the tool would run with.",
          additionalProperties: true,
        },
        connectionId: {
          type: "string",
          description: "Tool connection id. Defaults to GUARDIAN_CONNECTION_ID.",
        },
        purpose: {
          type: "string",
          description: "Human-readable reason for this action.",
        },
      },
      required: ["toolName"],
    },
  },
  {
    name: "guardian_claim",
    description:
      "Collect the capability for a request that was held as ASK and approved " +
      "by the human, then execute it and return the receipt.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
    },
  },
  {
    name: "guardian_receipt",
    description:
      "Fetch the machine-readable evidence receipts for a request id.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
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
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function requestAndExecute(
  client: GuardianClient,
  result: Awaited<ReturnType<GuardianClient["request"]>>,
): Promise<ToolResult> {
  if (!result.ok) {
    // A held ASK is reported as APPROVAL_REQUIRED with its requestId
    // (guardian-sdk >= 0.2.0); keep it resumable. Anything else is DENY.
    const heldRequestId = (result as { requestId?: unknown }).requestId;
    if (
      result.reasonCode === "APPROVAL_REQUIRED" &&
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
    return jsonResult({ decision: "DENY", reasonCode: result.reasonCode });
  }
  if (result.decision === "ALLOW" && result.capabilityToken) {
    const executed = await client.execute({
      requestId: result.requestId,
      capabilityToken: result.capabilityToken,
    });
    return jsonResult(
      executed.ok
        ? {
            decision: "ALLOW",
            requestId: result.requestId,
            receipt: executed.receipt,
          }
        : {
            decision: "ALLOW",
            requestId: result.requestId,
            executionFailed: executed.reasonCode,
          },
    );
  }
  return jsonResult({
    decision: result.decision,
    requestId: result.requestId,
    ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    ...(result.decision === "ASK"
      ? {
          message:
            "Held for human approval. Call guardian_claim with this requestId after approval.",
        }
      : {}),
  });
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

  if (name === "guardian_receipt") {
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
