import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import {
  CONTENT_CHANGED_SINCE_APPROVAL,
  CONTENT_PIN_KEY,
  CONTENT_PIN_REMOTE_MODE,
  type GuardianClient,
  type PinnedFile,
} from "@odingard/guardian-sdk";

import { GuardianExecutionFailed, withGuardian } from "../src/index.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vai-pin-"));
  file = join(dir, "report.txt");
  writeFileSync(file, "approved bytes");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const callOptions = { toolCallId: "tc_1", messages: [], context: {} };

function client(onRequest?: () => void) {
  const request = vi.fn(async () => {
    onRequest?.();
    return {
      ok: true as const,
      decision: "ALLOW" as const,
      requestId: "req_1",
      capabilityToken: "cap_1",
    };
  });
  const execute = vi.fn(async () => ({ ok: true, receipt: { id: "r" } }));
  return {
    request,
    execute,
    client: {
      request,
      claim: vi.fn(),
      execute,
      receipts: vi.fn(),
    } as unknown as GuardianClient,
  };
}

function tools(run: (input: { attachmentPath: unknown }) => unknown) {
  return {
    send_report: tool({
      description: "Send a report",
      inputSchema: jsonSchema<{ attachmentPath: string }>({
        type: "object",
        properties: { attachmentPath: { type: "string" } },
        required: ["attachmentPath"],
      }),
      execute: async (input) => run(input),
    }),
  };
}

const call = (wrapped: unknown, input: unknown): Promise<unknown> =>
  (
    wrapped as {
      send_report: {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      };
    }
  ).send_report.execute(input, callOptions);

describe("Vercel AI fileArgs (inProcess)", () => {
  it("a file rewritten between ALLOW and run is refused; execute does not run", async () => {
    const run = vi.fn(() => "sent");
    const c = client(() => writeFileSync(file, "rewritten bytes"));
    const wrapped = withGuardian(tools(run), {
      client: c.client,
      connectionId: "con_1",
      mode: "inProcess",
      fileArgs: { send_report: { attachmentPath: "bytes" } },
    });
    const err = await call(wrapped, { attachmentPath: file }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GuardianExecutionFailed);
    expect(err).toMatchObject({
      reasonCode: CONTENT_CHANGED_SINCE_APPROVAL,
      localEffectRan: false,
    });
    expect(run).not.toHaveBeenCalled();
    expect(c.execute).not.toHaveBeenCalled();
  });

  it('"bytes": execute receives the verified bytes, not the path or the pins', async () => {
    let seen: unknown;
    const c = client();
    const wrapped = withGuardian(
      tools((input) => {
        seen = input;
        return "sent";
      }),
      {
        client: c.client,
        connectionId: "con_1",
        mode: "inProcess",
        fileArgs: { send_report: { attachmentPath: "bytes" } },
      },
    );
    await expect(call(wrapped, { attachmentPath: file })).resolves.toBe("sent");
    const pinned = (seen as { attachmentPath: PinnedFile }).attachmentPath;
    expect(new TextDecoder().decode(pinned.bytes)).toBe("approved bytes");
    expect(seen).not.toHaveProperty(CONTENT_PIN_KEY);
    const proposed = (
      c.request.mock.calls[0] as unknown as [
        { arguments: Record<string, unknown> },
      ]
    )[0].arguments;
    expect(proposed[CONTENT_PIN_KEY]).toEqual([
      expect.objectContaining({ arg: "attachmentPath", mode: "bytes" }),
    ]);
  });

  it('"copy": execute receives a private copy that is deleted afterwards', async () => {
    let copy = "";
    let contents = "";
    const c = client();
    const wrapped = withGuardian(
      tools((input) => {
        copy = input.attachmentPath as string;
        contents = readFileSync(copy, "utf8");
        return "sent";
      }),
      {
        client: c.client,
        connectionId: "con_1",
        mode: "inProcess",
        fileArgs: { send_report: { attachmentPath: "copy" } },
      },
    );
    await call(wrapped, { attachmentPath: file });
    expect(copy).not.toBe(file);
    expect(contents).toBe("approved bytes");
    expect(() => readFileSync(copy)).toThrow();
  });

  it("fileArgs with the default (remote) mode is a configuration error", () => {
    const c = client();
    expect(() =>
      withGuardian(
        tools(() => "x"),
        {
          client: c.client,
          connectionId: "con_1",
          fileArgs: { send_report: { attachmentPath: "bytes" } },
        },
      ),
    ).toThrow(expect.objectContaining({ reasonCode: CONTENT_PIN_REMOTE_MODE }));
  });

  it("the short form (no mode named) means bytes", async () => {
    for (const fileArgs of [
      { send_report: ["attachmentPath"] },
      { send_report: { attachmentPath: true as const } },
    ]) {
      let seen: unknown;
      const c = client();
      const wrapped = withGuardian(
        tools((input) => {
          seen = input;
          return "sent";
        }),
        { client: c.client, connectionId: "con_1", mode: "inProcess", fileArgs },
      );
      await expect(call(wrapped, { attachmentPath: file })).resolves.toBe(
        "sent",
      );
      const pinned = (seen as { attachmentPath: PinnedFile }).attachmentPath;
      expect(new TextDecoder().decode(pinned.bytes)).toBe("approved bytes");
      const proposed = (
        c.request.mock.calls[0] as unknown as [
          { arguments: Record<string, unknown> },
        ]
      )[0].arguments;
      expect(proposed[CONTENT_PIN_KEY]).toEqual([
        expect.objectContaining({ arg: "attachmentPath", mode: "bytes" }),
      ]);
    }
  });
});
