import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RunContext, type FunctionTool } from "@openai/agents";
import {
  CONTENT_CHANGED_SINCE_APPROVAL,
  CONTENT_PIN_KEY,
  type GuardianClient,
  type PinnedFile,
} from "@odingard/guardian-sdk";

import {
  GuardianApprovalPending,
  createGuardianTool,
  guardianTool,
} from "../src/index.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oa-pin-"));
  file = join(dir, "report.txt");
  writeFileSync(file, "approved bytes");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const allow = (requestId = "req_1") => ({
  ok: true as const,
  decision: "ALLOW" as const,
  requestId,
  capabilityToken: `cap_${requestId}`,
});

function stubClient(overrides: Partial<GuardianClient>): GuardianClient {
  return {
    request: vi.fn(),
    claim: vi.fn(),
    execute: vi.fn().mockResolvedValue({ ok: true, receipt: { id: "r" } }),
    receipts: vi.fn(),
    ...overrides,
  } as unknown as GuardianClient;
}

const invoke = (t: FunctionTool<any, any, any>, args: unknown) =>
  t.invoke(new RunContext(), JSON.stringify(args));

const proposedArgs = (request: ReturnType<typeof vi.fn>, n = 0) =>
  (
    request.mock.calls[n] as unknown as [{ arguments: Record<string, unknown> }]
  )[0].arguments;

function sendReport(
  name: string,
  run: (input: { attachmentPath: unknown }) => unknown,
  options: Parameters<typeof guardianTool>[1],
) {
  return guardianTool(
    {
      name,
      description: "Send a report",
      parameters: z.object({ attachmentPath: z.string() }),
      execute: async (input) => run(input) as string,
    },
    options,
  );
}

describe("OpenAI Agents fileArgs", () => {
  it("a file rewritten between ALLOW and run is refused; execute does not run and the model is told so", async () => {
    const run = vi.fn(() => "sent");
    const request = vi.fn(async () => {
      writeFileSync(file, "rewritten bytes");
      return allow();
    });
    const execute = vi.fn();
    const t = sendReport("send_report", run, {
      client: stubClient({ request, execute }),
      connectionId: "con_1",
      mode: "inProcess",
      fileArgs: { send_report: { attachmentPath: "recheck" } },
    });
    const out = await invoke(t, { attachmentPath: file });
    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(String(out)).toContain("did not run");
    expect(String(out)).toContain(CONTENT_CHANGED_SINCE_APPROVAL);
  });

  it('"bytes": execute receives the verified bytes, without the pins', async () => {
    let seen: unknown;
    const request = vi.fn().mockResolvedValue(allow());
    const t = sendReport(
      "send_report",
      (input) => {
        seen = input;
        return "sent";
      },
      {
        client: stubClient({ request }),
        connectionId: "con_1",
        fileArgs: { send_report: { attachmentPath: "bytes" } },
      },
    );
    await expect(invoke(t, { attachmentPath: file })).resolves.toBe("sent");
    const pinned = (seen as { attachmentPath: PinnedFile }).attachmentPath;
    expect(new TextDecoder().decode(pinned.bytes)).toBe("approved bytes");
    expect(seen).not.toHaveProperty(CONTENT_PIN_KEY);
  });

  it("a tool the Agents SDK renames still pins the argument declared under the written name", async () => {
    const request = vi.fn().mockResolvedValue(allow());
    const t = sendReport("send-report", () => "sent", {
      client: stubClient({ request }),
      connectionId: "con_1",
      fileArgs: { "send-report": { attachmentPath: "recheck" } },
    });
    expect(t.name).toBe("send_report");
    await invoke(t, { attachmentPath: file });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "send_report" }),
    );
    expect(proposedArgs(request)[CONTENT_PIN_KEY]).toEqual([
      expect.objectContaining({ arg: "attachmentPath", mode: "recheck" }),
    ]);
  });

  it("fileArgs entries that disagree for one renamed tool are refused", () => {
    expect(() =>
      sendReport("send-report", () => "x", {
        client: stubClient({}),
        connectionId: "con_1",
        fileArgs: {
          "send-report": { attachmentPath: "bytes" },
          send_report: { attachmentPath: "recheck" },
        },
      }),
    ).toThrow(/fileArgs disagree/);
  });

  it("fileArgs in remote mode is refused at wrap time", () => {
    expect(() =>
      sendReport("send_report", () => "x", {
        client: stubClient({}),
        connectionId: "con_1",
        mode: "remote",
        fileArgs: { send_report: { attachmentPath: "bytes" } },
      }),
    ).toThrow(
      expect.objectContaining({ reasonCode: "CONTENT_PIN_REMOTE_MODE" }),
    );
  });

  it("the held re-call is shared across calls: same file claims, a changed file is re-proposed", async () => {
    const run = vi.fn(() => "sent");
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, decision: "ASK", requestId: "req_a" })
      .mockResolvedValueOnce({ ok: true, decision: "ASK", requestId: "req_b" });
    const claim = vi.fn().mockResolvedValue(allow("req_a"));
    const governed = createGuardianTool({
      client: stubClient({ request, claim }),
      connectionId: "con_1",
      fileArgs: { send_report: { attachmentPath: "recheck" } },
    });
    const t = governed({
      name: "send_report",
      description: "Send a report",
      parameters: z.object({ attachmentPath: z.string() }),
      execute: async () => run(),
    });
    const first = await invoke(t, { attachmentPath: file }).catch(
      (e: unknown) => e,
    );
    expect(first).toBeInstanceOf(GuardianApprovalPending);
    // The same call again, file unchanged: claims the held request.
    await expect(invoke(t, { attachmentPath: file })).resolves.toBe("sent");
    expect(claim).toHaveBeenCalledWith("req_a");
    expect(request).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    // A changed file is a new proposal, never a claim of the old one.
    writeFileSync(file, "different bytes");
    const third = await invoke(t, { attachmentPath: file }).catch(
      (e: unknown) => e,
    );
    expect(third).toBeInstanceOf(GuardianApprovalPending);
    expect(request).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("the short form (no mode named) means bytes", async () => {
    for (const fileArgs of [
      { send_report: ["attachmentPath"] },
      { send_report: { attachmentPath: true as const } },
    ]) {
      let seen: unknown;
      const request = vi.fn().mockResolvedValue(allow());
      const t = sendReport(
        "send_report",
        (input) => {
          seen = input;
          return "sent";
        },
        { client: stubClient({ request }), connectionId: "con_1", fileArgs },
      );
      await expect(invoke(t, { attachmentPath: file })).resolves.toBe("sent");
      const pinned = (seen as { attachmentPath: PinnedFile }).attachmentPath;
      expect(new TextDecoder().decode(pinned.bytes)).toBe("approved bytes");
      expect(proposedArgs(request)[CONTENT_PIN_KEY]).toEqual([
        expect.objectContaining({ arg: "attachmentPath", mode: "bytes" }),
      ]);
    }
  });

  it("a renamed tool: the short form and explicit bytes agree; the short form and recheck disagree", async () => {
    const request = vi.fn().mockResolvedValue(allow());
    const t = sendReport("send-report", () => "sent", {
      client: stubClient({ request }),
      connectionId: "con_1",
      fileArgs: {
        "send-report": ["attachmentPath"],
        send_report: { attachmentPath: "bytes" },
      },
    });
    await invoke(t, { attachmentPath: file });
    expect(proposedArgs(request)[CONTENT_PIN_KEY]).toEqual([
      expect.objectContaining({ arg: "attachmentPath", mode: "bytes" }),
    ]);
    expect(() =>
      sendReport("send-report", () => "x", {
        client: stubClient({}),
        connectionId: "con_1",
        fileArgs: {
          "send-report": { attachmentPath: true },
          send_report: { attachmentPath: "recheck" },
        },
      }),
    ).toThrow(/fileArgs disagree/);
  });
});
