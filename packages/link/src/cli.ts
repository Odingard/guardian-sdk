// A Link adapter that runs the Stripe Link CLI (`link-cli`, from
// `@stripe/link-cli`) in test mode. It holds the path to the guard's own
// Link login file, refuses a login file anyone else can read, passes
// `--test` on every create, never passes `--approve` or
// `--use-approval-policy`, reads cards only through `--output-file` into a
// private folder it deletes, and never puts the CLI's output in an error.
import { execFile } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type {
  LinkAdapter,
  LinkApprovalPolicyState,
  LinkCardData,
  LinkCreateInput,
  LinkLineItem,
  LinkSpendRequestView,
  LinkTotal,
  LinkUpdateInput,
} from "./adapter.js";
import { SPEND_REQUEST_ID_RE } from "./constants.js";
import { isPlainObject } from "./util.js";

export type LinkCliRunResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

/** Runs one CLI command without a shell. Replaceable for tests. */
export type LinkCliRunner = (
  file: string,
  args: readonly string[],
  opts: Readonly<{ timeoutMs: number; env: Readonly<Record<string, string | undefined>> }>,
) => Promise<LinkCliRunResult>;

export type LinkCliAdapterConfig = Readonly<{
  /**
   * The guard's own Link login file (`link-cli auth login --auth <path>`).
   * Must be a regular file readable by its owner only (mode 0600). Never
   * give this path to the agent.
   */
  authPath: string;
  /** The CLI command. Default `["link-cli"]`. For example `["npx", "@stripe/link-cli@<version>"]`. */
  command?: readonly string[];
  /** Per-command limit. Default 60 s. */
  timeoutMs?: number;
  /** For tests: runs the command. Default: `execFile`, no shell. */
  run?: LinkCliRunner;
  /** For tests: where the private card folder is made. Default: the OS temp folder. */
  tmpDir?: string;
}>;

/** A CLI call failed. Carries no CLI output, so it can never carry card details. */
export class LinkCliError extends Error {
  readonly exitCode: number | null;
  constructor(what: string, exitCode: number | null) {
    super(`link-cli ${what} failed${exitCode === null ? "" : ` (exit ${exitCode})`}.`);
    this.name = "LinkCliError";
    this.exitCode = exitCode;
  }
}

/** Environment the CLI would read in place of `--auth` or the real Link hosts. */
const STRIPPED_ENV = [
  "LINK_AUTH_FILE",
  "LINK_ACCESS_TOKEN",
  "LINK_REFRESH_TOKEN",
  "LINK_NO_REFRESH",
  "LINK_API_BASE_URL",
  "LINK_AUTH_BASE_URL",
  "LINK_HTTP_PROXY",
];

const defaultRun: LinkCliRunner = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: opts.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: opts.env as NodeJS.ProcessEnv,
        windowsHide: true,
        shell: false,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? -1
              : 0;
        resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

function checkAuthFile(path: string): void {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("guardian-link: `authPath` must be an absolute path.");
  }
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error("guardian-link: the Link login file does not exist; run `link-cli auth login --auth <path>` first.");
  }
  if (!st.isFile()) throw new Error("guardian-link: the Link login file must be a regular file, not a link.");
  if ((st.mode & 0o077) !== 0) {
    throw new Error("guardian-link: the Link login file must be readable by its owner only (chmod 600).");
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error("guardian-link: the Link login file must belong to the user running the guard.");
  }
}

function lineItemFlag(item: LinkLineItem): string {
  return `name:${item.name},unit_amount:${item.unitAmount},quantity:${item.quantity}`;
}

function totalFlag(total: LinkTotal): string {
  return `type:${total.type},display_text:${total.displayText},amount:${total.amount}`;
}

/** The CLI's JSON output: an object, or an array whose last item is the result. */
function parseOutput(stdout: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) parsed = parsed.at(-1);
  return isPlainObject(parsed) ? parsed : null;
}

const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Reads Link's snake_case spend request into the guard's view. Drops any card. */
export function viewFromLink(raw: Record<string, unknown>): LinkSpendRequestView {
  const view: Record<string, unknown> = { id: str(raw.id) ?? "", status: str(raw.status) ?? "" };
  const set = (key: string, value: unknown) => {
    if (value !== undefined) view[key] = value;
  };
  set("merchantName", str(raw.merchant_name));
  set("merchantUrl", str(raw.merchant_url));
  set("context", str(raw.context));
  set("amount", num(raw.amount));
  set("currency", str(raw.currency));
  set("credentialType", str(raw.credential_type));
  if (Array.isArray(raw.line_items)) {
    view.lineItems = raw.line_items.map((it: unknown) =>
      isPlainObject(it) ? { name: it.name, quantity: it.quantity, unitAmount: it.unit_amount } : {},
    );
  }
  if (Array.isArray(raw.totals)) {
    view.totals = raw.totals.map((t: unknown) =>
      isPlainObject(t) ? { type: t.type, displayText: t.display_text, amount: t.amount } : {},
    );
  }
  return view as LinkSpendRequestView;
}

function checkId(id: string): void {
  if (typeof id !== "string" || !SPEND_REQUEST_ID_RE.test(id)) {
    throw new Error("guardian-link: not a Link spend request id.");
  }
}

/**
 * Builds a Link adapter that runs the Link CLI. Only test-mode spend
 * requests are created.
 */
export function linkCliAdapter(config: LinkCliAdapterConfig): LinkAdapter {
  checkAuthFile(config.authPath);
  const command = config.command ?? ["link-cli"];
  if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === "string" && c)) {
    throw new Error("guardian-link: `command` must list the CLI and its leading arguments.");
  }
  const [file, ...lead] = command as string[];
  const run = config.run ?? defaultRun;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const authPath = config.authPath;
  const env: Record<string, string | undefined> = { ...process.env, NO_UPDATE_NOTIFIER: "1" };
  for (const k of STRIPPED_ENV) delete env[k];

  const cli = async (what: string, args: readonly string[]): Promise<LinkCliRunResult> => {
    checkAuthFile(authPath);
    let result: LinkCliRunResult;
    try {
      result = await run(file!, [...lead, ...args, "--format", "json", "--auth", authPath], { timeoutMs, env });
    } catch {
      throw new LinkCliError(what, null);
    }
    return result;
  };

  const request = async (what: string, args: readonly string[]): Promise<LinkSpendRequestView> => {
    const result = await cli(what, args);
    if (result.exitCode !== 0) throw new LinkCliError(what, result.exitCode);
    const out = parseOutput(result.stdout);
    if (!out) throw new LinkCliError(what, result.exitCode);
    return viewFromLink(out);
  };

  return Object.freeze({
    async approvalPolicy(): Promise<LinkApprovalPolicyState> {
      const result = await cli("approval-policy retrieve", ["approval-policy", "retrieve"]);
      if (result.exitCode !== 0) {
        // Link answers "no policy" with an API error. Only a 404 for this
        // call is read as "none"; any other failure is unknown.
        return /retrieve approval policy \(404\)/.test(`${result.stdout}\n${result.stderr}`)
          ? { state: "none" }
          : { state: "unknown", detail: "approval-policy retrieve failed" };
      }
      const out = parseOutput(result.stdout);
      if (!out || !Array.isArray(out.rules)) return { state: "unknown", detail: "unreadable policy" };
      return out.rules.length === 0 ? { state: "none" } : { state: "present" };
    },

    async createSpendRequest(input: LinkCreateInput) {
      if (input.test !== true || input.requestApproval !== false || input.credentialType !== "card") {
        throw new Error("guardian-link: only test-mode card spend requests are created.");
      }
      return request("spend-request create", [
        "spend-request",
        "create",
        "--test",
        "--credential-type",
        "card",
        "--merchant-name",
        input.merchantName,
        "--merchant-url",
        input.merchantUrl,
        "--context",
        input.context,
        "--amount",
        String(input.amount),
        "--currency",
        input.currency,
        ...input.lineItems.flatMap((li) => ["--line-item", lineItemFlag(li)]),
        ...input.totals.flatMap((t) => ["--total", totalFlag(t)]),
        "--idempotency-key",
        input.idempotencyKey,
        "--no-request-approval",
      ]);
    },

    async updateSpendRequest(id: string, input: LinkUpdateInput) {
      checkId(id);
      return request("spend-request update", [
        "spend-request",
        "update",
        id,
        "--merchant-url",
        input.merchantUrl,
        "--amount",
        String(input.amount),
        "--currency",
        input.currency,
        ...input.lineItems.flatMap((li) => ["--line-item", lineItemFlag(li)]),
        ...input.totals.flatMap((t) => ["--total", totalFlag(t)]),
      ]);
    },

    async requestApproval(id: string) {
      checkId(id);
      const result = await cli("spend-request request-approval", ["spend-request", "request-approval", id]);
      if (result.exitCode !== 0) throw new LinkCliError("spend-request request-approval", result.exitCode);
    },

    async retrieveSpendRequest(id: string) {
      checkId(id);
      return request("spend-request retrieve", ["spend-request", "retrieve", id]);
    },

    async readCard(id: string) {
      checkId(id);
      const dir = mkdtempSync(join(config.tmpDir ?? tmpdir(), "guardian-link-"));
      const out = join(dir, "card.json");
      try {
        const result = await cli("spend-request retrieve --include card", [
          "spend-request",
          "retrieve",
          id,
          "--include",
          "card",
          "--output-file",
          out,
        ]);
        if (result.exitCode !== 0) throw new LinkCliError("spend-request retrieve --include card", result.exitCode);
        const shown = parseOutput(result.stdout);
        if (!shown) throw new LinkCliError("spend-request retrieve --include card", result.exitCode);
        let saved: unknown;
        try {
          saved = JSON.parse(readFileSync(out, "utf8"));
        } catch {
          throw new LinkCliError("spend-request retrieve --include card (card file)", result.exitCode);
        }
        if (!isPlainObject(saved) || saved.spend_request_id !== id || !isPlainObject(saved.card)) {
          throw new LinkCliError("spend-request retrieve --include card (card file)", result.exitCode);
        }
        const c = saved.card;
        const card: LinkCardData = {
          number: String(c.number ?? ""),
          ...(typeof c.cvc === "string" ? { cvc: c.cvc } : {}),
          expMonth: Number(c.exp_month),
          expYear: Number(c.exp_year),
          ...(typeof c.brand === "string" ? { brand: c.brand } : {}),
          ...(isPlainObject(c.billing_address)
            ? { billingAddress: c.billing_address as Record<string, string | undefined> }
            : {}),
          ...(typeof c.valid_until === "string" ? { validUntil: c.valid_until } : {}),
        };
        return { request: viewFromLink(shown), card };
      } finally {
        try {
          const size = statSync(out).size;
          writeFileSync(out, Buffer.alloc(size));
        } catch {
          // no file was written
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async cancelSpendRequest(id: string) {
      checkId(id);
      const result = await cli("spend-request cancel", ["spend-request", "cancel", id]);
      if (result.exitCode !== 0) throw new LinkCliError("spend-request cancel", result.exitCode);
    },
  });
}
