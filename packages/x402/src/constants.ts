/** Guardian tool names the guard proposes (`tool.invoke`, record transport). */
export const PAY_TOOL = "x402.pay";
export const PAY_ABOVE_CAP_TOOL = "x402.pay.above_cap";

export const BASE_SEPOLIA = "eip155:84532";
export const BASE_MAINNET = "eip155:8453";

export type SupportedNetwork = typeof BASE_SEPOLIA | typeof BASE_MAINNET;

export type PinnedAsset = Readonly<{
  network: SupportedNetwork;
  chainId: number;
  networkName: string;
  /** Lowercase token contract address. */
  asset: string;
  /** EIP-712 domain name and version of the token. */
  name: string;
  version: string;
  decimals: number;
  symbol: string;
}>;

/**
 * The only assets the guard pays in. Values are the guard's own pins, not
 * read from the 402 response.
 */
export const PINNED_ASSETS: readonly PinnedAsset[] = Object.freeze([
  Object.freeze({
    network: BASE_SEPOLIA,
    chainId: 84532,
    networkName: "Base Sepolia",
    asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    name: "USDC",
    version: "2",
    decimals: 6,
    symbol: "USDC",
  }),
  Object.freeze({
    network: BASE_MAINNET,
    chainId: 8453,
    networkName: "Base",
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    name: "USD Coin",
    version: "2",
    decimals: 6,
    symbol: "USDC",
  }),
]);

/** x402 v1 network names the guard maps. Nothing else is mapped. */
export const V1_NETWORK_NAMES: Readonly<Record<string, SupportedNetwork>> =
  Object.freeze({
    "base-sepolia": BASE_SEPOLIA,
    base: BASE_MAINNET,
  });

/** The EIP-3009 typed-data types, exactly as signed. */
export const EIP3009_TYPES = Object.freeze({
  TransferWithAuthorization: Object.freeze([
    Object.freeze({ name: "from", type: "address" }),
    Object.freeze({ name: "to", type: "address" }),
    Object.freeze({ name: "value", type: "uint256" }),
    Object.freeze({ name: "validAfter", type: "uint256" }),
    Object.freeze({ name: "validBefore", type: "uint256" }),
    Object.freeze({ name: "nonce", type: "bytes32" }),
  ]),
});

export const DEFAULT_MAX_TIMEOUT_SECONDS_LIMIT = 300;
export const DEFAULT_SIGNING_WINDOW_MS = 30_000;
export const DEFAULT_CLAIM_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_GUARDIAN_CALL_TIMEOUT_MS = 15_000;
export const MAX_SIGNING_WINDOW_MS = 120_000;
export const MAX_CLAIM_POLL_INTERVAL_MS = 60_000;
export const MAX_GUARDIAN_CALL_TIMEOUT_MS = 60_000;
/** How long past `validBefore` reconcile waits before reading the nonce. */
export const RECONCILE_MARGIN_MS = 300_000;

export function pinnedAsset(
  network: string,
  asset: string,
): PinnedAsset | undefined {
  const lower = asset.toLowerCase();
  return PINNED_ASSETS.find((a) => a.network === network && a.asset === lower);
}

export function pinnedAssetsOn(network: string): PinnedAsset[] {
  return PINNED_ASSETS.filter((a) => a.network === network);
}
