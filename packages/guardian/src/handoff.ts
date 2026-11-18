/**
 * The terminal side of connecting `guardian init` to the console.
 *
 * `guardian init` listens on 127.0.0.1 (a free port) and opens the console's
 * "Connect your terminal" page. When the signed-in owner creates the agent
 * and its tool server there, the page posts the agent credential and the
 * ids to `http://127.0.0.1:<port>/guardian-init`. This server accepts that
 * once, and only:
 *
 * - on 127.0.0.1, with the `Host` header naming exactly that address and
 *   port (so a page on another site cannot reach it through a DNS name);
 * - from the console's origin (`Origin`), with the browser's preflight;
 * - with the `state` this run made, compared in constant time;
 * - with a well-formed credential, agent id and connection id.
 *
 * Anything else is refused and nothing is kept. The credential is never
 * printed or logged.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export const CALLBACK_PATH = "/guardian-init";
const MAX_BODY_BYTES = 8_192;
/** Wrong requests tolerated before the server stops listening. */
const MAX_BAD_REQUESTS = 20;

export const CREDENTIAL = /^gak_[A-Za-z0-9][A-Za-z0-9_-]{42}$/;
export const AGENT_ID = /^agt_[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/;
export const CONNECTION_ID = /^pcn_[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/;

export type Handoff = Readonly<{
  credential: string;
  agentId?: string;
  connectionId: string;
}>;

export type HandoffServer = Readonly<{
  port: number;
  state: string;
  /** Resolves once with what the console sent; rejects if the server stops. */
  received: Promise<Handoff>;
  close(): void;
}>;

/** A fresh state: 32 random bytes, base64url (43 characters). */
export function newState(): string {
  return randomBytes(32).toString("base64url");
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Reads what the console sent; null when anything is wrong. */
export function parseHandoff(body: unknown, state: string): Handoff | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const value = body as Record<string, unknown>;
  if (value.v !== 1) return null;
  if (typeof value.state !== "string" || !sameText(value.state, state)) {
    return null;
  }
  if (
    typeof value.credential !== "string" ||
    !CREDENTIAL.test(value.credential) ||
    typeof value.agentId !== "string" ||
    !AGENT_ID.test(value.agentId) ||
    typeof value.connectionId !== "string" ||
    !CONNECTION_ID.test(value.connectionId)
  ) {
    return null;
  }
  return {
    credential: value.credential,
    agentId: value.agentId,
    connectionId: value.connectionId,
  };
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

export function startHandoffServer(input: {
  consoleOrigin: string;
  state?: string;
  timeoutMs: number;
}): Promise<HandoffServer> {
  const state = input.state ?? newState();
  let settled = false;
  let bad = 0;
  let resolveReceived!: (handoff: Handoff) => void;
  let rejectReceived!: (error: Error) => void;
  const received = new Promise<Handoff>((resolve, reject) => {
    resolveReceived = resolve;
    rejectReceived = reject;
  });
  // A rejection nobody awaited must not crash the process.
  received.catch(() => undefined);

  const server = createServer();
  let port = 0;
  let timer: NodeJS.Timeout | undefined;

  const stop = (error?: Error) => {
    if (timer !== undefined) clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    if (!settled) {
      settled = true;
      rejectReceived(error ?? new Error("stopped"));
    }
  };

  const cors = (response: ServerResponse) => {
    response.setHeader("access-control-allow-origin", input.consoleOrigin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-methods", "POST");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("access-control-allow-private-network", "true");
    response.setHeader("access-control-max-age", "60");
  };

  const answer = (
    response: ServerResponse,
    status: number,
    body?: Record<string, unknown>,
  ) => {
    response.setHeader("cache-control", "no-store");
    if (body === undefined) {
      response.writeHead(status).end();
      return;
    }
    response
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify(body));
  };

  const refuse = (response: ServerResponse, status: number) => {
    bad += 1;
    answer(response, status, { ok: false });
    if (bad >= MAX_BAD_REQUESTS) {
      stop(new Error("too many wrong requests"));
    }
  };

  server.on("request", (request, response) => {
    void (async () => {
      const path = (request.url ?? "").split("?")[0];
      if (request.headers.host !== `127.0.0.1:${port}`) {
        return refuse(response, 403);
      }
      if (request.headers.origin !== input.consoleOrigin) {
        return refuse(response, 403);
      }
      if (path !== CALLBACK_PATH) return refuse(response, 404);
      if (settled) {
        cors(response);
        return answer(response, 410, { ok: false });
      }
      if (request.method === "OPTIONS") {
        cors(response);
        return answer(response, 204);
      }
      if (request.method !== "POST") return refuse(response, 405);
      const type = request.headers["content-type"] ?? "";
      if (!/^application\/json(\s*;|$)/i.test(type)) {
        return refuse(response, 415);
      }
      const text = await readBody(request);
      let parsed: unknown = null;
      try {
        parsed = text === null ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      const handoff = parseHandoff(parsed, state);
      if (handoff === null) {
        cors(response);
        return refuse(response, 400);
      }
      settled = true;
      cors(response);
      answer(response, 200, { ok: true });
      resolveReceived(handoff);
      response.on("finish", () => stop());
    })().catch(() => {
      if (!response.headersSent) answer(response, 500, { ok: false });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      timer = setTimeout(() => stop(new Error("timed out")), input.timeoutMs);
      timer.unref?.();
      resolve({ port, state, received, close: () => stop() });
    });
  });
}
