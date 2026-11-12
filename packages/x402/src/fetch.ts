import { randomBytes } from "node:crypto";

import { decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";

import { requestStorage, type RequestContext } from "./context.js";
import type { X402Guard } from "./guard.js";
import { assertSupportedX402 } from "./version.js";

function readSettle(headers: Headers) {
  const raw = headers.get("X-PAYMENT-RESPONSE");
  if (!raw) return null;
  try {
    return decodePaymentResponseHeader(raw);
  } catch {
    return null;
  }
}

/**
 * The official `wrapFetchWithPayment`, built on the guard's client. Every
 * payment it makes is decided by Guardian before the wallet signs.
 *
 * The guard records the URL and method the agent asked for (before any
 * redirect); a payment whose resource host differs is refused.
 */
export function guardedFetch(
  guard: X402Guard,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  assertSupportedX402("@x402/fetch");
  const paying = wrapFetchWithPayment(fetchImpl, guard.httpClient());
  const guarded = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    // Read the URL and method without touching a request body.
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    let originalUrl = "";
    try {
      originalUrl = isRequest ? input.url : new URL(String(input)).href;
    } catch {
      originalUrl = "";
    }
    const method = (init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
    const ctx: RequestContext = {
      id: `x4r_${randomBytes(8).toString("hex")}`,
      info: {
        transport: "http",
        method,
        originalUrl,
        finalUrl: null,
      },
      signedEntries: [],
      versions: new Map(),
    };
    return requestStorage.run(ctx, async () => {
      let response: Response;
      try {
        response = await paying(input, init);
      } catch (error) {
        if (error instanceof Error && error.message === "Payment already attempted") {
          await guard.markSignedNotSent(ctx);
        }
        throw error;
      }
      if (ctx.signedEntries.some((id) => ctx.versions.get(id) === 1)) {
        await guard.recordV1Settlement(ctx, readSettle(response.headers));
      }
      return response;
    });
  };
  return guarded as typeof globalThis.fetch;
}
