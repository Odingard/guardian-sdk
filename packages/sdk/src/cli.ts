/**
 * `guardian-sdk verify`: check a Guardian receipt (`greceipt.v1`) from the
 * command line, with no Guardian account.
 *
 *   npx @odingard/guardian-sdk verify receipt.json
 *   npx @odingard/guardian-sdk verify receipt.json --keys keys.json
 *   npx @odingard/guardian-sdk verify receipt.json --base-url https://guardian.example.com
 *
 * Verification itself is offline (`verifyReceiptOffline`). The keys come
 * from `--keys` (a JSON key set; then nothing touches the network) or are
 * downloaded once from the public key endpoint of `--base-url`.
 *
 * Exit codes: 0 valid, 1 not valid, 2 usage or input error. `guardian-sdk --help`
 * exits 0; `verify` exits 0 only for a receipt that verifies.
 */
import { readFileSync } from "node:fs";

import { ReceiptVerificationKeySetSchema } from "./contracts/receipt.js";

import {
  fetchReceiptVerificationKeys,
  verifyReceiptOffline,
} from "./receipts.js";

export const DEFAULT_BASE_URL = "https://guardian-api-azure.odingard.com";

/** How long the key download may take before the command gives up (exit 2). */
export const KEY_FETCH_TIMEOUT_MS = 15_000;

export const USAGE = [
  "Usage: guardian-sdk verify <receipt.json> [--keys <keys.json>] [--base-url <url>] [--json]",
  "",
  '  <receipt.json>     a greceipt.v1 receipt, or an API answer { "receipt": … }',
  "  --keys <file>      verify against this key set; no network access",
  `  --base-url <url>   fetch the published keys from <url>/v1/receipts/verification-keys (default ${DEFAULT_BASE_URL})`,
  "  --json             print the verification result as JSON",
  "  guardian-sdk --help   print this help (exit 0)",
].join("\n");

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CliIo = Readonly<{
  out: (text: string) => void;
  err: (text: string) => void;
  readFile?: (path: string) => string;
  fetch?: FetchLike;
  /** Deadline for the key download, in milliseconds (default 15 s). */
  fetchTimeoutMs?: number;
}>;

/**
 * Wraps a fetch so it gives up after `ms`, counting the whole answer: the
 * body is read inside the deadline and handed back buffered, so a server
 * that sends headers and then stalls cannot hang the command either. The
 * request is aborted on timeout, and the call rejects even if the
 * underlying fetch ignores the abort signal.
 */
function withDeadline(base: FetchLike, ms: number): FetchLike {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(new Error(`no complete answer within ${ms} ms`));
      }, ms);
      base(url, { ...init, signal: controller.signal })
        .then(async (response) => {
          const nullBody = [101, 204, 205, 304].includes(response.status);
          const body = nullBody ? null : await response.arrayBuffer();
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        })
        .then(
          (response) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(response);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          },
        );
    });
}

type Parsed =
  | {
      ok: true;
      receiptPath: string;
      keysPath: string | null;
      baseUrl: string;
      json: boolean;
    }
  | { ok: false; message: string };

function parseArgs(argv: readonly string[]): Parsed {
  const [command, ...rest] = argv;
  if (command !== "verify") {
    return { ok: false, message: USAGE };
  }
  let receiptPath: string | null = null;
  let keysPath: string | null = null;
  let baseUrl: string | null = null;
  let json = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--keys" || arg === "--base-url") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: `${arg} needs a value\n\n${USAGE}` };
      }
      if (arg === "--keys") keysPath = value;
      else baseUrl = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      return { ok: false, message: `unknown option ${arg}\n\n${USAGE}` };
    } else if (receiptPath === null) {
      receiptPath = arg;
    } else {
      return { ok: false, message: `one receipt file at a time\n\n${USAGE}` };
    }
  }
  if (receiptPath === null) {
    return { ok: false, message: USAGE };
  }
  if (keysPath !== null && baseUrl !== null) {
    return {
      ok: false,
      message: `use --keys or --base-url, not both\n\n${USAGE}`,
    };
  }
  const url = baseUrl ?? DEFAULT_BASE_URL;
  if (!/^https:\/\/[^\s/]+/.test(url)) {
    return { ok: false, message: "--base-url must be an https:// URL" };
  }
  return { ok: true, receiptPath, keysPath, baseUrl: url, json };
}

function readJson(
  io: CliIo,
  path: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    const text = (io.readFile ?? ((p) => readFileSync(p, "utf8")))(path);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The receipt itself, or the `receipt` of an API answer that wraps one. */
function receiptOf(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !("format" in value) &&
    "receipt" in value
  ) {
    return (value as { receipt: unknown }).receipt;
  }
  return value;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  // `guardian-sdk --help`, `-h` or `help` prints the usage and exits 0.
  // `verify` never exits 0 unless a receipt verified: `verify --help` prints
  // the usage on stdout but exits 2, so a script such as
  // `guardian-sdk verify "$f" && accept "$f"` cannot accept a file named
  // `--help`. `-h` after `verify` is a file name, as before.
  if (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0]!)) {
    io.out(USAGE);
    return 0;
  }
  if (argv.length === 2 && argv[0] === "verify" && argv[1] === "--help") {
    io.out(USAGE);
    return 2;
  }
  const args = parseArgs(argv);
  if (!args.ok) {
    io.err(args.message);
    return 2;
  }
  const file = readJson(io, args.receiptPath);
  if (!file.ok) {
    io.err(`could not read JSON from ${args.receiptPath}`);
    return 2;
  }
  const receipt = receiptOf(file.value);

  let keys: unknown;
  let keySource: string;
  if (args.keysPath !== null) {
    const read = readJson(io, args.keysPath);
    if (!read.ok) {
      io.err(`could not read JSON from ${args.keysPath}`);
      return 2;
    }
    // A file that is not a key set is an input error (exit 2), never a
    // verdict on the receipt: the verifier would call it MALFORMED_RECEIPT.
    if (!ReceiptVerificationKeySetSchema.safeParse(read.value).success) {
      io.err(
        `${args.keysPath} is not a verification key set ({ "keys": [ ... ] })`,
      );
      return 2;
    }
    keys = read.value;
    keySource = args.keysPath;
  } else {
    const fetched = await fetchReceiptVerificationKeys(args.baseUrl, {
      forReceipt: receipt,
      fetch: withDeadline(
        io.fetch ?? ((url, init) => fetch(url, init)),
        io.fetchTimeoutMs ?? KEY_FETCH_TIMEOUT_MS,
      ),
    });
    if (!fetched.ok) {
      io.err(
        `could not fetch the verification keys from ${args.baseUrl} (${fetched.reasonCode})`,
      );
      return 2;
    }
    // The same shape check as --keys: a key set the verifier would reject is
    // a failed download (exit 2), never a verdict on the receipt.
    if (!ReceiptVerificationKeySetSchema.safeParse(fetched.keys).success) {
      io.err(
        `could not fetch the verification keys from ${args.baseUrl} (the answer is not a verification key set)`,
      );
      return 2;
    }
    keys = fetched.keys;
    keySource = `${args.baseUrl.replace(/\/+$/, "")}/v1/receipts/verification-keys`;
  }

  const result = verifyReceiptOffline(receipt, keys);
  if (args.json) {
    io.out(JSON.stringify({ ...result, keys: keySource }, null, 2));
  } else if (result.valid) {
    const r = receipt as { receiptId?: unknown };
    io.out(
      [
        `VALID ${String(r.receiptId)}`,
        `  decision: ${result.decision}`,
        `  effect:   ${result.effect}`,
        `  request:  ${String(result.subject.requestId)}`,
        `  agent:    ${String(result.subject.agentId)}`,
        `  keys:     ${keySource}`,
      ].join("\n"),
    );
  } else {
    io.out(`NOT VALID: ${result.reasonCode}\n  keys: ${keySource}`);
  }
  return result.valid ? 0 : 1;
}
