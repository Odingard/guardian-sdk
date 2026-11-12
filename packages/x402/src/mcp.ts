import { randomBytes } from "node:crypto";

import { x402MCPClient, type PaymentRequiredHook } from "@x402/mcp";

import { requestStorage, type RequestContext } from "./context.js";
import { GuardedX402Client, type X402Guard } from "./guard.js";
import { X402GuardRefused } from "./util.js";
import { assertSupportedX402 } from "./version.js";

type McpClient = ConstructorParameters<typeof x402MCPClient>[0];

export type GuardedMcpOptions = Readonly<{
  /**
   * The MCP server's URL. When given, a payment whose `resource.url` is
   * exactly `<serverUrl origin>/tools/<called tool>` is accepted as well as
   * `mcp://tool/<called tool>`. Any other path or tool on the host is refused.
   */
  serverUrl?: string;
  maxRequestTimeoutSeconds?: number;
}>;

/**
 * The official `x402MCPClient`, built on the guard's client. Each MCP
 * payment, including the corrective-402 retry, gets exactly one Guardian
 * decision before the wallet signs.
 */
export class GuardedX402MCPClient extends x402MCPClient {
  private readonly serverUrl: string | null;

  constructor(guard: X402Guard, mcpClient: McpClient, options: GuardedMcpOptions = {}) {
    const paymentClient = guard.client;
    super(mcpClient, paymentClient, {
      autoPayment: true,
      // A local check only: never approves anything by itself and never
      // asks Guardian. The decision is the core hook's.
      onPaymentRequested: () =>
        paymentClient instanceof GuardedX402Client && paymentClient.guard === guard,
      ...(options.maxRequestTimeoutSeconds !== undefined
        ? { maxRequestTimeoutSeconds: options.maxRequestTimeoutSeconds }
        : {}),
    });
    this.serverUrl = options.serverUrl ?? null;
  }

  /**
   * Refused: an `onPaymentRequired` hook can hand x402 a ready-made payment
   * that skips the guard.
   */
  override onPaymentRequired(_hook: PaymentRequiredHook): this {
    throw new X402GuardRefused(
      "GUARD_SEALED",
      "onPaymentRequired hooks are refused on a guarded MCP client.",
    );
  }

  override async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options?: Parameters<x402MCPClient["callTool"]>[2],
  ): ReturnType<x402MCPClient["callTool"]> {
    const ctx: RequestContext = {
      id: `x4r_${randomBytes(8).toString("hex")}`,
      info: {
        transport: "mcp",
        method: "tools/call",
        originalUrl: `mcp://tool/${name}`,
        finalUrl: null,
        toolName: name,
        serverUrl: this.serverUrl,
      },
      signedEntries: [],
      versions: new Map(),
    };
    return requestStorage.run(ctx, () => super.callTool(name, args, options));
  }
}

/** Builds a guarded `x402MCPClient` around an MCP SDK `Client`. */
export function guardedMcpClient(
  guard: X402Guard,
  mcpClient: McpClient,
  options: GuardedMcpOptions = {},
): GuardedX402MCPClient {
  assertSupportedX402("@x402/mcp");
  return new GuardedX402MCPClient(guard, mcpClient, options);
}
