<img src="https://raw.githubusercontent.com/Odingard/guardian-sdk/main/assets/guardian-mark.svg" alt="Guardian" width="48" height="48" />

# @odingard/guardian-steel

**Guardian is the trust layer for agent commerce.** Human Authority Infrastructure for Autonomous AI: the agent proposes; the human decides.

Guardian for [Steel](https://steel.dev) browser agents. The agent can only
**propose** `steel.checkout.submit` to Guardian; Guardian decides
ALLOW / ASK / DENY before the order exists, and the protected executor places
the exact approved order and returns a signed decision record.

Hosted Guardian has no protected Steel executor. There, a Steel checkout is
recorded but no order is placed, and the dispatcher returns
`{ status: "not-executed", reasonCode: "NO_PROTECTED_EXECUTOR" }`.

```ts
import { createGuardianClient } from "@odingard/guardian-sdk";
import { createGuardianSteelDispatcher } from "@odingard/guardian-steel";

const steel = createGuardianSteelDispatcher({
  guardian: createGuardianClient({
    baseUrl,
    credential: process.env.GUARDIAN_AGENT_CREDENTIAL!,
  }),
  connectionId: "pcn_…", // the Steel tool connection
});
const out = await steel.submitOrder(order); // executed | pending-approval | denied | failed | not-executed | outcome-unknown
if (out.status === "pending-approval") await steel.resume(out.requestId); // after the human approves
```

The Steel integration does not pin the contents of local files. The path is bound; the file's bytes are not.

## Enforcement boundary

| Side                               | Holds                                                  | Package export                                                                   |
| ---------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Agent (untrusted)                  | Guardian agent credential, connection id               | `createGuardianSteelDispatcher`                                                  |
| Protected executor (Guardian side) | Steel API key/session, CDP socket, merchant credential | `createSteelToolRecordPort`, `createSteelCheckoutExecutor`, `createSteelBrowser` |

Only a verified effect (`sent-verified`) is reported as `executed`. An ASK is
never executed until `resume` claims the human-approved capability; DENY and
an unreachable Guardian both refuse.

- An unreachable Guardian comes back as `{ status: "denied", reasonCode:
"SERVICE_UNAVAILABLE" }`, which is how the Guardian SDK client reports a
  network failure. `GUARDIAN_UNAVAILABLE` appears only when your own client
  throws instead.
- On a Guardian that has no protected Steel executor, the call is recorded
  but no order is placed. The dispatcher reports that as
  `{ status: "not-executed", reasonCode: "NO_PROTECTED_EXECUTOR" }`, never as
  `executed`.
- `outcome-unknown` means the order may have been placed: Guardian's recorded status
  is `outcome-pending` or `outcome-unconfirmed` (for example the
  confirmation page timed out after the buy button was clicked), or the signed
  record could not be fetched (`reasonCode: "RECEIPT_UNVERIFIED"`). Do not
  retry the order before checking the merchant or Guardian's record.
  `not-executed` without a reason code means Guardian's recorded status is
  `not-sent`: no order was placed.
- Once the execute call has been sent, a lost, 5xx or unreadable answer is
  also `outcome-unknown`, with `reasonCode: "EXECUTE_RESPONSE_LOST"` and what
  the client saw in `detail` (for example `SERVICE_UNAVAILABLE`): Guardian may
  have placed the order. `failed` means Guardian refused the redemption, so
  no order was placed and a new request is safe.
- The executor accepts a confirmation only if it shows the authorized
  merchant, SKU, quantity, total and currency; anything else is
  `ORDER_NOT_CONFIRMED` and is treated as possibly placed. The reported result
  is built from the confirmed values.
- In the executor, a page failure after the buy button was clicked is
  reported as `SUBMIT_OUTCOME_UNKNOWN` (the order may exist; check the
  merchant), not as "not submitted", and its evidence records
  `outcome: "unknown"`. A browser setup failure releases the Steel session.

## Limits

- The executor exports exist so a self-run protected boundary can be
  assembled.
- Bypass risk: an agent that is also given a Steel API key or CDP URL can
  drive the browser directly. Keep those on the executor side.

Source is generated from Guardian's canonical Steel adapter — do not
edit the files under `src/` here.
