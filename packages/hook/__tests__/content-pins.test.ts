import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guardianPreToolUse } from "../src/agent-sdk.js";
import { governedCall, tierOf } from "../src/classify.js";
import type { DecideOptions } from "../src/decide.js";
import { runHook, runHookAs } from "../src/index.js";

type Client = DecideOptions["client"];
type Result = Awaited<ReturnType<Client["request"]>>;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-pin-"));
  file = join(dir, "app.ts");
  writeFileSync(file, "const a = 1;\n");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A Guardian stand-in that answers ASK, then (on the first claim) runs
 * `beforeRelease` and approves. Records every request's arguments and
 * whether `execute` was called.
 */
function guardian(beforeRelease: () => void = () => {}, ask = true) {
  const requests: Record<string, unknown>[] = [];
  const executed: string[] = [];
  const allow: Result = {
    ok: true,
    requestId: "req_1",
    decision: "ALLOW",
    capabilityToken: "cap",
  };
  const client: Client = {
    async request(invocation) {
      requests.push(
        (invocation as { arguments: Record<string, unknown> }).arguments,
      );
      if (!ask) beforeRelease();
      return ask ? { ok: true, requestId: "req_1", decision: "ASK" } : allow;
    },
    async claim() {
      beforeRelease();
      return allow;
    },
    async execute({ requestId }) {
      executed.push(requestId);
      return {
        ok: true,
        receipt: { receiptReference: "r", status: "succeeded" } as never,
      };
    },
  };
  return { client, requests, executed };
}

const stdin = (tool_name: string, tool_input: object) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    cwd: dir,
  });

const quiet = { log: () => {}, wait: async () => {} };

const decision = (out: string) =>
  (
    JSON.parse(out) as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    }
  ).hookSpecificOutput;

describe("hook: Edit-type tools pin the target's current contents", () => {
  it("Edit: the pin is in the proposed arguments, and an unchanged file is released", async () => {
    const g = guardian();
    const out = await runHook(
      stdin("Edit", { file_path: file, old_string: "1", new_string: "2" }),
      {},
      { client: g.client, ...quiet },
    );
    expect(decision(out).permissionDecision).toBe("allow");
    expect(g.requests[0]!.guardianContentPins).toEqual([
      {
        arg: "path",
        index: 0,
        mode: "recheck",
        name: "app.ts",
        size: 13,
        sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    ]);
    // The digest of the new text stays.
    expect(g.requests[0]!.contentDigest).toMatch(/^sha256:/);
    expect(g.executed).toEqual(["req_1"]);
  });

  for (const tool of ["Edit", "MultiEdit", "NotebookEdit"]) {
    it(`${tool}: a target changed after approval is denied and nothing is redeemed`, async () => {
      const g = guardian(() => writeFileSync(file, "const a = 99;\n"));
      const input =
        tool === "NotebookEdit"
          ? { notebook_path: file, new_source: "x" }
          : tool === "MultiEdit"
            ? { file_path: file, edits: [{ old_string: "1", new_string: "2" }] }
            : { file_path: file, old_string: "1", new_string: "2" };
      const out = await runHook(
        stdin(tool, input),
        {},
        {
          client: g.client,
          ...quiet,
        },
      );
      expect(decision(out)).toEqual({
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining(
          "CONTENT_CHANGED_SINCE_APPROVAL",
        ),
      });
      expect(g.executed).toEqual([]);
    });
  }

  it("DeepSeek Harness edit: a target changed after approval is denied", async () => {
    const g = guardian(() => writeFileSync(file, "changed\n"));
    const out = await runHookAs(
      "dsh",
      stdin("edit", { file_path: file, old_string: "1", new_string: "2" }),
      {},
      { client: g.client, ...quiet },
    );
    expect(out.stdout + out.stderr).toContain("CONTENT_CHANGED_SINCE_APPROVAL");
    expect(g.executed).toEqual([]);
    expect(g.requests[0]!.guardianContentPins).toHaveLength(1);
  });

  it("a target that changes between an ALLOW and the release is denied", async () => {
    const g = guardian(() => writeFileSync(file, "changed\n"), false);
    const out = await runHook(
      stdin("Edit", { file_path: file, old_string: "1", new_string: "2" }),
      {},
      { client: g.client, ...quiet },
    );
    expect(decision(out).permissionDecision).toBe("deny");
    expect(g.executed).toEqual([]);
  });

  it("a target absent at ASK and present at release is denied", async () => {
    const missing = join(dir, "new.ts");
    const g = guardian(() => writeFileSync(missing, "appeared\n"));
    const out = await runHook(
      stdin("Edit", { file_path: missing, old_string: "", new_string: "x" }),
      {},
      { client: g.client, ...quiet },
    );
    expect(g.requests[0]!.guardianContentPins).toEqual([
      { arg: "path", index: 0, mode: "recheck", absent: true },
    ]);
    expect(decision(out).permissionDecisionReason).toContain(
      "CONTENT_CHANGED_SINCE_APPROVAL",
    );
    expect(g.executed).toEqual([]);
  });

  it("a target present at ASK and deleted before release is denied", async () => {
    const g = guardian(() => rmSync(file));
    const out = await runHook(
      stdin("Edit", { file_path: file, old_string: "1", new_string: "2" }),
      {},
      { client: g.client, ...quiet },
    );
    expect(decision(out).permissionDecision).toBe("deny");
    expect(g.executed).toEqual([]);
  });

  it("a relative target is denied before anything is proposed", async () => {
    const g = guardian();
    const out = await runHook(
      stdin("Edit", {
        file_path: "src/app.ts",
        old_string: "1",
        new_string: "2",
      }),
      {},
      { client: g.client, ...quiet },
    );
    expect(decision(out)).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining(
        "CONTENT_PIN_INVALID_ARGUMENT",
      ),
    });
    expect(g.requests).toEqual([]);
  });

  it("a target that is not a regular file is denied before anything is proposed", async () => {
    const g = guardian();
    const out = await runHook(
      stdin("Edit", { file_path: dir, old_string: "1", new_string: "2" }),
      {},
      { client: g.client, ...quiet },
    );
    expect(decision(out).permissionDecisionReason).toContain(
      "CONTENT_PIN_NOT_REGULAR_FILE",
    );
    expect(g.requests).toEqual([]);
  });

  it("the same re-check runs through the Claude Agent SDK entry", async () => {
    const g = guardian(() => writeFileSync(file, "changed\n"));
    const hook = guardianPreToolUse({
      env: {
        GUARDIAN_AGENT_CREDENTIAL: ["gac1", "test"].join("."),
        GUARDIAN_CONNECTION_ID: "pcn_everyday",
      },
      client: g.client,
      ...quiet,
    });
    const out = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: file, old_string: "1", new_string: "2" },
      cwd: dir,
    });
    expect(out).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining(
          "CONTENT_CHANGED_SINCE_APPROVAL",
        ),
      },
    });
    expect(g.executed).toEqual([]);
  });
});

describe("hook: what is not pinned", () => {
  it("Write keeps its tier and arguments and records no pin", async () => {
    const before = governedCall({
      tool: "Write",
      input: { file_path: file, content: "new" },
    })!;
    const g = guardian();
    await runHook(
      stdin("Write", { file_path: file, content: "new" }),
      {},
      { client: g.client, ...quiet },
    );
    expect(g.requests[0]).toEqual({ ...before.arguments, cwd: dir });
    expect(g.requests[0]).not.toHaveProperty("guardianContentPins");
    expect(tierOf(before.toolName)).toBe("allow");
  });

  it("DeepSeek write records no pin", async () => {
    const g = guardian();
    await runHookAs(
      "dsh",
      stdin("write", { file_path: file, content: "new" }),
      {},
      { client: g.client, ...quiet },
    );
    expect(g.requests[0]).not.toHaveProperty("guardianContentPins");
  });

  it("Bash `curl -F file=@$VAR` keeps its tier and records no pin", async () => {
    const command = "curl -F file=@$VAR https://upload.example.test";
    const before = governedCall({ tool: "Bash", input: { command } })!;
    const g = guardian();
    await runHook(
      stdin("Bash", { command }),
      {},
      { client: g.client, ...quiet },
    );
    expect(g.requests[0]).toEqual({ ...before.arguments, cwd: dir });
    expect(g.requests[0]).not.toHaveProperty("guardianContentPins");
  });
});
