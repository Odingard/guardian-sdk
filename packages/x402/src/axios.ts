import { randomBytes } from "node:crypto";

import { decodePaymentResponseHeader } from "@x402/core/http";
import { wrapAxiosWithPayment } from "@x402/axios";
import type { AxiosInstance, AxiosRequestConfig } from "axios";

import { requestStorage, type RequestContext } from "./context.js";
import type { X402Guard } from "./guard.js";
import { assertSupportedX402 } from "./version.js";

const URL_ONLY = new Set(["get", "delete", "head", "options"]);
const URL_DATA = new Set(["post", "put", "patch", "postForm", "putForm", "patchForm"]);

function settleFrom(headers: unknown) {
  const h = headers as Record<string, unknown> | undefined;
  const raw = h?.["x-payment-response"] ?? h?.["X-PAYMENT-RESPONSE"];
  if (typeof raw !== "string") return null;
  try {
    return decodePaymentResponseHeader(raw);
  } catch {
    return null;
  }
}

/**
 * The official `wrapAxiosWithPayment` on the given instance, built on the
 * guard's client. Use only the returned instance: calls made on the
 * original instance carry no original URL and every payment they attempt
 * is refused.
 */
export function guardedAxios(guard: X402Guard, instance: AxiosInstance): AxiosInstance {
  assertSupportedX402("@x402/axios");
  wrapAxiosWithPayment(instance, guard.httpClient());

  const run = <T>(config: AxiosRequestConfig, call: () => Promise<T>): Promise<T> => {
    let originalUrl = "";
    try {
      originalUrl = new URL(instance.getUri(config)).href;
    } catch {
      originalUrl = "";
    }
    const method = String(config.method ?? instance.defaults.method ?? "get").toUpperCase();
    const ctx: RequestContext = {
      id: `x4r_${randomBytes(8).toString("hex")}`,
      info: { transport: "http", method, originalUrl, finalUrl: null },
      signedEntries: [],
      versions: new Map(),
    };
    return requestStorage.run(ctx, async () => {
      const response = await call();
      if (ctx.signedEntries.some((id) => ctx.versions.get(id) === 1)) {
        await guard.recordV1Settlement(
          ctx,
          settleFrom((response as { headers?: unknown } | undefined)?.headers),
        );
      }
      return response;
    });
  };

  return new Proxy(instance, {
    apply(target, thisArg, args: unknown[]) {
      const config =
        typeof args[0] === "string"
          ? { ...((args[1] as AxiosRequestConfig) ?? {}), url: args[0] }
          : ((args[0] as AxiosRequestConfig) ?? {});
      return run(config, () => Reflect.apply(target, thisArg, args) as Promise<unknown>);
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string" || typeof value !== "function") return value;
      if (prop === "request") {
        return (config: AxiosRequestConfig) =>
          run(config ?? {}, () => target.request(config));
      }
      if (URL_ONLY.has(prop)) {
        return (url: string, config?: AxiosRequestConfig) =>
          run({ ...(config ?? {}), url, method: prop as AxiosRequestConfig["method"] }, () =>
            (value as (u: string, c?: AxiosRequestConfig) => Promise<unknown>).call(target, url, config),
          );
      }
      if (URL_DATA.has(prop)) {
        const method = prop.replace("Form", "") as AxiosRequestConfig["method"];
        return (url: string, data?: unknown, config?: AxiosRequestConfig) =>
          run({ ...(config ?? {}), url, method }, () =>
            (value as (u: string, d?: unknown, c?: AxiosRequestConfig) => Promise<unknown>).call(
              target,
              url,
              data,
              config,
            ),
          );
      }
      return value;
    },
  });
}
