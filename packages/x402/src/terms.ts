import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  pinnedAsset,
  V1_NETWORK_NAMES,
  type PinnedAsset,
  type SupportedNetwork,
} from "./constants.js";
import {
  ADDRESS_RE,
  ATOMIC_RE,
  formatAtomic,
  isPlainObject,
  refusal,
  ZERO_ADDRESS,
  type Refusal,
} from "./util.js";

/** The request a payment belongs to, as the guard saw it. */
export type PaymentRequestInfo = Readonly<
  | {
      transport: "http";
      method: string;
      /** The URL the agent asked for, before any redirect. */
      originalUrl: string;
      /** The URL that answered 402, after redirects (as x402 reports it). */
      finalUrl: string | null;
    }
  | {
      transport: "mcp";
      method: "tools/call";
      /** `mcp://tool/<name>` for the tool the agent called. */
      originalUrl: string;
      finalUrl: null;
      toolName: string;
      /** The MCP server's URL, when the developer gave it. */
      serverUrl: string | null;
    }
>;

/** What Guardian decides on. Plain JSON, deep-copied and frozen. */
export type CanonicalTerms = Readonly<{
  schema: "odingard.guardian.x402.pay.v1";
  x402Version: 1 | 2;
  scheme: "exact";
  network: SupportedNetwork;
  networkName: string;
  /** Lowercase token address. */
  asset: string;
  assetSymbol: string;
  /** Integer string in the asset's atomic units. */
  amount: string;
  /** For people, from the guard's pinned decimals, e.g. "0.01 USDC". */
  amountDisplay: string;
  /** Lowercase recipient address. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Readonly<{
    name: string;
    version: string;
    assetTransferMethod: "eip3009";
    paymentFlow: "authorization";
  }>;
  resourceUrl: string;
  request: Readonly<{
    transport: "http" | "mcp";
    method: string;
    originalUrl: string;
    finalUrl: string | null;
  }>;
}>;

export type TermsResult =
  | { ok: true; terms: CanonicalTerms; pinned: PinnedAsset }
  | Refusal;

export type TermsOptions = Readonly<{
  enabledNetworks: readonly SupportedNetwork[];
  maxTimeoutSecondsLimit: number;
}>;

const KNOWN_EXTRA = new Set([
  "name",
  "version",
  "assetTransferMethod",
  "paymentFlow",
]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The resource URLs that name the called MCP tool, and nothing else:
 * - `mcp://tool/<tool>`, what `@x402/mcp` names by default
 *   (`createToolResourceUrl`), compared exactly;
 * - only when `serverUrl` is given, `<serverUrl origin>/tools/<tool>` with no
 *   query or fragment (the tool name percent-encoded as a path segment).
 * Any other path, query or tool on the server host is refused.
 */
export function mcpResourceMatches(
  resourceUrl: string,
  toolName: string,
  serverUrl: string | null,
): boolean {
  if (resourceUrl === `mcp://tool/${toolName}`) return true;
  if (serverUrl === null) return false;
  let server: URL;
  let resource: URL;
  try {
    server = new URL(serverUrl);
    resource = new URL(resourceUrl);
  } catch {
    return false;
  }
  if (server.protocol !== "https:" && server.protocol !== "http:") return false;
  const expected = new URL(`/tools/${encodeURIComponent(toolName)}`, server.origin);
  return resource.href === expected.href;
}

/**
 * Reads one payment entry into canonical terms, or refuses. Everything it
 * cannot read exactly is refused.
 */
export function readTerms(
  x402Version: unknown,
  requirement: unknown,
  paymentRequired: unknown,
  request: PaymentRequestInfo | null,
  options: TermsOptions,
): TermsResult {
  if (x402Version !== 1 && x402Version !== 2) {
    return refusal(
      "UNSUPPORTED_VERSION",
      `x402Version ${String(x402Version)} is not supported (only 1 and 2).`,
    );
  }
  if (!isPlainObject(requirement)) {
    return refusal(
      "MALFORMED_PAYMENT_REQUIRED",
      "A payment entry is not an object.",
    );
  }
  const r = requirement;
  if (r.scheme !== "exact") {
    return refusal(
      "UNSUPPORTED_SCHEME",
      `Scheme ${JSON.stringify(r.scheme)} is not supported (only "exact").`,
    );
  }

  // Network: v2 uses CAIP-2; v1 names are mapped (base, base-sepolia only).
  let network: SupportedNetwork | undefined;
  if (typeof r.network === "string") {
    if (x402Version === 2) {
      if (r.network === BASE_SEPOLIA || r.network === BASE_MAINNET) {
        network = r.network;
      }
    } else if (Object.hasOwn(V1_NETWORK_NAMES, r.network)) {
      network = V1_NETWORK_NAMES[r.network];
    }
  }
  if (network === undefined) {
    return refusal(
      "UNSUPPORTED_NETWORK",
      `Network ${JSON.stringify(r.network)} is not supported.`,
    );
  }
  if (!options.enabledNetworks.includes(network)) {
    return refusal(
      "NETWORK_NOT_ENABLED",
      `Network ${network} is not enabled in this guard.`,
    );
  }

  if (typeof r.asset !== "string" || !ADDRESS_RE.test(r.asset)) {
    return refusal("UNSUPPORTED_ASSET", "The asset is not an address.");
  }
  const pinned = pinnedAsset(network, r.asset);
  if (!pinned) {
    return refusal(
      "UNSUPPORTED_ASSET",
      `Asset ${r.asset} is not a supported asset on ${network}.`,
    );
  }

  const rawAmount = x402Version === 1 ? r.maxAmountRequired : r.amount;
  if (typeof rawAmount !== "string" || !ATOMIC_RE.test(rawAmount)) {
    return refusal(
      "INVALID_AMOUNT",
      "The amount is not a positive integer string in atomic units.",
    );
  }
  if (x402Version === 1 && r.amount !== undefined && r.amount !== rawAmount) {
    return refusal(
      "INVALID_AMOUNT",
      "The v1 entry names two different amounts.",
    );
  }

  if (
    typeof r.payTo !== "string" ||
    !ADDRESS_RE.test(r.payTo) ||
    r.payTo.toLowerCase() === ZERO_ADDRESS
  ) {
    return refusal("INVALID_PAY_TO", "payTo is not a plain address.");
  }

  const timeout = r.maxTimeoutSeconds;
  if (
    typeof timeout !== "number" ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0
  ) {
    return refusal(
      "INVALID_TIMEOUT",
      "maxTimeoutSeconds is not a positive whole number.",
    );
  }
  if (timeout > options.maxTimeoutSecondsLimit) {
    return refusal(
      "TIMEOUT_ABOVE_LIMIT",
      `maxTimeoutSeconds ${timeout} is above the limit of ${options.maxTimeoutSecondsLimit}.`,
    );
  }

  if (!isPlainObject(r.extra)) {
    return refusal("DOMAIN_MISMATCH", "extra.name and extra.version are missing.");
  }
  const extra = r.extra;
  if (Object.hasOwn(extra, "splits")) {
    return refusal("SPLITS_REFUSED", "extra.splits is not supported.");
  }
  if (
    extra.assetTransferMethod !== undefined &&
    extra.assetTransferMethod !== "eip3009"
  ) {
    return refusal(
      "UNSUPPORTED_TRANSFER_METHOD",
      `Transfer method ${JSON.stringify(extra.assetTransferMethod)} is not supported (only eip3009).`,
    );
  }
  if (extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization") {
    return refusal(
      "UNSUPPORTED_PAYMENT_FLOW",
      `Payment flow ${JSON.stringify(extra.paymentFlow)} is not supported (only authorization).`,
    );
  }
  const unknownExtra = Object.keys(extra).filter((k) => !KNOWN_EXTRA.has(k));
  if (unknownExtra.length > 0) {
    return refusal(
      "UNKNOWN_EXTRA_FIELD",
      `extra has fields the guard cannot read: ${unknownExtra.join(", ")}.`,
    );
  }
  if (extra.name !== pinned.name || extra.version !== pinned.version) {
    return refusal(
      "DOMAIN_MISMATCH",
      `extra.name/version do not match the pinned ${pinned.symbol} on ${pinned.networkName}.`,
    );
  }

  // Resource: v2 top-level `resource.url`, v1 per-entry `resource`.
  let resourceUrl: unknown;
  if (x402Version === 2) {
    const pr = paymentRequired as { resource?: unknown } | null;
    resourceUrl = isPlainObject(pr?.resource)
      ? (pr.resource as { url?: unknown }).url
      : undefined;
  } else {
    resourceUrl = r.resource;
  }
  if (typeof resourceUrl !== "string" || hostOf(resourceUrl) === null) {
    return refusal("MISSING_RESOURCE", "The resource URL is missing or invalid.");
  }

  if (request === null) {
    return refusal(
      "ORIGINAL_REQUEST_MISSING",
      "The guard did not see the original request for this payment.",
    );
  }
  if (request.transport === "mcp") {
    if (x402Version !== 2) {
      return refusal(
        "V1_NOT_SUPPORTED_ON_MCP",
        "Only x402 v2 is supported on MCP.",
      );
    }
    if (!mcpResourceMatches(resourceUrl, request.toolName, request.serverUrl)) {
      return refusal(
        "RESOURCE_HOST_MISMATCH",
        `The resource ${resourceUrl} is not the called tool ${request.toolName} (expected mcp://tool/${request.toolName}${request.serverUrl === null ? "" : " or <serverUrl origin>/tools/" + request.toolName}).`,
      );
    }
  } else {
    const originalHost = hostOf(request.originalUrl);
    if (originalHost === null) {
      return refusal(
        "ORIGINAL_REQUEST_MISSING",
        "The original request URL cannot be read.",
      );
    }
    if (hostOf(resourceUrl) !== originalHost) {
      return refusal(
        "RESOURCE_HOST_MISMATCH",
        `The resource host does not match the host the agent asked (${originalHost}).`,
      );
    }
  }

  const terms: CanonicalTerms = {
    schema: "odingard.guardian.x402.pay.v1",
    x402Version,
    scheme: "exact",
    network,
    networkName: pinned.networkName,
    asset: pinned.asset,
    assetSymbol: pinned.symbol,
    amount: rawAmount,
    amountDisplay: `${formatAtomic(rawAmount, pinned.decimals)} ${pinned.symbol}`,
    payTo: r.payTo.toLowerCase(),
    maxTimeoutSeconds: timeout,
    extra: {
      name: pinned.name,
      version: pinned.version,
      assetTransferMethod: "eip3009",
      paymentFlow: "authorization",
    },
    resourceUrl,
    request: {
      transport: request.transport,
      method: request.method,
      originalUrl: request.originalUrl,
      finalUrl: request.finalUrl,
    },
  };
  return { ok: true, terms, pinned };
}

/**
 * Same request = same method, original URL and resource URL. On MCP the
 * resource is named by the server, so the key is the called tool alone.
 */
export function requestKeyOf(terms: CanonicalTerms): string {
  if (terms.request.transport === "mcp") {
    return JSON.stringify(["mcp", terms.request.method, terms.request.originalUrl]);
  }
  return JSON.stringify([
    terms.request.transport,
    terms.request.method.toUpperCase(),
    terms.request.originalUrl,
    terms.resourceUrl,
  ]);
}
