// A Link adapter that runs the Stripe Link CLI (`link-cli`, from
// `@stripe/link-cli`) in test mode. It runs the CLI by absolute path only
// (never through PATH or npx), from a private folder of its own, holds the
// path to the guard's own Link login file, refuses a login file anyone else
// can read or change, passes `--test` on every create, never passes
// `--approve` or `--use-approval-policy`, reads cards only through
// `--output-file` into that private folder, which is deleted when the call
// ends, and never puts the CLI's output in an error.
import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

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
  opts: Readonly<{
    timeoutMs: number;
    env: Readonly<Record<string, string | undefined>>;
    /** A private folder the adapter made for this call. */
    cwd: string;
  }>,
) => Promise<LinkCliRunResult>;

export type LinkCliAdapterConfig = Readonly<{
  /**
   * The guard's own Link login file (`link-cli auth login --auth <path>`).
   * Must be an absolute path ending in `.json`, to a regular file (not a
   * link, one hard link only) owned by the user running the guard and
   * readable by that user only (mode 0600), in a folder owned by that user
   * that no one else can write to. Never give this path to the agent.
   */
  authPath: string;
  /**
   * The CLI command, by absolute path: for example
   * `["/usr/bin/node", "/opt/guard/node_modules/@stripe/link-cli/dist/cli.js"]`.
   * The first entry must be an absolute path to a file no one else can
   * write to; a bare name (looked up in PATH) and npx, npm, pnpm, yarn or
   * bun are refused. Other entries that are not flags must be absolute
   * paths. The CLI runs from a private folder the adapter makes, never from
   * the guard's working folder.
   */
  command: readonly string[];
  /** Per-command limit. Default 60 s. */
  timeoutMs?: number;
  /** For tests: runs the command. Default: `execFile`, no shell. */
  run?: LinkCliRunner;
  /**
   * Where the adapter makes its private folder for each call (and reads the
   * card in it). Default: the OS temp folder. Folders left behind by a
   * crash (`guardian-link-*`, owned by this user, older than twice the
   * per-command limit) are wiped when the adapter is built.
   */
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
        cwd: opts.cwd,
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

const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);

function checkAuthFile(path: string): void {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("guardian-link: `authPath` must be an absolute path.");
  }
  if (!path.endsWith(".json")) throw new Error("guardian-link: `authPath` must end in .json.");
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error("guardian-link: the Link login file does not exist; run `link-cli auth login --auth <path>` first.");
  }
  if (!st.isFile()) throw new Error("guardian-link: the Link login file must be a regular file, not a link.");
  if (st.nlink !== 1) throw new Error("guardian-link: the Link login file must have exactly one hard link.");
  if ((st.mode & 0o077) !== 0) {
    throw new Error("guardian-link: the Link login file must be readable by its owner only (chmod 600).");
  }
  if (uid() !== undefined && st.uid !== uid()) {
    throw new Error("guardian-link: the Link login file must belong to the user running the guard.");
  }
  let parent;
  try {
    parent = lstatSync(dirname(path));
  } catch {
    throw new Error("guardian-link: the Link login file's folder cannot be read.");
  }
  if (!parent.isDirectory()) throw new Error("guardian-link: the Link login file's folder must be a folder, not a link.");
  if (uid() !== undefined && parent.uid !== uid()) {
    throw new Error("guardian-link: the Link login file's folder must belong to the user running the guard.");
  }
  if ((parent.mode & 0o022) !== 0) {
    throw new Error("guardian-link: no one else may write to the Link login file's folder (chmod go-w).");
  }
}

/** Package runners that would fetch or resolve the CLI by name. */
const RUNNERS = new Set(["npx", "npm", "pnpm", "pnpx", "yarn", "bun", "bunx"]);

/**
 * A file the CLI command names (the program, or a script it runs): an
 * existing regular file owned by the guard's user or root that no one else
 * can write to, in a folder no one else can write to. Checked both where
 * the path points and, for a link, where it resolves.
 */
function checkCommandFile(path: string): void {
  let real: string;
  let st;
  try {
    real = realpathSync(path);
    st = statSync(real);
  } catch {
    throw new Error(`guardian-link: the \`command\` file ${path} does not exist.`);
  }
  if (!st.isFile()) throw new Error(`guardian-link: the \`command\` entry ${path} must be a regular file.`);
  if ((st.mode & 0o022) !== 0) {
    throw new Error(`guardian-link: no one else may write to the \`command\` file ${path}.`);
  }
  if (uid() !== undefined && st.uid !== uid() && st.uid !== 0) {
    throw new Error(`guardian-link: the \`command\` file ${path} must belong to the guard's user or root.`);
  }
  for (const folder of new Set([dirname(path), dirname(real)])) {
    let fst;
    try {
      fst = statSync(folder);
    } catch {
      throw new Error(`guardian-link: the folder of the \`command\` file ${path} cannot be read.`);
    }
    if ((fst.mode & 0o022) !== 0) {
      throw new Error(`guardian-link: no one else may write to the folder of the \`command\` file ${path}.`);
    }
  }
}

function checkCommand(command: unknown): string[] {
  if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === "string" && c)) {
    throw new Error("guardian-link: `command` must list the CLI and its leading arguments.");
  }
  const [file, ...lead] = command as string[];
  if (!isAbsolute(file!)) {
    throw new Error("guardian-link: `command` must start with an absolute path; a name looked up in PATH is refused.");
  }
  if (RUNNERS.has(basename(file!).replace(/\.(cmd|exe)$/i, "").toLowerCase())) {
    throw new Error("guardian-link: run the Link CLI by its own path, not through npx, npm, pnpm, yarn or bun.");
  }
  for (const arg of lead) {
    if (!arg.startsWith("-") && !isAbsolute(arg)) {
      throw new Error("guardian-link: every `command` entry that is not a flag must be an absolute path.");
    }
  }
  for (const entry of [file!, ...lead.filter((a) => !a.startsWith("-"))]) checkCommandFile(entry);
  return command as string[];
}

const DIR_PREFIX = "guardian-link-";

/**
 * Wipes and removes private folders a crash left behind: only folders
 * named `guardian-link-*`, owned by this user and not changed for longer
 * than `staleMs` (so a call still running elsewhere keeps its folder).
 */
function sweepStale(base: string, staleMs: number): void {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  const cutoff = Date.now() - staleMs;
  for (const name of names) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const dir = join(base, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (uid() !== undefined && st.uid !== uid()) || st.mtimeMs > cutoff) continue;
      for (const f of readdirSync(dir)) {
        const fp = join(dir, f);
        const fst = lstatSync(fp);
        if (fst.isFile()) writeFileSync(fp, Buffer.alloc(fst.size));
      }
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
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

/** Link fields the guard compares with the decided terms. */
const COMPARED = new Set([
  "merchant_name",
  "merchant_url",
  "context",
  "amount",
  "currency",
  "credential_type",
  "line_items",
  "totals",
]);
/**
 * Link fields that are not spend terms: Link's own state, and the person's
 * own payment method, chosen in Link. Not compared. `card` is dropped.
 */
const NOT_TERMS = new Set([
  "id",
  "status",
  "payment_method",
  "payment_details",
  "network_id",
  "card_brand",
  "card_last4",
  "approval_url",
  "card",
  "card_output_file",
  "status_details",
  "payment_status_details",
  "link_transaction_id",
  "activity_url",
  "created_at",
  "updated_at",
]);
/** Link fields the guard never sets: they must be absent, null or empty. */
const MUST_BE_EMPTY = new Set(["recurring", "metadata", "shared_payment_token", "link_pay_token"]);
const LINE_ITEM_FIELDS = new Set(["name", "quantity", "unit_amount"]);
const TOTAL_FIELDS = new Set(["type", "display_text", "amount"]);
/** Link's default expiry for a one-time request is 7 days; one hour of slack. */
const MAX_EXPIRY_MS = 7 * 24 * 3_600_000 + 3_600_000;

const empty = (v: unknown) =>
  v === undefined || v === null || v === "" || (isPlainObject(v) && Object.keys(v).length === 0);

/** Names of fields in `raw` the guard does not accept. */
function unexpectedFields(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (COMPARED.has(key) || NOT_TERMS.has(key)) continue;
    if (MUST_BE_EMPTY.has(key)) {
      if (!empty(value)) out.push(key);
      continue;
    }
    if (key === "expires_at") {
      if (value === null || value === undefined) continue;
      const created = typeof raw.created_at === "string" ? Date.parse(raw.created_at) : NaN;
      const expires = typeof value === "string" ? Date.parse(value) : NaN;
      if (!Number.isFinite(created) || !Number.isFinite(expires) || expires - created > MAX_EXPIRY_MS) {
        out.push("expires_at");
      }
      continue;
    }
    out.push(/^[a-z0-9_]{1,64}$/.test(key) ? key : "unknown_field");
  }
  const nested = (list: unknown, name: string, allowed: Set<string>) => {
    if (!Array.isArray(list)) return;
    list.forEach((it: unknown, i: number) => {
      if (!isPlainObject(it)) return;
      for (const [key, value] of Object.entries(it)) {
        if (!allowed.has(key) && value !== null && value !== undefined) {
          out.push(`${name}[${i}].${/^[a-z0-9_]{1,64}$/.test(key) ? key : "unknown_field"}`);
        }
      }
    });
  };
  nested(raw.line_items, "line_items", LINE_ITEM_FIELDS);
  nested(raw.totals, "totals", TOTAL_FIELDS);
  return out;
}

/**
 * Reads Link's snake_case spend request into the guard's view. Drops any
 * card. Fields the guard does not accept are named in `unexpectedFields`.
 */
export function viewFromLink(raw: Record<string, unknown>): LinkSpendRequestView {
  const view: Record<string, unknown> = {
    id: str(raw.id) ?? "",
    status: str(raw.status) ?? "",
    unexpectedFields: unexpectedFields(raw),
  };
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

/** What the CLI prints (JSON, exit 1) when no approval policy exists. */
const NO_POLICY_MESSAGE = "Failed to retrieve approval policy (404): No approval policy has been configured";

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
  const [file, ...lead] = checkCommand(config.command);
  const run = config.run ?? defaultRun;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const authPath = config.authPath;
  const base = config.tmpDir ?? tmpdir();
  const env: Record<string, string | undefined> = { ...process.env, NO_UPDATE_NOTIFIER: "1" };
  for (const k of STRIPPED_ENV) delete env[k];
  sweepStale(base, 2 * timeoutMs + 60_000);

  /** Runs one command from a fresh private folder (mode 0700), deleted when the call ends. */
  const inPrivateDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(base, DIR_PREFIX));
    try {
      return await fn(dir);
    } finally {
      try {
        for (const f of readdirSync(dir)) {
          const fp = join(dir, f);
          const st = lstatSync(fp);
          if (st.isFile()) writeFileSync(fp, Buffer.alloc(st.size));
        }
      } catch {
        // nothing was written
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const cliIn = async (dir: string, what: string, args: readonly string[]): Promise<LinkCliRunResult> => {
    checkAuthFile(authPath);
    try {
      return await run(file!, [...lead, ...args, "--format", "json", "--auth", authPath], { timeoutMs, env, cwd: dir });
    } catch {
      throw new LinkCliError(what, null);
    }
  };
  const cli = (what: string, args: readonly string[]) => inPrivateDir((dir) => cliIn(dir, what, args));

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
        // Link answers "no policy" with a 404 and its documented message.
        // Only exactly that is read as "none"; any other failure is unknown.
        const out = parseOutput(result.stdout);
        return out && out.message === NO_POLICY_MESSAGE
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
      // The card file is written into the call's private folder, which is
      // wiped and deleted when the call ends.
      return inPrivateDir(async (dir) => {
        const out = join(dir, "card.json");
        const what = "spend-request retrieve --include card";
        const result = await cliIn(dir, what, ["spend-request", "retrieve", id, "--include", "card", "--output-file", out]);
        if (result.exitCode !== 0) throw new LinkCliError(what, result.exitCode);
        const shown = parseOutput(result.stdout);
        if (!shown) throw new LinkCliError(what, result.exitCode);
        let saved: unknown;
        try {
          saved = JSON.parse(readFileSync(out, "utf8"));
        } catch {
          throw new LinkCliError(`${what} (card file)`, result.exitCode);
        }
        if (!isPlainObject(saved) || saved.spend_request_id !== id || !isPlainObject(saved.card)) {
          throw new LinkCliError(`${what} (card file)`, result.exitCode);
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
      });
    },

    async cancelSpendRequest(id: string) {
      checkId(id);
      const result = await cli("spend-request cancel", ["spend-request", "cancel", id]);
      if (result.exitCode !== 0) throw new LinkCliError("spend-request cancel", result.exitCode);
    },
  });
}
