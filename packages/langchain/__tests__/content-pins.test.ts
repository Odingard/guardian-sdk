import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import {
  CONTENT_CHANGED_SINCE_APPROVAL,
  CONTENT_PIN_KEY,
  CONTENT_PIN_REMOTE_MODE,
  type GuardianClient,
  type PinnedFile,
} from "@odingard/guardian-sdk";

import { GuardianExecutionFailed, guardianTool } from "../src/index.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lc-pin-"));
  file = join(dir, "report.txt");
  writeFileSync(file, "approved bytes");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const allow = {
  ok: true as const,
  decision: "ALLOW" as const,
  requestId: "req_1",
  capabilityToken: "cap_1",
};

function client(onRequest?: () => void) {
  const request = vi.fn(async () => {
    onRequest?.();
    return allow;
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

function sendReport(run: (input: { attachmentPath: unknown }) => unknown) {
  return tool(async (input: { attachmentPath: string }) => run(input), {
    name: "send_report",
    description: "Send a report",
    schema: z.object({ attachmentPath: z.string() }),
  });
}

describe("LangChain fileArgs (inProcess)", () => {
  it("a file rewritten between ALLOW and run is refused; the tool does not run", async () => {
    const run = vi.fn(() => "sent");
    const c = client(() => writeFileSync(file, "rewritten bytes"));
    const wrapped = guardianTool(sendReport(run), {
      client: c.client,
      connectionId: "con_1",
      mode: "inProcess",
      fileArgs: { send_report: { attachmentPath: "recheck" } },
    });
    const err = await wrapped
      .invoke({ attachmentPath: file })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianExecutionFailed);
    expect(err).toMatchObject({
      reasonCode: CONTENT_CHANGED_SINCE_APPROVAL,
      localEffectRan: false,
    });
    expect(run).not.toHaveBeenCalled();
    expect(c.execute).not.toHaveBeenCalled();
    const proposed = (
      c.request.mock.calls[0] as unknown as [
        { arguments: Record<string, unknown> },
      ]
    )[0].arguments;
    expect(proposed[CONTENT_PIN_KEY]).toEqual([
      expect.objectContaining({
        arg: "attachmentPath",
        index: 0,
        mode: "recheck",
        name: "report.txt",
      }),
    ]);
  });

  it('"bytes" hands func the verified bytes, never the pins', async () => {
    let seen: unknown;
    const c = client();
    const wrapped = guardianTool(
      sendReport((input) => {
        seen = input;
        writeFileSync(file, "changed after the re-check");
        return "sent";
      }),
      {
        client: c.client,
        connectionId: "con_1",
        mode: "inProcess",
        fileArgs: { send_report: { attachmentPath: "bytes" } },
      },
    );
    await expect(wrapped.invoke({ attachmentPath: file })).resolves.toBe(
      "sent",
    );
    const pinned = (seen as { attachmentPath: PinnedFile }).attachmentPath;
    expect(new TextDecoder().decode(pinned.bytes)).toBe("approved bytes");
    expect(String(pinned)).not.toContain(dir);
    expect(seen).not.toHaveProperty(CONTENT_PIN_KEY);
    expect(c.execute).toHaveBeenCalledTimes(1);
  });

  it('"copy" hands the tool a private copy that is gone after it returns', async () => {
    let copyPath = "";
    let contents = "";
    const c = client();
    const wrapped = guardianTool(
      sendReport((input) => {
        copyPath = input.attachmentPath as string;
        contents = readFileSync(copyPath, "utf8");
        return "sent";
      }),
      {
        client: c.client,
        connectionId: "con_1",
        mode: "inProcess",
        fileArgs: { send_report: { attachmentPath: "copy" } },
      },
    );
    await wrapped.invoke({ attachmentPath: file });
    expect(copyPath).not.toBe(file);
    expect(contents).toBe("approved bytes");
    expect(() => readFileSync(copyPath)).toThrow();
  });

  it('"bytes" for a tool reachable only through invoke() is a wrap-time error naming "copy"', () => {
    const invokeOnly = {
      name: "send_report",
      description: "Send a report",
      schema: z.object({ attachmentPath: z.string() }),
      invoke: vi.fn(),
    } as unknown as StructuredToolInterface;
    const c = client();
    expect(() =>
      guardianTool(invokeOnly, {
        client: c.client,
        connectionId: "con_1",
        mode: "inProcess",
        fileArgs: { send_report: { attachmentPath: "bytes" } },
      }),
    ).toThrow(/"copy"/);
    // "copy" and "recheck" work for every tool.
    expect(() =>
      guardianTool(invokeOnly, {
        client: c.client,
        connectionId: "con_1",
        mode: "inProcess",
        fileArgs: { send_report: { attachmentPath: "copy" } },
      }),
    ).not.toThrow();
  });

  it("fileArgs with the default (remote) mode is a configuration error", () => {
    const c = client();
    expect(() =>
      guardianTool(
        sendReport(() => "x"),
        {
          client: c.client,
          connectionId: "con_1",
          fileArgs: { send_report: { attachmentPath: "bytes" } },
        },
      ),
    ).toThrow(expect.objectContaining({ reasonCode: CONTENT_PIN_REMOTE_MODE }));
    expect(c.request).not.toHaveBeenCalled();
  });
});
