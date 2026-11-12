export {
  createX402Guard,
  GuardedX402Client,
  X402Guard,
  type AssetLimit,
  type X402GuardConfig,
  type X402GuardRecord,
  type X402WalletSigner,
} from "./guard.js";
export {
  BASE_MAINNET,
  BASE_SEPOLIA,
  EIP3009_TYPES,
  PAY_ABOVE_CAP_TOOL,
  PAY_TOOL,
  PINNED_ASSETS,
  type PinnedAsset,
  type SupportedNetwork,
} from "./constants.js";
export {
  type AuthorizationStateReader,
  type BudgetConfig,
  type LedgerEntry,
  type X402GuardStore,
} from "./ledger.js";
export { readTerms, type CanonicalTerms, type PaymentRequestInfo } from "./terms.js";
export { X402GuardRefused, type RefusalCode } from "./util.js";

/** ABI fragment for EIP-3009 `authorizationState(address,bytes32)`. */
export const AUTHORIZATION_STATE_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * An `authorizationState` reader from a `readContract` function (a viem
 * public client's, for example) per network. Used by `reconcile()`.
 */
export function authorizationStateReader(
  readContractFor: (network: string) =>
    | ((args: {
        address: `0x${string}`;
        abi: typeof AUTHORIZATION_STATE_ABI;
        functionName: "authorizationState";
        args: readonly [`0x${string}`, `0x${string}`];
      }) => Promise<unknown>)
    | undefined,
): import("./ledger.js").AuthorizationStateReader {
  return async ({ network, asset, from, nonce }) => {
    const read = readContractFor(network);
    if (!read) throw new Error(`no reader for ${network}`);
    const used = await read({
      address: asset as `0x${string}`,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: "authorizationState",
      args: [from as `0x${string}`, nonce as `0x${string}`],
    });
    if (typeof used !== "boolean") throw new Error("authorizationState is not a boolean");
    return used;
  };
}
