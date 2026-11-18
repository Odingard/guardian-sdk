import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  CALLBACK_PATH,
  parseHandoff,
  startHandoffServer,
  type HandoffServer,
} from "../src/handoff.js";

const CONSOLE = "https://guardian.example.test";
const STATE = "s".repeat(43);
const CREDENTIAL = `gak_${"A".repeat(43)}`;
const GOOD = {
  v: 1,
  state: STATE,
  credential: CREDENTIAL,
  agentId: "agt_0000000000004001",
  connectionId: "pcn_0000000000004001",
};

type Sent = {
  status: number;
  headers: Record<string, unknown>;
  body: string;
};

function send(
  server: HandoffServer,
  input: {
    method?: string;
    path?: string;
    host?: string;
    origin?: string | null;
    type?: string;
    body?: string;
  } = {},
): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: input.host ?? `127.0.0.1:${server.port}`,
      "content-type": input.type ?? "application/json",
    };
    if (input.origin !== null) headers.origin = input.origin ?? CONSOLE;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method: input.method ?? "POST",
        path: input.path ?? CALLBACK_PATH,
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(input.body ?? JSON.stringify(GOOD));
  });
}

let server: HandoffServer | undefined;
afterEach(() => server?.close());

describe("parseHandoff", () => {
  it("reads a well-formed handoff", () => {
    expect(parseHandoff(GOOD, STATE)).toEqual({
      credential: CREDENTIAL,
      agentId: GOOD.agentId,
      connectionId: GOOD.connectionId,
    });
  });

  it("refuses anything else", () => {
    for (const body of [
      null,
      [],
      "text",
      { ...GOOD, v: 2 },
      { ...GOOD, state: "t".repeat(43) },
      { ...GOOD, state: STATE.slice(1) },
      { ...GOOD, credential: "gak_short" },
      { ...GOOD, credential: `xyz_${"A".repeat(43)}` },
      { ...GOOD, agentId: "agent" },
      { ...GOOD, connectionId: "connection" },
      { ...GOOD, connectionId: undefined },
    ]) {
      expect(parseHandoff(body, STATE), JSON.stringify(body)).toBeNull();
    }
  });
});

describe("the loopback server", () => {
  it("takes the handoff once from the console's origin", async () => {
    server = await startHandoffServer({
      consoleOrigin: CONSOLE,
      state: STATE,
      timeoutMs: 10_000,
    });
    const preflight = await send(server, { method: "OPTIONS", body: "" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(CONSOLE);
    expect(preflight.headers["access-control-allow-private-network"]).toBe(
      "true",
    );
    const sent = await send(server);
    expect(sent.status).toBe(200);
    expect(JSON.parse(sent.body)).toEqual({ ok: true });
    await expect(server.received).resolves.toEqual({
      credential: CREDENTIAL,
      agentId: GOOD.agentId,
      connectionId: GOOD.connectionId,
    });
  });

  it("refuses another origin, host, path, method, type or state", async () => {
    server = await startHandoffServer({
      consoleOrigin: CONSOLE,
      state: STATE,
      timeoutMs: 10_000,
    });
    const refused = [
      await send(server, { origin: "https://attacker.example" }),
      await send(server, { origin: null }),
      await send(server, { host: `localhost:${server.port}` }),
      await send(server, { host: `evil.example:${server.port}` }),
      await send(server, { path: "/other" }),
      await send(server, { method: "GET", body: "" }),
      await send(server, { type: "text/plain" }),
      await send(server, {
        body: JSON.stringify({ ...GOOD, state: "t".repeat(43) }),
      }),
      await send(server, { body: "{not json" }),
      await send(server, { body: "x".repeat(9_000) }).catch(
        (): Sent => ({ status: 400, headers: {}, body: "" }),
      ),
    ];
    for (const answer of refused) {
      expect(answer.status).toBeGreaterThanOrEqual(400);
    }
    // A refusal from another origin carries no CORS permission.
    expect(refused[0]!.headers["access-control-allow-origin"]).toBeUndefined();
    // Still waiting: the right handoff is taken afterwards.
    expect((await send(server)).status).toBe(200);
    await expect(server.received).resolves.toMatchObject({
      credential: CREDENTIAL,
    });
  });

  it("stops after too many wrong requests", async () => {
    server = await startHandoffServer({
      consoleOrigin: CONSOLE,
      state: STATE,
      timeoutMs: 10_000,
    });
    for (let i = 0; i < 20; i += 1) {
      await send(server, {
        body: JSON.stringify({ ...GOOD, state: "t".repeat(43) }),
      }).catch(() => undefined);
    }
    await expect(server.received).rejects.toThrow("too many wrong requests");
  });

  it("stops waiting after the timeout", async () => {
    server = await startHandoffServer({
      consoleOrigin: CONSOLE,
      state: STATE,
      timeoutMs: 30,
    });
    await expect(server.received).rejects.toThrow("timed out");
  });

  it("makes a fresh 43-character state when none is given", async () => {
    server = await startHandoffServer({
      consoleOrigin: CONSOLE,
      timeoutMs: 10_000,
    });
    expect(server.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
