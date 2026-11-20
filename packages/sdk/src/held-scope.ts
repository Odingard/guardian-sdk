import { createHash } from "node:crypto";

import type { GuardianContext } from "./guard.js";

/**
 * Held requests are scoped per session.
 *
 * A Guardian context (`createGuardianContext`) remembers each call held for
 * approval, by connection, tool name and arguments, so that the same call
 * made again claims the held request instead of opening a new one. When one
 * context serves several users or conversations, that key alone lets an
 * identical call in one session claim the request a person approved for
 * another. `scopeHeldRequests(ctx, scope)` gives the context to use for one
 * call: the same context, with its held requests seen under `scope` only.
 *
 * ```ts
 * const ctx = createGuardianContext(options); // once
 * // per call:
 * await runThroughGuardian(
 *   scopeHeldRequests(ctx, sessionId),
 *   toolName,
 *   input,
 *   runTool,
 * );
 * ```
 *
 * The scope is part of an in-memory key only (as a SHA-256 digest). It is
 * not sent to Guardian and not put in the proposal.
 */

/**
 * The scope of a call whose session could not be determined: a request
 * held for it is not remembered, so no later call can claim it and every
 * call proposes a request of its own.
 */
export const SCOPE_UNKNOWN: unique symbol = Symbol.for(
  "odingard.guardian.scope-unknown",
);

/**
 * - a string: the session the call belongs to (a user id, a thread id);
 * - `SCOPE_UNKNOWN`: the session is not known (held requests are not reused);
 * - `undefined`: no scope. Held requests are shared by every call the
 *   context sees, so the context must then serve one principal.
 */
export type HeldScope = string | typeof SCOPE_UNKNOWN | undefined;

/**
 * One scope's view of a context's held requests. The guard reads and
 * writes it with `get`, `set`, `delete` and `has` only; entries live in the
 * context's own map under a key that starts with the scope's digest.
 */
class ScopedHeldRequests extends Map<string, string> {
  readonly #all: Map<string, string>;
  readonly #prefix: string;

  constructor(all: Map<string, string>, scope: string) {
    super();
    this.#all = all;
    this.#prefix = `${createHash("sha256").update(scope, "utf8").digest("hex")}\u0000`;
  }

  override get(key: string): string | undefined {
    return this.#all.get(this.#prefix + key);
  }

  override has(key: string): boolean {
    return this.#all.has(this.#prefix + key);
  }

  override set(key: string, value: string): this {
    this.#all.set(this.#prefix + key, value);
    return this;
  }

  override delete(key: string): boolean {
    return this.#all.delete(this.#prefix + key);
  }
}

/**
 * The context to run one call through, for a call that belongs to `scope`.
 * Everything but the held tool calls is the context's own (its options, and
 * the record-transport setup, which registers a tool and runs no call).
 */
export function scopeHeldRequests(
  ctx: GuardianContext,
  scope: HeldScope,
): GuardianContext {
  if (scope === undefined) {
    return ctx;
  }
  if (scope === SCOPE_UNKNOWN) {
    // Remembered nowhere: the map is dropped with this call.
    return { ...ctx, heldInvocations: new Map() };
  }
  if (typeof scope !== "string") {
    throw new TypeError("scope must be a string, SCOPE_UNKNOWN or undefined");
  }
  const all = (ctx.heldInvocations ??= new Map());
  return { ...ctx, heldInvocations: new ScopedHeldRequests(all, scope) };
}

/**
 * The scope an adapter's `scope` option gives for one call. `read` calls
 * the option (or the adapter's default). When it throws, or returns
 * anything but a non-empty string, `SCOPE_UNKNOWN` or `undefined`, the
 * session is unknown: `SCOPE_UNKNOWN`.
 */
export function resolveHeldScope(read: () => unknown): HeldScope {
  let scope: unknown;
  try {
    scope = read();
  } catch {
    return SCOPE_UNKNOWN;
  }
  if (scope === undefined || scope === SCOPE_UNKNOWN) {
    return scope;
  }
  return typeof scope === "string" && scope.length > 0 ? scope : SCOPE_UNKNOWN;
}
