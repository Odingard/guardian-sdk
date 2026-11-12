import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { guardedAxios } from "../src/axios.js";
import { accept, fakeGuardian, makeGuard, orderLog, paymentRequired, SEPOLIA, signatureValid } from "./helpers.js";

/** An in-memory axios adapter acting as the 402 server. No network. */
function fakeAdapter(opts: { redirectTo?: string; resourceUrl?: string } = {}) {
  const paid: PaymentPayload[] = [];
  const seen: string[] = [];
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const url = axios.getUri(config);
    seen.push(url);
    const finalUrl = opts.redirectTo ?? url;
    const sig = config.headers.get("PAYMENT-SIGNATURE") as string | undefined;
    const request = { responseURL: finalUrl };
    if (sig) {
      const payload = decodePaymentSignatureHeader(sig);
      paid.push(payload);
      return {
        data: { ok: true },
        status: 200,
        statusText: "OK",
        headers: {
          "payment-response": encodePaymentResponseHeader({
            success: true,
            transaction: `0x${"cd".repeat(32)}`,
            network: SEPOLIA,
          } as never),
        },
        config,
        request,
      };
    }
    const response = {
      data: {},
      status: 402,
      statusText: "Payment Required",
      headers: {
        "payment-required": encodePaymentRequiredHeader(
          paymentRequired(opts.resourceUrl ?? finalUrl, [accept()]) as never,
        ),
      },
      config,
      request,
    };
    if (config.validateStatus?.(402)) return response;
    throw new AxiosError("Request failed with status code 402", "ERR_BAD_REQUEST", config, request, response);
  };
  return { adapter, paid, seen };
}

const URL_A = "https://api.example.test/axios";

describe("axios transport", () => {
  it("ALLOW: request, execute, then sign; the original URL is what Guardian sees", async () => {
    const order = orderLog();
    const guardian = fakeGuardian();
    const { guard } = makeGuard({ guardian });
    const server = fakeAdapter();
    const api = guardedAxios(guard, axios.create({ adapter: server.adapter }));
    const res = await api.get(URL_A);
    expect(res.status).toBe(200);
    expect(order).toEqual(["request", "execute", "sign"]);
    expect(await signatureValid(server.paid[0]!)).toBe(true);
    const args = (guardian.requests[0] as { arguments: { request: Record<string, unknown> } }).arguments;
    expect(args.request).toMatchObject({ transport: "http", method: "GET", originalUrl: URL_A, finalUrl: URL_A });
    expect(guard.records().find((r) => r.event === "settlement")).toMatchObject({ success: true });
  });

  it("post, request() and the instance call all carry the original URL", async () => {
    const guardian = fakeGuardian();
    const { guard } = makeGuard({ guardian });
    const api = guardedAxios(guard, axios.create({ adapter: fakeAdapter().adapter, baseURL: "https://api.example.test" }));
    expect((await api.post("/p", { a: 1 })).status).toBe(200);
    expect((await api.request({ url: "/r", method: "put" })).status).toBe(200);
    expect((await api({ url: "/c" })).status).toBe(200);
    const reqs = guardian.requests.map(
      (r) => (r as { arguments: { request: { method: string; originalUrl: string } } }).arguments.request,
    );
    expect(reqs.map((r) => [r.method, r.originalUrl])).toEqual([
      ["POST", "https://api.example.test/p"],
      ["PUT", "https://api.example.test/r"],
      ["GET", "https://api.example.test/c"],
    ]);
  });

  it("recovered retry: a fresh decision that needs a person while the first is live", async () => {
    const guardian = fakeGuardian({
      decide: (inv) => ((inv as { toolName: string }).toolName === "x402.pay" ? "ALLOW" : "ASK"),
    });
    const { guard, wallet } = makeGuard({ guardian });
    let n = 0;
    guard.client.onPaymentResponse(async () => ((n += 1) === 1 ? { recovered: true } : undefined));
    const api = guardedAxios(guard, axios.create({ adapter: fakeAdapter().adapter }));
    expect((await api.get(URL_A)).status).toBe(200);
    expect(guardian.requests.map((r) => (r as { toolName: string }).toolName)).toEqual([
      "x402.pay",
      "x402.pay.above_cap",
    ]);
    expect(wallet.signed).toHaveLength(2);
    expect(await guard.liveAuthorizations()).toHaveLength(2);
  });

  it("a redirect to another host that names itself is refused", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    const api = guardedAxios(
      guard,
      axios.create({ adapter: fakeAdapter({ redirectTo: "https://b.example.test/x" }).adapter }),
    );
    await expect(api.get("https://a.example.test/x")).rejects.toThrow(/RESOURCE_HOST_MISMATCH/);
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("calls made on the raw instance carry no original URL and are refused", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    const raw = axios.create({ adapter: fakeAdapter().adapter });
    guardedAxios(guard, raw);
    await expect(raw.get(URL_A)).rejects.toThrow(/ORIGINAL_REQUEST_MISSING/);
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });
});
