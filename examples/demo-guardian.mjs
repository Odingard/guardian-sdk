/**
 * demo-guardian.mjs — a LOCAL demo policy for running these examples with
 * zero credentials. It is NOT Guardian: no signing, no vault, no receipts
 * chain — just a deterministic in-memory stand-in for the client surface so
 * `node <example>.mjs` works out of the box.
 *
 * To run the SAME code against real hosted Guardian instead, set:
 *   GUARDIAN_BASE_URL=https://guardian-api.odingard.com
 *   GUARDIAN_AGENT_CREDENTIAL=gak_…   (issued per agent in the console)
 *   GUARDIAN_CONNECTION_ID=pcn_…
 * and the examples use @odingard/guardian-sdk's real client unchanged.
 */
import { createGuardianClient } from "@odingard/guardian-sdk";

/**
 * Demo policy — a tiny deterministic table standing in for the real kernel.
 * Tools are DENY-listed, ASK-listed, or ALLOW by default.
 */
const POLICY = {
  deny: new Set([
    "export_contacts",
    "exfiltrate_secrets",
    "send_protected_data",
    "disclose_phi_external",
  ]),
  ask: new Set([
    "checkout_cart",
    "issue_refund",
    "run_command",
    "git_push",
    "delete_file",
    "send_email",
    "delegate_task",
    "pay_vendor",
    "deploy_production",
    "update_crm_record",
    "steel.checkout.submit",
  ]),
};

/**
 * Argument-aware demo rules. Return "ALLOW", "ASK"
 * or "DENY" to decide on the arguments; return undefined to fall back to the
 * name lists above. Real Guardian evaluates the policy you set in the
 * console — these rules only mirror a typical setup.
 */
const KNOWN_PAYEES = new Set(["acme-supplies", "northwind-logistics"]);
const RULES = {
  pay_invoice(args) {
    if (!KNOWN_PAYEES.has(args.payeeId)) return "DENY"; // never pay an unknown payee
    if (args.amountCents > 500_000) return "ASK"; // above $5,000 needs a human
    return "ALLOW";
  },
};

const pending = new Map(); // requestId -> invocation

export function createDemoGuardian() {
  return {
    async request(invocation) {
      const requestId = `req_${Math.random().toString(16).slice(2, 18)}`;
      pending.set(requestId, invocation);
      const ruled = RULES[invocation.toolName]?.(invocation.arguments ?? {});
      if (
        ruled === "DENY" ||
        (ruled === undefined && POLICY.deny.has(invocation.toolName))
      ) {
        return {
          ok: true,
          requestId,
          decision: "DENY",
          reasonCode: "POLICY_DENY",
        };
      }
      if (
        ruled === "ASK" ||
        (ruled === undefined && POLICY.ask.has(invocation.toolName))
      ) {
        return { ok: true, requestId, decision: "ASK" };
      }
      return {
        ok: true,
        requestId,
        decision: "ALLOW",
        capabilityToken: `gcap.demo.${requestId}`,
      };
    },
    async claim(requestId) {
      if (!pending.has(requestId)) {
        return { ok: false, reasonCode: "REQUEST_NOT_FOUND" };
      }
      // Demo mode: the human approval is simulated — real hosted Guardian
      // holds this until a human approves in the console.
      return {
        ok: true,
        requestId,
        decision: "ALLOW",
        capabilityToken: `gcap.demo.${requestId}`,
      };
    },
    async execute({ requestId, capabilityToken }) {
      pending.delete(requestId);
      return {
        ok: true,
        receipt: {
          schema: "odingard.guardian.receipt.v1",
          requestId,
          capabilityToken,
          decision: "ALLOW",
          status: "simulated",
          executedAtEpochMs: Date.now(),
          demo: true,
        },
      };
    },
    async receipts(requestId) {
      return { ok: true, requestId, receipts: [{ demo: true, requestId }] };
    },
  };
}

/**
 * Returns the real hosted Guardian client when env vars are set, otherwise
 * the local demo policy. Same interface either way — the example code never
 * changes.
 */
export function guardian() {
  const {
    GUARDIAN_BASE_URL,
    GUARDIAN_AGENT_CREDENTIAL,
    GUARDIAN_CONNECTION_ID,
  } = process.env;
  if (GUARDIAN_BASE_URL && GUARDIAN_AGENT_CREDENTIAL) {
    console.log(
      `[guardian] using real hosted Guardian at ${GUARDIAN_BASE_URL}`,
    );
    return {
      client: createGuardianClient({
        baseUrl: GUARDIAN_BASE_URL,
        credential: GUARDIAN_AGENT_CREDENTIAL,
      }),
      connectionId: GUARDIAN_CONNECTION_ID ?? "pcn_demo",
      demo: false,
    };
  }
  console.log(
    "[guardian] no credentials set — running against the LOCAL demo policy.\n" +
      "          Set GUARDIAN_BASE_URL / GUARDIAN_AGENT_CREDENTIAL /\n" +
      "          GUARDIAN_CONNECTION_ID to run against real hosted Guardian.\n",
  );
  return { client: createDemoGuardian(), connectionId: "pcn_demo", demo: true };
}
