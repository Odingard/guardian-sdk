# @odingard/guardian-steel

Guardian for [Steel](https://steel.dev) browser agents. The agent can only
**propose** `steel.checkout.submit` to Guardian; Guardian decides
ALLOW / ASK / DENY before the order exists, and the protected executor places
the exact approved order and returns a receipt.

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
const out = await steel.submitOrder(order); // executed | pending-approval | denied | failed | not-executed
if (out.status === "pending-approval") await steel.resume(out.requestId); // after the human approves
```

## Enforcement boundary

| Side                               | Holds                                                  | Package export                                                                   |
| ---------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Agent (untrusted)                  | Guardian agent credential, connection id               | `createGuardianSteelDispatcher`                                                  |
| Protected executor (Guardian side) | Steel API key/session, CDP socket, merchant credential | `createSteelToolRecordPort`, `createSteelCheckoutExecutor`, `createSteelBrowser` |

Only a verified effect (`sent-verified`) is reported as `executed`. An ASK is
never executed until `resume` claims the human-approved capability; DENY and
an unreachable Guardian both refuse.

## Maturity (honest)

- Agent-side dispatcher: published here, unit-tested.
- Protected executor over a real Steel session: proven **in-process**
  (8/8 security proofs, 5/5 live tests).
- Hosted Guardian does **not yet** inject the Steel record port, so a hosted
  Steel connection is not available today. The executor exports exist so a
  self-run protected boundary can be assembled.
- Bypass risk: an agent that is also given a Steel API key or CDP URL can
  drive the browser directly. Keep those only on the executor side.

Source is generated from Guardian's canonical Steel adapter — do not
edit the files under `src/` here.
