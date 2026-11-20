import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "@mastra/core/agent";
import { createTool, isValidationError } from "@mastra/core/tools";
import { z } from "zod";
import { CONTENT_PIN_KEY, type PinnedFile } from "@odingard/guardian-sdk";

import { guardianTools } from "../src/index.js";
import {
  fakeGuardian,
  say,
  scriptedModel,
  toolCall,
  toolResultsSeen,
} from "./helpers.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mastra-pin-"));
  file = join(dir, "report.txt");
  writeFileSync(file, "approved bytes");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(
  run: (input: { attachmentPath: unknown }) => unknown,
  mode: "bytes" | "copy",
  onRequest?: () => void,
) {
  const guardian = fakeGuardian(() => {
    onRequest?.();
    return "ALLOW";
  });
  const body = vi.fn(run);
  const tools = guardianTools(
    {
      send: createTool({
        id: "send_report",
        description: "Send a report",
        inputSchema: z.object({ attachmentPath: z.string() }),
        execute: async (input) => body(input) as never,
      }),
    },
    {
      client: guardian.client,
      connectionId: "con_1",
      mode: "inProcess",
      fileArgs: { send_report: { attachmentPath: mode } },
    },
  );
  const { model, prompts } = scriptedModel([
    [toolCall("call_1", "send", { attachmentPath: file })],
    [say("Sent.")],
  ]);
  const agent = new Agent({
    id: "reports",
    name: "reports",
    instructions: "Send reports.",
    model,
    tools,
  });
  return { agent, body, guardian, prompts, tools };
}

describe("fileArgs on a Mastra tool (inProcess)", () => {
  it('"bytes" in an agent run: the tool receives the verified bytes, Guardian the pin', async () => {
    let seen: unknown;
    const { agent, guardian } = setup((input) => {
      seen = input;
      return { sent: true };
    }, "bytes");
    await agent.generate("Send the report");
    const pinned = (seen as { attachmentPath: PinnedFile }).attachmentPath;
    expect(new TextDecoder().decode(pinned.bytes)).toBe("approved bytes");
    expect(seen).not.toHaveProperty(CONTENT_PIN_KEY);
    expect(guardian.requests[0]!.arguments[CONTENT_PIN_KEY]).toEqual([
      expect.objectContaining({ arg: "attachmentPath", mode: "bytes" }),
    ]);
    expect(guardian.redeemed).toEqual(["req_1"]);
  });

  it("a file rewritten between the decision and the run is refused; the tool does not run", async () => {
    const { agent, body, guardian, prompts } = setup(
      () => ({ sent: true }),
      "bytes",
      () => writeFileSync(file, "rewritten bytes"),
    );
    await agent.generate("Send the report");
    expect(body).not.toHaveBeenCalled();
    expect(guardian.execute).not.toHaveBeenCalled();
    const output = toolResultsSeen(prompts)[0]!.output;
    expect(output.type).toBe("error-text");
    expect(output.value).toContain("CONTENT_CHANGED_SINCE_APPROVAL");
  });

  it('"bytes" on a direct execute call: the tool\'s schema refuses the bytes, nothing runs or is redeemed', async () => {
    const { body, guardian, tools } = setup(() => ({ sent: true }), "bytes");
    const out = await tools.send.execute!({ attachmentPath: file });
    expect(isValidationError(out)).toBe(true);
    expect(body).not.toHaveBeenCalled();
    expect(guardian.execute).not.toHaveBeenCalled();
  });

  it('"copy" on a direct execute call: the tool receives a private copy', async () => {
    let seen = "";
    const { guardian, tools } = setup((input) => {
      seen = String(input.attachmentPath);
      return { sent: true };
    }, "copy");
    await tools.send.execute!({ attachmentPath: file });
    expect(seen).not.toBe("");
    expect(seen).not.toBe(file);
    expect(guardian.redeemed).toEqual(["req_1"]);
  });
});
