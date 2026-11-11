import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_PIN_KEY,
  createGuardianContext,
  settle,
  GuardianExecutionFailed,
  type GuardianClient,
  type GuardianRequestResult,
} from "@odingard/guardian-sdk";

import { parseCli } from "../src/config.js";
import { createGovernedProxy, type Upstream } from "../src/proxy.js";

const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";
const ENV = {
  GUARDIAN_BASE_URL: "https://guardian.example.test",
  GUARDIAN_AGENT_CREDENTIAL: ["gac1", "fake"].join("."),
  GUARDIAN_CONNECTION_ID: CONNECTION,
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-pin-"));
  file = join(dir, "report.txt");
  writeFileSync(file, "approved bytes");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function upstream() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const up: Upstream = {
    async listTools() {
      return [{ name: "upload_file", inputSchema: { type: "object" } }];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "uploaded" }] };
    },
  };
  return { up, calls };
}

function guardian(
  invoke: () => GuardianRequestResult,
  claim?: () => GuardianRequestResult,
) {
  const execute = vi
    .fn()
    .mockResolvedValue({ ok: true, receipt: { id: "rcpt" } });
  const request = vi.fn(async (inv: { action: string }) =>
    inv.action === "tool.invoke"
      ? invoke()
      : { ok: false, reasonCode: "TOOL_ALREADY_ENABLED" },
  );
  const client = {
    request,
    claim: vi.fn(
      async () => claim?.() ?? { ok: false, reasonCode: "APPROVAL_PENDING" },
    ),
    execute,
    receipts: vi.fn(),
    portableReceipt: vi.fn(),
  } as unknown as GuardianClient;
  return { client, execute, request };
}

const text = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

const allow = (requestId = "req_a"): GuardianRequestResult => ({
  ok: true,
  requestId,
  decision: "ALLOW",
  capabilityToken: "cap",
});
const ask = (requestId = "req_h"): GuardianRequestResult => ({
  ok: true,
  requestId,
  decision: "ASK",
});

const proposedArgs = (request: ReturnType<typeof vi.fn>) =>
  (
    request.mock.calls.find(
      (c) => (c[0] as { action: string }).action === "tool.invoke",
    )![0] as { arguments: Record<string, unknown> }
  ).arguments;

describe("governed MCP proxy: declared file pins (stdio)", () => {
  it("pins the file in the proposal and forwards the approved copy without the reserved key", async () => {
    const { up, calls } = upstream();
    const { client, execute, request } = guardian(() => allow());
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      pinFiles: { upload_file: ["path"] },
    });
    const args = { path: file, note: "q3" };
    const result = await proxy.callTool("upload_file", args);
    expect(result).toMatchObject({ content: [{ text: "uploaded" }] });
    expect(proposedArgs(request)[CONTENT_PIN_KEY]).toEqual([
      expect.objectContaining({
        arg: "path",
        index: 0,
        mode: "recheck",
        name: "report.txt",
      }),
    ]);
    expect(calls).toEqual([{ name: "upload_file", args }]);
    expect(calls[0]!.args).not.toBe(args);
    expect(calls[0]!.args).not.toHaveProperty(CONTENT_PIN_KEY);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a file rewritten between ALLOW and forwarding is refused; nothing is forwarded or redeemed", async () => {
    const { up, calls } = upstream();
    const { client, execute } = guardian(() => {
      writeFileSync(file, "rewritten bytes");
      return allow();
    });
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      pinFiles: { upload_file: ["path"] },
    });
    const result = await proxy.callTool("upload_file", { path: file });
    expect(text(result)).toMatchObject({
      executionFailed: "CONTENT_CHANGED_SINCE_APPROVAL",
      localEffectRan: false,
    });
    expect(calls).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("a held claim settles the proposed (pinned) input: unchanged forwards, changed is refused", async () => {
    for (const change of [false, true]) {
      writeFileSync(file, "approved bytes");
      const { up, calls } = upstream();
      const { client, execute } = guardian(
        () => ask(),
        () => allow("req_h"),
      );
      const proxy = createGovernedProxy({
        client,
        connectionId: CONNECTION,
        upstream: up,
        pinFiles: { upload_file: ["path"] },
      });
      const held = await proxy.callTool("upload_file", { path: file });
      expect(text(held)).toMatchObject({
        decision: "ASK",
        requestId: "req_h",
      });
      if (change) writeFileSync(file, "rewritten while held");
      const claimed = await proxy.callTool("guardian_claim", {
        requestId: "req_h",
      });
      if (change) {
        expect(text(claimed)).toMatchObject({
          executionFailed: "CONTENT_CHANGED_SINCE_APPROVAL",
          localEffectRan: false,
        });
        expect(calls).toHaveLength(0);
        expect(execute).not.toHaveBeenCalled();
      } else {
        expect(claimed).toMatchObject({ content: [{ text: "uploaded" }] });
        expect(calls).toEqual([{ name: "upload_file", args: { path: file } }]);
        expect(execute).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("settling a declared tool with pin-free input (the stored fallback) is refused CONTENT_PIN_MISSING", async () => {
    const runTool = vi.fn();
    const { client, execute } = guardian(() => allow());
    const ctx = createGuardianContext({
      client,
      connectionId: CONNECTION,
      mode: "inProcess",
      onAsk: "result",
      onDeny: "result",
      fileArgs: { upload_file: { path: "recheck" } },
    });
    const err = await settle(
      ctx,
      "upload_file",
      { path: file },
      allow("req_h"),
      runTool,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianExecutionFailed);
    expect(err).toMatchObject({
      reasonCode: "CONTENT_PIN_MISSING",
      localEffectRan: false,
    });
    expect(runTool).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("after a restart the claim finds nothing, and calling again re-proposes with a fresh pin", async () => {
    const first = guardian(() => ask("req_old"));
    const before = createGovernedProxy({
      client: first.client,
      connectionId: CONNECTION,
      upstream: upstream().up,
      pinFiles: { upload_file: ["path"] },
    });
    await before.callTool("upload_file", { path: file });
    writeFileSync(file, "changed during the restart");
    const { up, calls } = upstream();
    const second = guardian(() => ask("req_new"));
    const after = createGovernedProxy({
      client: second.client,
      connectionId: CONNECTION,
      upstream: up,
      pinFiles: { upload_file: ["path"] },
    });
    const claimed = await after.callTool("guardian_claim", {
      requestId: "req_old",
    });
    expect(text(claimed).error).toMatch(/holds no call/);
    expect(calls).toHaveLength(0);
    const again = await after.callTool("upload_file", { path: file });
    expect(text(again)).toMatchObject({
      decision: "ASK",
      requestId: "req_new",
    });
    const oldPin = (
      proposedArgs(first.request)[CONTENT_PIN_KEY] as {
        sha256: string;
      }[]
    )[0]!.sha256;
    const newPin = (
      proposedArgs(second.request)[CONTENT_PIN_KEY] as {
        sha256: string;
      }[]
    )[0]!.sha256;
    expect(newPin).not.toBe(oldPin);
  });

  it("a relative path is refused before anything is proposed", async () => {
    const { up, calls } = upstream();
    const { client, request } = guardian(() => allow());
    const proxy = createGovernedProxy({
      client,
      connectionId: CONNECTION,
      upstream: up,
      pinFiles: { upload_file: ["path"] },
    });
    const result = await proxy.callTool("upload_file", { path: "report.txt" });
    expect(text(result)).toMatchObject({
      decision: "DENY",
      reasonCode: "CONTENT_PIN_INVALID_ARGUMENT",
    });
    expect(request).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("pins for a remote upstream are refused at start", () => {
    const { client } = guardian(() => allow());
    expect(() =>
      createGovernedProxy({
        client,
        connectionId: CONNECTION,
        upstream: upstream().up,
        upstreamTransport: "remote",
        pinFiles: { upload_file: ["path"] },
      }),
    ).toThrow(
      expect.objectContaining({ reasonCode: "CONTENT_PIN_REMOTE_UPSTREAM" }),
    );
  });
});

describe("guardian-mcp proxy --pin-file", () => {
  it("parses repeatable --pin-file before the stdio command", () => {
    const parsed = parseCli(
      [
        "proxy",
        "--pin-file",
        "upload_file:path",
        "--pin-file=upload_file:extra",
        "--pin-file",
        "send:attachment",
        "--",
        "node",
        "server.js",
        "--pin-file",
        "not:ours",
      ],
      ENV,
    );
    expect(parsed).toMatchObject({
      ok: true,
      config: {
        mode: {
          kind: "proxy",
          command: "node",
          args: ["server.js", "--pin-file", "not:ours"],
          pinFiles: { upload_file: ["path", "extra"], send: ["attachment"] },
        },
      },
    });
  });

  it("refuses --pin-file for an HTTP/SSE upstream at start", () => {
    for (const argv of [
      ["proxy", "--pin-file", "a:b", "--url", "https://mcp.example.test/mcp"],
      ["proxy", "--url", "https://mcp.example.test/mcp", "--pin-file", "a:b"],
    ]) {
      const parsed = parseCli(argv, ENV);
      expect(parsed.ok).toBe(false);
      expect((parsed as { message: string }).message).toMatch(
        /CONTENT_PIN_REMOTE_UPSTREAM/,
      );
    }
  });

  it("refuses a malformed --pin-file", () => {
    for (const value of ["nocolon", ":arg", "tool:", "tool:a.b"]) {
      const parsed = parseCli(["proxy", "--pin-file", value, "--", "x"], ENV);
      expect(parsed.ok).toBe(false);
    }
  });
});
