# @odingard/guardian-x402

Guardian for [x402](https://github.com/x402-foundation/x402) payments. Before
the agent's wallet signs an x402 payment, Guardian decides ALLOW, ASK or DENY
on the exact payment terms. The wallet signs only after an ALLOW or a person's
approval, only once, and only those terms.

**Decision-gated, not enforced outside your process.** Your agent's process
holds the wallet key. The guard governs payments made through the clients it
builds. It cannot stop code that signs with the key some other way. See
[Not governed](#not-governed).

**Status.** Works with USDC on Base Sepolia (testnet). Base mainnet is off by
default and unproven.

## What it covers

- The official x402 TypeScript clients, version 2.30.x (the guard refuses to
  start with any other version): `wrapFetchWithPayment`
  (`@x402/fetch`), `wrapAxiosWithPayment` (`@x402/axios`) and `x402MCPClient`
  (`@x402/mcp`). The guard builds them; you do not pass your own.
- x402 versions 1 and 2 over HTTP; version 2 over MCP.
- Scheme `exact`, transfer method `eip3009`, payment flow `authorization`.
- USDC on Base Sepolia (`eip155:84532`). USDC on Base mainnet
  (`eip155:8453`) only when you name it in `enabledNetworks`.

Everything else is refused, not ignored: other schemes (`upto`, …), `permit2`
and `erc7710`, `upfront` and `escrow`, `extra.splits`, unknown `extra` fields,
other networks and assets, and terms the guard cannot read exactly.

## Setup

1. In the Guardian console, on a tool connection, install and enable two
   record-transport catalog entries for your agent: `x402.pay` and
   `x402.pay.above_cap`. Without them Guardian refuses (`TOOL_NOT_IN_CATALOG`
   or `TOOL_NOT_GRANTED`) and nothing is signed. The guard never installs
   them itself.
2. Allow `x402.pay` with a rule if small payments may go through without a
   person. `x402.pay.above_cap` always needs a person: the guard refuses a
   rule ALLOW for it.

```bash
npm install @odingard/guardian-x402 @odingard/guardian-sdk @x402/core @x402/evm @x402/fetch
```

```ts
import { createGuardianClient } from "@odingard/guardian-sdk";
import { createX402Guard } from "@odingard/guardian-x402";
import { guardedFetch } from "@odingard/guardian-x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const guard = createX402Guard({
  guardian: createGuardianClient({
    baseUrl: "https://guardian-api.odingard.com",
    credential: process.env.GUARDIAN_AGENT_CREDENTIAL!,
  }),
  connectionId: "pcn_…", // the connection holding x402.pay and x402.pay.above_cap
  signer: privateKeyToAccount(process.env.TESTNET_WALLET_KEY as `0x${string}`),
  limits: [
    {
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC, Base Sepolia
      askAbove: "100000", // 0.10 USDC, in atomic units
      max: "1000000", //      1.00 USDC: above this, refused locally
    },
  ],
  store: myDurableStore, // optional; see "Live authorizations"
});

const pay = guardedFetch(guard, fetch);
const res = await pay("https://api.example.com/paid");
```

Axios and MCP:

```ts
import { guardedAxios } from "@odingard/guardian-x402/axios";
import { guardedMcpClient } from "@odingard/guardian-x402/mcp";

const api = guardedAxios(guard, axios.create()); // use the returned instance only
const mcp = guardedMcpClient(guard, new Client({ name: "agent", version: "1.0.0" }));
await mcp.connect(transport);
await mcp.callTool("get_weather", { city: "Oslo" });
```

## How a payment is decided

The guard registers its hooks on the official `x402Client` and hands x402 a
wrapped signer. For each payment:

1. x402 applies its own `spendControls` (default cap: 1 USDC per payment).
   The guard keeps them on and cannot turn them off. A `max` or `askAbove`
   above 1 USDC is never reached unless you raise `maxAmountPerPayment`.
2. The guard's policy drops every entry it cannot pay, so a mixed list picks
   a supported one.
3. In `onBeforePaymentCreation`, the guard reads the selected entry into one
   canonical terms object (below), copies and freezes it, and runs local
   checks: `max`, the `payTo` allowlist, live authorizations, the budget.
4. It asks Guardian (`tool.invoke` on `x402.pay` or `x402.pay.above_cap`, with
   the terms as arguments). On ASK it polls `claim` until a person decides or
   the request expires (default 120 s, at most 300 s). A claim answer that
   decides nothing (Guardian unreachable, `RATE_LIMITED`, `DB_BUSY`, HTTP 429
   or 5xx) keeps the request held: the guard keeps waiting for the person
   until the request expires, and signs nothing meanwhile. On ALLOW it calls
   `execute`, where Guardian checks single use, expiry and revocation. For an
   above-cap payment it then reads the receipt and continues only if it is
   the receipt for this request and shows an ASK that a person approved
   (approval state `approved`, or `consumed` once `execute` redeemed it).
5. It stores a single-use signing token for this payment (valid 30 s by
   default, `signingWindowMs`, at most 120 s).
6. The wrapped signer signs only EIP-3009 `TransferWithAuthorization` typed
   data that matches the frozen terms field by field: types, domain (`name`,
   `version`, `chainId`, `verifyingContract`, nothing else), `from`, `to`,
   `value`, `validAfter`, `validBefore` and a 32-byte nonce. It refuses if the
   token is missing, used or expired, or if the selected entry changed after
   the decision. It refuses every other signing call; it does not sign
   transactions.

An unreachable Guardian, a timeout, malformed answers, a failed `execute`,
an approval that never comes, or a refusal at any step means no signature.

Each payment runs in its own flow (`AsyncLocalStorage`), so concurrent
payments never share an approval.

### What Guardian sees

```json
{
  "schema": "odingard.guardian.x402.pay.v1",
  "x402Version": 2,
  "scheme": "exact",
  "network": "eip155:84532",
  "networkName": "Base Sepolia",
  "asset": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  "assetSymbol": "USDC",
  "amount": "10000",
  "amountDisplay": "0.01 USDC",
  "payTo": "0x…",
  "maxTimeoutSeconds": 60,
  "extra": { "name": "USDC", "version": "2", "assetTransferMethod": "eip3009", "paymentFlow": "authorization" },
  "resourceUrl": "https://api.example.com/paid",
  "request": { "transport": "http", "method": "GET", "originalUrl": "https://api.example.com/paid", "finalUrl": "https://api.example.com/paid" },
  "reviewReasons": []
}
```

The receipt for each decision records these terms. Amounts are atomic units
of the asset; the display amount uses the guard's own pinned decimals. USDC is
never shown or treated as USD.

### What a receipt means

A receipt says Guardian authorized and redeemed one payment on these exact
terms. It does not say a payment was signed or settled. If signing fails after
`execute`, the decision is spent and the guard records "redeemed, not
signed"; a retry needs a new decision. If `execute` was sent but its outcome
is unknown (no answer, a 5xx, an unreadable receipt; sdk 0.4.0
`outcomeUnknown`), nothing is signed. The refusal (`EXECUTE_FAILED`) says the
outcome is unknown and names the request id; its record, and the
`X402GuardRefused` the guard's own client throws, carry `outcomeUnknown: true`.
Through `guardedFetch` and `guardedAxios`, x402 turns the refusal into a plain
error with only the message, so `err.outcomeUnknown` is not set there: read the
record (`records()` or `onRecord`) or the message instead.
The guard records "redeemed or unknown, not signed": the decision may be spent,
so look the request up before retrying. The guard's local records (`records()`
or `onRecord`) link the Guardian request id to the signed nonce and
`validBefore`, then to the settlement (`success`, `transaction`, `network`).
They never hold a key, a signature or a payment payload.

## Local rules

- **`limits`** per (network, asset), in atomic units: above `max` is refused
  without asking Guardian; above `askAbove` goes to `x402.pay.above_cap`. An
  asset with no limit: every payment needs a person. One asset's limit never
  applies to another.
- **`payTo` allowlist** (optional, in a limit). Guardian rules on `x402.pay`
  match the tool, not the recipient: a console ALLOW rule allows every
  `payTo` up to `askAbove`. Use the allowlist for recipient control.
- **Resource host.** The host of `resource.url` must equal the host of the URL
  the agent asked for (before redirects). A mismatch is refused.
- **MCP resource.** On MCP, `resource.url` must name the tool the agent
  called, exactly. A paid MCP server must use one of:
  - `mcp://tool/<tool name>`. Set it yourself:
    `createPaymentWrapper(..., { resource: { url: "mcp://tool/get_weather" } })`.
    If you leave `resource.url` unset, `@x402/mcp` 2.30.0 names
    `mcp://tool/paid_tool` whatever the tool is called, and the guard refuses it;
  - `<origin of serverUrl>/tools/<tool name>` (no query, no fragment, tool
    name percent-encoded), accepted only when you pass `serverUrl` to
    `guardedMcpClient`. For `serverUrl: "https://mcp.example.com/mcp"` and
    tool `get_weather`: `https://mcp.example.com/tools/get_weather`.

  Anything else is refused with `RESOURCE_HOST_MISMATCH` before Guardian is
  asked, including another tool (`mcp://tool/other_tool`), another path on
  the server host, or the right path with a query.
- **`maxTimeoutSeconds`** above `maxTimeoutSecondsLimit` (default 300) is
  refused.

### Live authorizations

A signed authorization can be settled until its `validBefore`, whatever the
server says. The guard counts every signed, unexpired authorization as live.
A second payment for the same request while one is live goes to
`x402.pay.above_cap` and needs a person. Same request means: any payment made
while serving the same `fetch`, axios or `callTool` call, whatever resource
the server names; the same method, original URL and `resource.url` over HTTP;
the same tool over MCP. This covers x402's retry paths (fetch and axios `recovered`, MCP
corrective 402). In fetch, x402 can sign and then stop with "Payment already
attempted"; the guard records that authorization as signed, not sent, and
keeps it live.

With a `store`, live authorizations survive a restart. **Without a store**,
the guard cannot know what an earlier process signed, so every payment in the
first `maxTimeoutSecondsLimit` seconds after start needs a person.

### Budgets

Optional, per (network, asset), per UTC day or month, in atomic units. They
need a `store` with an atomic compare-and-set:

```ts
interface X402GuardStore {
  get(key: string): Promise<{ value: string; version: string } | null>;
  compareAndSet(key: string, expectedVersion: string | null, value: string): Promise<boolean>;
}
```

The amount is reserved before Guardian is asked. It is released only if
nothing was signed, or when `reconcile()` finds `validBefore` passed by more
than 5 minutes (the chain checks block time, which can lag your clock) and the
token's `authorizationState(from, nonce)` shows the nonce unused (pass
`authorizationState`, for example `authorizationStateReader` with a viem
public client's `readContract`). Otherwise it stays spent, including after
`success: false`. If the store cannot be read or written, the payment is
refused. `reconcile()` also releases a reservation whose payment never
reached signing, but only after the longest time that payment could still be
deciding; a payment whose reservation was released is never signed. These are
local budgets, not Guardian-enforced budgets.

## Not governed

- Code that signs with the wallet key directly, or any x402 client the guard
  did not build.
- Hooks you add to the guard's clients afterwards. The guarded client refuses
  new schemes, extensions and `onPaymentCreationFailure` hooks
  (`GUARD_SEALED`), because a failure hook could return its own payload in
  place of a refusal. Other hooks still run as you write them.
- `callToolWithPayment` on the MCP client with a payload made outside the
  guard, and anything sent through the MCP client's `client` getter.
- Calls on the original axios instance instead of the one `guardedAxios`
  returns. The guard refuses payments it sees there (no original URL), but
  it cannot see code that bypasses the interceptors.
- Console USD-cent caps, spending budgets and recipient rules: they do not
  apply to x402 payments.

Do not turn off x402's `spendControls`.

## Refusal codes

Refusals throw `X402GuardRefused` (through x402 the message reads
`Failed to create payment payload: [guardian-x402 CODE] …`). Guardian's own
reason follows the code, for example `GUARDIAN_DENIED:TOOL_NOT_GRANTED`.

## Example

[`examples/x402/simulated-payments.mjs`](../../examples/x402) (SIMULATED:
stand-in Guardian, in-memory server, throwaway key, no network).

## License

Apache-2.0
