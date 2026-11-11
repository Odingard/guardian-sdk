import type { GuardianClient } from "@odingard/guardian-sdk";

/**
 * Guardian did not answer in time, or the agent run cancelled the call
 * while Guardian was still deciding. The tool did not run.
 */
export class GuardianUnavailable extends Error {
  readonly toolName: string;
  readonly reason: "timeout" | "cancelled" | "error";

  constructor(args: {
    toolName: string;
    reason: "timeout" | "cancelled" | "error";
  }) {
    super(
      `Guardian could not check "${args.toolName}" (${args.reason}); ` +
        `the tool did not run`,
    );
    this.name = "GuardianUnavailable";
    this.toolName = args.toolName;
    this.reason = args.reason;
  }
}

/**
 * Per-call gate around the Guardian client.
 *
 * While Guardian is deciding, the gate has a deadline and follows the
 * agent run's abort signal. If either fires first, the gate closes for
 * good: the pending Guardian call is abandoned, and every later client call
 * and the tool itself are refused, so a late ALLOW can never run the tool.
 *
 * Once the tool starts (or Guardian is asked to execute the tool call) the
 * gate is committed and stops interfering, so a started action is always
 * recorded. Executing a record-transport setup step (mcp.install or
 * mcp.enable) does not commit the gate: the deadline and the abort signal
 * still apply to the tool call after it.
 * Once the call has settled (for example an ASK handed back to the app),
 * the gate opens so `resume()` can claim the approval later.
 */
export class CallGate {
  readonly client: GuardianClient;
  #state: "deciding" | "committed" | "settled" | "closed" = "deciding";
  #closedBy: GuardianUnavailable | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #signal: AbortSignal | undefined;
  #onAbort: (() => void) | undefined;
  #rejecters = new Set<(err: unknown) => void>();
  #setupIds = new Set<string>();

  constructor(args: {
    client: GuardianClient;
    toolName: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }) {
    const { client, toolName, timeoutMs, signal } = args;
    this.#timer = setTimeout(
      () =>
        this.#close(new GuardianUnavailable({ toolName, reason: "timeout" })),
      timeoutMs,
    );
    if (signal) {
      this.#signal = signal;
      this.#onAbort = () =>
        this.#close(new GuardianUnavailable({ toolName, reason: "cancelled" }));
      if (signal.aborted) {
        this.#onAbort();
      } else {
        signal.addEventListener("abort", this.#onAbort, { once: true });
      }
    }
    const decide =
      <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      (...a: A): Promise<R> => {
        this.assertOpen();
        if (this.#state !== "deciding") {
          return fn(...a);
        }
        return new Promise<R>((resolve, reject) => {
          this.#rejecters.add(reject);
          fn(...a).then(
            (value) => {
              this.#rejecters.delete(reject);
              if (this.#closedBy) reject(this.#closedBy);
              else resolve(value);
            },
            (err: unknown) => {
              this.#rejecters.delete(reject);
              reject(this.#closedBy ?? err);
            },
          );
        });
      };
    // Request ids of record-transport setup steps (mcp.install and
    // mcp.enable). Executing one of these only registers or switches on the
    // tool; it is not the tool starting, so it keeps the deadline and the
    // abort signal.
    const setupIds = this.#setupIds;
    const noteSetup = (result: unknown): void => {
      const id = (result as { requestId?: unknown } | null)?.requestId;
      if (typeof id === "string" && id.length > 0) setupIds.add(id);
    };
    const request = decide(
      async (i: Parameters<GuardianClient["request"]>[0]) => {
        const result = await client.request(i);
        if (i.action === "mcp.install" || i.action === "mcp.enable") {
          noteSetup(result);
        }
        return result;
      },
    );
    const claim = decide(async (id: string) => {
      const result = await client.claim(id);
      if (setupIds.has(id)) noteSetup(result);
      return result;
    });
    const executeSetup = decide(
      (input: Parameters<GuardianClient["execute"]>[0]) =>
        client.execute(input),
    );
    const execute = (input: Parameters<GuardianClient["execute"]>[0]) => {
      if (setupIds.has(input.requestId)) {
        return executeSetup(input);
      }
      // Executing the tool call is the start of the action: refuse it if
      // the gate closed, and never abandon it once sent.
      this.assertOpen();
      this.commit();
      return client.execute(input);
    };
    const overrides: Record<PropertyKey, unknown> = { request, claim, execute };
    this.client = new Proxy(client, {
      get(target, prop, receiver) {
        if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
          return overrides[prop];
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  get committed(): boolean {
    return this.#state === "committed";
  }

  get closed(): boolean {
    return this.#state === "closed";
  }

  /** Throws if the gate closed (timeout or cancel) before the tool started. */
  assertOpen(): void {
    if (this.#state === "closed" && this.#closedBy) {
      throw this.#closedBy;
    }
  }

  /** The tool (or Guardian's execution of it) is starting. */
  commit(): void {
    this.assertOpen();
    if (this.#state === "deciding") {
      this.#state = "committed";
      this.#disarm();
    }
  }

  /** The call settled; later `resume()` calls pass straight through. */
  settle(): void {
    if (this.#state !== "closed") {
      this.#state = "settled";
      this.#disarm();
    }
  }

  #close(reason: GuardianUnavailable): void {
    if (this.#state !== "deciding") {
      return;
    }
    this.#state = "closed";
    this.#closedBy = reason;
    this.#disarm();
    for (const reject of this.#rejecters) {
      reject(reason);
    }
    this.#rejecters.clear();
  }

  #disarm(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#signal && this.#onAbort) {
      this.#signal.removeEventListener("abort", this.#onAbort);
      this.#onAbort = undefined;
    }
  }
}
