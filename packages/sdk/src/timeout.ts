import type { GuardianClientConfig } from "./client.js";

/**
 * A time limit and an abort signal for the Guardian client's HTTP calls.
 *
 * `createGuardianClient` sets no limit of its own: a Guardian call that is
 * never answered waits for as long as the connection stays open. The client
 * takes a `fetch`, so the limit is put there:
 *
 * ```ts
 * const client = createGuardianClient(
 *   withRequestTimeout({ baseUrl, credential }, { timeoutMs: 10_000 }),
 * );
 * ```
 *
 * Every call the client makes (request, claim, execute, receipts,
 * portableReceipt, pending, withdraw) then ends after `timeoutMs` at the
 * latest, reading the answer included, and ends at once when `signal`
 * aborts. The client reports an ended call as it reports an unreachable
 * Guardian, so it stays fail closed:
 *
 * - `request` and `claim` answer `{ ok: false, reasonCode:
 *   "SERVICE_UNAVAILABLE" }` (or `HTTP_<status>` when the answer started and
 *   could not be read to its end). Nothing runs. A held request stays held
 *   and can be claimed again.
 * - `execute` answers `{ ok: false, outcomeUnknown: true }`: it was sent,
 *   and Guardian may have redeemed the capability. The guard
 *   (`runThroughGuardian`, `createGuard`) then looks the request up, with a
 *   new time limit of its own, and reports a verified attempt as the
 *   result; if the lookup does not settle it, the call throws
 *   `GuardianExecutionFailed` with `outcomeUnknown: true` and must not be
 *   retried as a new request.
 * - `withdraw` answers `outcomeUnknown: true`; `receipts`, `portableReceipt`
 *   and `pending` answer `{ ok: false }`.
 *
 * The limit is per HTTP call, not per guarded tool call: a guarded call
 * makes several (request, execute, and a lookup after a lost answer). It
 * does not limit the tool itself, and it does not limit how long a person
 * takes to approve (a held request is answered at once and claimed later).
 */
export type GuardianTimeoutOptions = Readonly<{
  /**
   * Time limit for one HTTP call in ms, from sending it to reading its
   * answer. Default GUARDIAN_DEFAULT_CALL_TIMEOUT_MS (15 s). A whole number
   * from 1 to GUARDIAN_MAX_CALL_TIMEOUT_MS.
   */
  timeoutMs?: number;
  /**
   * Ends every call made while it is aborted, and every call in flight
   * when it aborts. An `execute` in flight is then reported with
   * `outcomeUnknown: true`, and its lookup is refused as well, so prefer
   * `abortable` to stop one tool call without abandoning a started action.
   */
  signal?: AbortSignal;
}>;

/** Default time limit for one Guardian HTTP call: 15 seconds. */
export const GUARDIAN_DEFAULT_CALL_TIMEOUT_MS = 15_000;

/** Longest time limit accepted: the longest delay a timer can take. */
export const GUARDIAN_MAX_CALL_TIMEOUT_MS = 2_147_483_647;

function checkedTimeoutMs(value: unknown): number {
  const timeoutMs = value ?? GUARDIAN_DEFAULT_CALL_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > GUARDIAN_MAX_CALL_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be a whole number from 1 to ${GUARDIAN_MAX_CALL_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

/**
 * A `fetch` whose every call ends after `timeoutMs` and when `signal`
 * aborts. Each call gets its own timer; a signal the caller passes in the
 * call's own `init` is kept as well. The returned promise rejects with the
 * signal's reason (a `TimeoutError` for the time limit), and so does
 * reading the response body when the limit passes while it is read.
 *
 * `fetch` is the transport to wrap (default: the global `fetch`). A wrong
 * `timeoutMs` throws a `RangeError` here, before any call.
 */
export function createTimeoutFetch(
  options: GuardianTimeoutOptions & Readonly<{ fetch?: typeof fetch }> = {},
): typeof fetch {
  const timeoutMs = checkedTimeoutMs(options.timeoutMs);
  const { signal } = options;
  const base = options.fetch;
  return (input, init) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    if (init?.signal) signals.push(init.signal);
    return (base ?? fetch)(input, {
      ...init,
      signal: AbortSignal.any(signals),
    });
  };
}

/**
 * The same client config with its `fetch` (or the global `fetch`) bounded
 * by `createTimeoutFetch`. Pass the result to `createGuardianClient`.
 */
export function withRequestTimeout(
  config: GuardianClientConfig,
  options: GuardianTimeoutOptions = {},
): GuardianClientConfig {
  return {
    ...config,
    fetch: createTimeoutFetch({
      ...options,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    }),
  };
}
