/**
 * Codex and DeepSeek Harness: tool names, output
 * formats, and fail-closed behaviour, including through the real CLI.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { governedCall, patchTargets } from "../src/classify.js";
import type { DecideOptions } from "../src/decide.js";
import {
  CODEX_HOOK_COMMAND,
  CODEX_HOOKS_SNIPPET,
  DSH_HOOK_COMMAND,
  DSH_HOOKS_SNIPPET,
  parseArgs,
  runHookAs,
  setupText,
  type Dialect,
} from "../src/index.js";

type Client = DecideOptions["client"];
type Result = Awaited<ReturnType<Client["request"]>>;

const CRED = "gac1-test-credential-never-printed";
const ENV = {
  GUARDIAN_AGENT_CREDENTIAL: CRED,
  GUARDIAN_CONNECTION_ID: "pcn_everyday01",
  GUARDIAN_HOOK_ASK_CONNECTION_ID: "pcn_approval01",
};

function fake(script: { request: Result; claims?: Result[] }) {
  const seen: { toolName: string; arguments: unknown; purpose: string }[] = [];
  const calls: string[] = [];
  let i = 0;
  const client: Client = {
    async request(invocation) {
      const inv = invocation as {
        toolName: string;
        arguments: unknown;
        purpose: string;
      };
      seen.push(inv);
      calls.push(`request ${inv.toolName}`);
      return script.request;
    },
    async claim(requestId) {
      calls.push(`claim ${requestId}`);
      const claims = script.claims ?? [];
      return claims[Math.min(i++, claims.length - 1)]!;
    },
    async execute({ requestId }) {
      calls.push(`execute ${requestId}`);
      return {
        ok: true,
        receipt: { receiptReference: "r", status: "succeeded" } as never,
      };
    },
  };
  return { client, calls, seen };
}

const ALLOW: Result = {
  ok: true,
  requestId: "req_a",
  decision: "ALLOW",
  capabilityToken: "cap",
};
const PENDING: Result = {
  ok: false,
  reasonCode: "APPROVAL_REQUIRED",
  requestId: "req_q",
};

const stdin = (tool_name: string, tool_input: object) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s1",
    turn_id: "t1",
    tool_name,
    tool_input,
    cwd: "/data/workspace",
    permission_mode: "bypassPermissions",
  });

const PATCH = [
  "*** Begin Patch",
  "*** Add File: src/secret.ts",
  "+export const KEY = 'sk-live-should-not-leave';",
  "*** Update File: README.md",
  "*** Move to: docs/README.md",
  "@@",
  "-old",
  "+new",
  "*** Delete File: old.txt",
  "*** End Patch",
].join("\n");

describe("DeepSeek Harness tool names", () => {
  it.each([
    ["bash", { command: "npm test" }, "shell"],
    ["bash", { command: "terraform apply -auto-approve" }, "shell_deploy"],
    ["pwsh", { command: "rm -rf build" }, "shell_destructive"],
    ["terminal_send", { sessionId: "t", text: "git push" }, "git_push"],
    ["write", { file_path: "/w/a.ts", content: "x" }, "file_write"],
    [
      "edit",
      { file_path: "/w/a.ts", old_string: "a", new_string: "b" },
      "file_write",
    ],
    [
      "str_replace_editor",
      { command: "create", path: "/w/b.ts", file_text: "y" },
      "file_write",
    ],
    [
      "str_replace_editor",
      { command: "str_replace", path: "/w/b.ts", old_str: "y", new_str: "z" },
      "file_write",
    ],
    [
      "str_replace_editor",
      { command: "insert", path: "/w/b.ts", insert_line: 1, new_str: "z" },
      "file_write",
    ],
    ["web_fetch", { url: "https://example.com" }, "web_fetch"],
    ["mcp__github__create_issue", { title: "x" }, "mcp.github.create_issue"],
  ])("%s %j → %s", (tool, input, expected) => {
    expect(governedCall({ tool, input })?.toolName).toBe(expected);
  });

  it("leaves read-only dsh tools to the agent", () => {
    for (const tool of ["read", "glob", "grep", "web_search", "read_image"]) {
      expect(governedCall({ tool, input: {} })).toBeNull();
    }
    expect(
      governedCall({
        tool: "str_replace_editor",
        input: { command: "view", path: "/w" },
      }),
    ).toBeNull();
  });

  it("governs an unknown str_replace_editor command instead of skipping it", () => {
    expect(
      governedCall({
        tool: "str_replace_editor",
        input: { command: "undo_edit", path: "/w/b.ts" },
      })?.toolName,
    ).toBe("file_write");
  });

  it("digests file contents, never sends them", () => {
    const call = governedCall({
      tool: "str_replace_editor",
      input: { command: "create", path: "/w/.env", file_text: "TOKEN=abc" },
    })!;
    expect(JSON.stringify(call.arguments)).not.toContain("TOKEN=abc");
    expect(call.arguments.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(call.arguments.path).toBe("/w/.env");
  });
});

describe("Codex tool names", () => {
  it("Bash (shell and unified exec) uses tool_input.command", () => {
    expect(
      governedCall({ tool: "Bash", input: { command: "kubectl apply -f x" } })
        ?.toolName,
    ).toBe("shell_deploy");
    // argv form is classified on the joined command, not skipped
    expect(
      governedCall({ tool: "Bash", input: { command: ["rm", "-rf", "/"] } })
        ?.toolName,
    ).toBe("shell_destructive");
  });

  it("reads apply_patch target paths from the patch headers", () => {
    expect(patchTargets(PATCH)).toEqual([
      { op: "add", path: "src/secret.ts" },
      { op: "update", path: "README.md" },
      { op: "move", path: "docs/README.md" },
      { op: "delete", path: "old.txt" },
    ]);
  });

  it("governs apply_patch as file_write with paths and a digest, not the patch", () => {
    const call = governedCall({
      tool: "apply_patch",
      input: { command: PATCH },
    })!;
    expect(call.toolName).toBe("file_write");
    expect(call.arguments).toMatchObject({
      operation: "apply_patch",
      path: "src/secret.ts",
      paths: ["src/secret.ts", "README.md", "docs/README.md", "old.txt"],
      operations: [
        "add src/secret.ts",
        "update README.md",
        "move docs/README.md",
        "delete old.txt",
      ],
      contentBytes: Buffer.byteLength(PATCH),
    });
    const sent = JSON.stringify(call);
    expect(sent).not.toContain("sk-live-should-not-leave");
    expect(sent).not.toContain("+new");
    expect(call.summary).toMatch(/Patch 4 files/);
  });

  it("still governs a patch with no readable headers", () => {
    const call = governedCall({
      tool: "apply_patch",
      input: { command: "garbage" },
    })!;
    expect(call.toolName).toBe("file_write");
    expect(call.arguments.paths).toEqual([]);
  });
});

describe.each<Dialect>(["codex", "dsh"])("%s hook decisions", (dialect) => {
  const shell = stdin(dialect === "codex" ? "Bash" : "bash", {
    command: "npm test",
  });
  const deploy = stdin(dialect === "codex" ? "Bash" : "bash", {
    command: "terraform apply -auto-approve",
  });

  const expectDeny = (r: Awaited<ReturnType<typeof runHookAs>>) => {
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/Nothing ran|Guardian blocked|still waiting/);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
    expect(r.stdout + r.stderr).not.toContain(CRED);
  };

  it("allow: redeems, then lets the call run", async () => {
    const { client, calls, seen } = fake({ request: ALLOW });
    const r = await runHookAs(dialect, shell, ENV, { client });
    expect(r.exitCode).toBe(0);
    expect(r.verdict?.decision).toBe("allow");
    if (dialect === "codex") expect(r.stdout).toBe("");
    else
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe(
        "allow",
      );
    expect(calls).toEqual(["request shell", "execute req_a"]);
    expect(seen[0]!.purpose).toMatch(
      dialect === "codex" ? /^Codex: / : /^DeepSeek Harness: /,
    );
  });

  it("ask then approve: waits for the person, then runs", async () => {
    const { client, calls } = fake({
      request: PENDING,
      claims: [PENDING, { ...ALLOW, requestId: "req_q" }],
    });
    const r = await runHookAs(dialect, deploy, ENV, {
      client,
      wait: async () => {},
      log: () => {},
    });
    expect(r.exitCode).toBe(0);
    expect(r.verdict).toMatchObject({
      decision: "allow",
      approvedByHuman: true,
    });
    expect(calls).toEqual([
      "request shell_deploy",
      "claim req_q",
      "claim req_q",
      "execute req_q",
    ]);
  });

  it("ask then expire: denied, never redeemed", async () => {
    let t = 0;
    const { client, calls } = fake({ request: PENDING, claims: [PENDING] });
    const r = await runHookAs(dialect, deploy, ENV, {
      client,
      wait: async () => {},
      now: () => (t += 60_000),
      log: () => {},
    });
    expectDeny(r);
    expect(calls.some((c) => c.startsWith("execute"))).toBe(false);
  });

  it("deny: blocked with exit 2", async () => {
    const { client, calls } = fake({
      request: {
        ok: true,
        requestId: "r",
        decision: "DENY",
        reasonCode: "POLICY",
      },
    });
    const r = await runHookAs(dialect, deploy, ENV, { client });
    expectDeny(r);
    expect(calls).toEqual(["request shell_deploy"]);
  });

  it("governs file edits (apply_patch / write)", async () => {
    const { client, seen } = fake({ request: ALLOW });
    const input =
      dialect === "codex"
        ? stdin("apply_patch", { command: PATCH })
        : stdin("write", { file_path: "/w/a", content: "sk-live-x" });
    await runHookAs(dialect, input, ENV, { client });
    expect(seen[0]!.toolName).toBe("file_write");
    expect(JSON.stringify(seen[0]!.arguments)).not.toMatch(/sk-live/);
  });

  it("fail closed: no config, bad input, plain-http Guardian", async () => {
    for (const r of [
      await runHookAs(dialect, shell, {}),
      await runHookAs(dialect, "not json", ENV),
      await runHookAs(dialect, "null", ENV),
      await runHookAs(dialect, shell, {
        ...ENV,
        GUARDIAN_BASE_URL: "http://insecure",
      }),
    ]) {
      expectDeny(r);
    }
  });

  it("fail closed: Guardian unreachable", async () => {
    const client: Client = {
      async request() {
        throw new Error(`ECONNREFUSED with ${CRED}`);
      },
      async claim() {
        throw new Error("unused");
      },
      async execute() {
        throw new Error("unused");
      },
    };
    const r = await runHookAs(dialect, shell, ENV, { client });
    expectDeny(r);
    expect(r.stderr).toMatch(/could not be reached/);
  });

  it("fail closed: the hook crashes mid-decision", async () => {
    const { client } = fake({ request: PENDING, claims: [PENDING] });
    const r = await runHookAs(dialect, deploy, ENV, {
      client,
      wait: async () => {},
      log: () => {
        throw new Error("boom");
      },
    });
    expectDeny(r);
    expect(r.stderr).toMatch(/crashed/);
  });

  it("fail closed: Guardian hangs past the hook's deadline", async () => {
    const client: Client = {
      request: () => new Promise(() => {}),
      claim: () => new Promise(() => {}),
      execute: () => new Promise(() => {}),
    };
    const r = await runHookAs(
      dialect,
      shell,
      { ...ENV, GUARDIAN_HOOK_DEADLINE_MS: "30" },
      { client },
    );
    expectDeny(r);
    expect(r.stderr).toMatch(/deadline/);
  });

  it("no opinion on read-only tools", async () => {
    const r = await runHookAs(
      dialect,
      stdin(dialect === "codex" ? "update_plan" : "read", {}),
      ENV,
    );
    expect(r).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
  });
});

describe("Claude Code output is unchanged", () => {
  it("a deny stays JSON with exit 0", async () => {
    const r = await runHookAs(
      "claude-code",
      stdin("Bash", { command: "ls" }),
      {},
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });
});

describe("setup and config", () => {
  it("picks the agent from the subcommand or GUARDIAN_HOOK_DIALECT", () => {
    expect(parseArgs(["codex"], {})).toEqual({ dialect: "codex", rest: [] });
    expect(parseArgs(["dsh", "setup"], {})).toEqual({
      dialect: "dsh",
      rest: ["setup"],
    });
    expect(parseArgs([], { GUARDIAN_HOOK_DIALECT: "codex" }).dialect).toBe(
      "codex",
    );
    expect(parseArgs([], { GUARDIAN_HOOK_DIALECT: "bogus" }).dialect).toBe(
      "claude-code",
    );
  });

  it("Codex matcher covers shell, apply_patch and MCP within the 600 s timeout", () => {
    const group = CODEX_HOOKS_SNIPPET.hooks.PreToolUse[0]!;
    const re = new RegExp(group.matcher);
    for (const t of ["Bash", "apply_patch", "mcp__fs__write"]) {
      expect(re.test(t)).toBe(true);
    }
    expect(re.test("update_plan")).toBe(false);
    expect(group.hooks[0]!.timeout).toBe(600);
    expect(setupText("codex")).toContain("--dangerously-bypass-hook-trust");
  });

  it("dsh matcher covers its write tools and MCP, not read-only tools", () => {
    const group = DSH_HOOKS_SNIPPET.hooks.PreToolUse[0]!;
    const re = new RegExp(group.matcher);
    for (const t of [
      "bash",
      "pwsh",
      "terminal_send",
      "write",
      "edit",
      "str_replace_editor",
      "web_fetch",
      "mcp__github__create_issue",
    ]) {
      expect(re.test(t)).toBe(true);
    }
    for (const t of ["read", "grep", "glob", "bashful"]) {
      expect(re.test(t)).toBe(false);
    }
    expect(setupText("dsh")).toContain("dsh-hooks-claude-code");
  });
});

// ---- The real CLI, as each agent launches it ------------------------------

const here = fileURLToPath(new URL(".", import.meta.url));
let dir = "";
let cli = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "guardian-hook-cli-"));
  cli = join(dir, "guardian-hook.mjs");
  await build({
    entryPoints: [join(here, "../src/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: cli,
    logLevel: "silent",
  });
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function runCli(
  args: string[],
  input: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe.each<Dialect>(["codex", "dsh"])("%s CLI fails closed", (dialect) => {
  const input = stdin(dialect === "codex" ? "Bash" : "bash", {
    command: "terraform apply",
  });

  it("missing config → exit 2 with a deny", async () => {
    const r = await runCli([dialect], input, {});
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
    expect(r.stderr).toMatch(/must be set/);
  });

  it("Guardian unreachable → exit 2, credential never printed", async () => {
    const r = await runCli([dialect], input, {
      ...ENV,
      GUARDIAN_BASE_URL: "https://127.0.0.1:9",
    });
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(CRED);
  });

  it("Guardian hangs → the hook's deadline denies, exit 2", async () => {
    const server: Server = createServer(() => {
      /* accept and never answer */
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      const started = Date.now();
      const r = await runCli([dialect], input, {
        ...ENV,
        GUARDIAN_BASE_URL: `https://127.0.0.1:${port}`,
        GUARDIAN_HOOK_DEADLINE_MS: "400",
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/deadline/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.close();
    }
  });

  it("read-only tool → exit 0, no output", async () => {
    const r = await runCli(
      [dialect],
      stdin(dialect === "codex" ? "update_plan" : "grep", {}),
      ENV,
    );
    expect(r).toMatchObject({ code: 0, stdout: "" });
  });
});

describe("the documented hook command blocks when the hook cannot start", () => {
  it.each([
    ["codex", CODEX_HOOK_COMMAND],
    ["dsh", DSH_HOOK_COMMAND],
  ])("%s: a missing guardian-hook binary still exits 2", (_, command) => {
    const r = spawnSync("/bin/sh", ["-c", command], {
      env: { PATH: dir }, // no guardian-hook on PATH
      input: stdin("Bash", { command: "ls" }),
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/failed to run\. Nothing ran\./);
  });

  it.each([
    ["codex", CODEX_HOOK_COMMAND],
    ["dsh", DSH_HOOK_COMMAND],
  ])(
    "%s: a hook deny passes through with only Guardian's reason",
    (dialect, command) => {
      const shim = join(dir, "guardian-hook");
      writeFileSync(
        shim,
        `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`,
      );
      chmodSync(shim, 0o755);
      const r = spawnSync("/bin/sh", ["-c", command], {
        env: { PATH: `${dir}:/usr/bin:/bin` }, // no GUARDIAN_* config
        input: stdin(dialect === "codex" ? "Bash" : "bash", { command: "ls" }),
        encoding: "utf8",
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/must be set/);
      expect(r.stderr).not.toMatch(/failed to run/);
      rmSync(shim);
    },
  );
});
