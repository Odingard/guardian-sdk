/**
 * Review fixes for the Codex and DeepSeek Harness hooks:
 * interactive sessions fed by write_stdin, the dsh matcher (apply_patch and
 * Claude Code names), stdin read under the deadline, and patch headers.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  classifyCommand,
  governedCall,
  HOOK_TOOLS,
  patchTargets,
  tierOf,
} from "../src/classify.js";
import type { DecideOptions } from "../src/decide.js";
import {
  CODEX_HOOKS_SNIPPET,
  DSH_HOOKS_SNIPPET,
  readHookInput,
  runHookAs,
  setupText,
  type Dialect,
} from "../src/index.js";

type Client = DecideOptions["client"];

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../../..");
const CRED = "gac1-test-credential-never-printed";
const ENV = {
  GUARDIAN_AGENT_CREDENTIAL: CRED,
  GUARDIAN_CONNECTION_ID: "pcn_everyday01",
  GUARDIAN_HOOK_ASK_CONNECTION_ID: "pcn_approval01",
};

const PATCH = [
  "*** Begin Patch",
  "*** Delete File: src/auth.ts",
  "*** Add File: .codex/hooks.json",
  "+{}",
  "*** End Patch",
].join("\n");

const hookJson = (tool_name: string, tool_input: object) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input });

describe("interactive sessions go to the Ask tier (Codex write_stdin gap)", () => {
  it("shell_session is a registered Ask-tier tool", () => {
    const t = HOOK_TOOLS.find((x) => x.name === "shell_session");
    expect(t?.suggestedMode).toBe("ask");
    expect(tierOf("shell_session")).toBe("ask");
  });

  it.each([
    "bash",
    "sh",
    "bash -l",
    "bash -i",
    "zsh -is",
    "bash -s",
    "python3",
    "python3 -i script.py",
    "python -",
    "node",
    "node --interactive",
    "irb",
    "cd infra && bash",
    "cat | sh",
    "env FOO=1 bash",
    "time bash",
    "/bin/bash --login",
    "sudo -i",
    "sudo -s",
    "sudo -u deploy bash",
    "ssh prod-1",
    "ssh -p 2222 -i key.pem ops@prod-1",
    "ssh -t prod-1 bash",
    "docker exec -it api sh",
    "docker run -it alpine",
    "kubectl -n prod exec -it api -- sh",
    "kubectl exec --stdin api -- sh",
    "psql -h db -U me app",
    "mysql -u root app",
    "sqlite3 app.db",
    "redis-cli -h cache",
    "nc prod-1 5432",
    "telnet prod-1 25",
    "bash -c 'bash'",
    'sh -c "python3"',
    "bash -c 'while read l; do eval \"$l\"; done'",
  ])("%s → shell_session", (command) => {
    expect(classifyCommand(command)).toBe("shell_session");
  });

  it.each([
    "npm test",
    "ls -la && cat README.md",
    "bash script.sh",
    "bash -c 'npm test'",
    "sh -c 'ls | wc -l'",
    "python3 script.py",
    "python -m pytest -q",
    "node build.js",
    "node -e 'console.log(1)'",
    "node --version",
    "python3 --version",
    "ssh prod-1 uptime",
    "ssh -p 22 prod-1 'ls -la'",
    "docker run --rm alpine ls",
    "docker ps",
    "kubectl get pods",
    "psql -c 'select 1'",
    "mysql -u root -e 'select 1'",
    "psql app < schema.sql",
    "sqlite3 app.db 'select 1'",
    "redis-cli GET key",
    "nc -z prod-1 5432",
    "sudo apt-get install -y jq",
    "echo hi | tee out.txt",
    "make",
  ])("%s → shell", (command) => {
    expect(classifyCommand(command)).toBe("shell");
  });

  it("Codex exec_command `bash` (reported as Bash) is routed to the Ask connection", async () => {
    const call = governedCall({ tool: "Bash", input: { command: "bash" } })!;
    expect(call.toolName).toBe("shell_session");
    const seen: { toolName: string; connectionId?: string }[] = [];
    const client: Client = {
      async request(inv) {
        seen.push(inv as never);
        return { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "q" };
      },
      async claim() {
        return { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId: "q" };
      },
      async execute() {
        throw new Error("must not redeem");
      },
    };
    let t = 0;
    const r = await runHookAs(
      "codex",
      hookJson("Bash", { command: "bash" }),
      ENV,
      {
        client,
        wait: async () => {},
        now: () => (t += 60_000),
        log: () => {},
      },
    );
    expect(r.exitCode).toBe(2);
    expect(seen[0]!.toolName).toBe("shell_session");
    expect(JSON.stringify(seen[0])).toContain("pcn_approval01");
  });

  it("setup text and docs disclose write_stdin and how to turn unified exec off", () => {
    const codex = setupText("codex");
    expect(codex).toContain("write_stdin");
    expect(codex).toContain("unified_exec = false");
    for (const file of [
      "packages/hook/README.md",
      "examples/codex/README.md",
      "CHANGELOG.md",
    ]) {
      const text = readFileSync(join(repo, file), "utf8");
      expect(text, file).toContain("write_stdin");
    }
    expect(
      readFileSync(join(repo, "examples/codex/requirements.toml"), "utf8"),
    ).toMatch(/unified_exec\s*=\s*false/);
  });
});

describe("the dsh matcher selects every tool the hook governs", () => {
  const dsh = new RegExp(DSH_HOOKS_SNIPPET.hooks.PreToolUse[0]!.matcher);
  const codex = new RegExp(CODEX_HOOKS_SNIPPET.hooks.PreToolUse[0]!.matcher);

  // Every name governedCall() governs, with an input it would govern.
  const governed: [string, Record<string, unknown>][] = [
    ["bash", { command: "ls" }],
    ["pwsh", { command: "ls" }],
    ["terminal_send", { text: "ls" }],
    ["write", { file_path: "a", content: "x" }],
    ["edit", { file_path: "a", new_string: "x" }],
    ["apply_patch", { input: PATCH }],
    ["str_replace_editor", { command: "create", path: "a" }],
    ["web_fetch", { url: "https://x" }],
    ["Bash", { command: "ls" }],
    ["Write", { file_path: "a", content: "x" }],
    ["Edit", { file_path: "a", new_string: "x" }],
    ["MultiEdit", { file_path: "a", edits: [] }],
    ["NotebookEdit", { notebook_path: "a" }],
    ["WebFetch", { url: "https://x" }],
    ["mcp__github__create_issue", {}],
  ];

  it.each(governed)(
    "%s is governed and matched by the dsh matcher",
    (tool, input) => {
      expect(governedCall({ tool, input })).not.toBeNull();
      expect(dsh.test(tool)).toBe(true);
    },
  );

  it("Codex's names (Bash, apply_patch, mcp__*) are matched by the Codex matcher", () => {
    for (const t of ["Bash", "apply_patch", "mcp__fs__write"]) {
      expect(codex.test(t)).toBe(true);
    }
  });

  it("dsh apply_patch ({input: patch}) is governed as file_write with its paths", () => {
    const call = governedCall({
      tool: "apply_patch",
      input: { input: PATCH },
    })!;
    expect(call.toolName).toBe("file_write");
    expect(call.arguments.operations).toEqual([
      "delete src/auth.ts",
      "add .codex/hooks.json",
    ]);
    expect(JSON.stringify(call)).not.toContain("+{}");
  });

  it("the shipped example configs match what setup prints", () => {
    const dshFile = JSON.parse(
      readFileSync(
        join(repo, "examples/deepseek-harness/guardian-hooks.json"),
        "utf8",
      ),
    );
    expect(dshFile).toEqual(DSH_HOOKS_SNIPPET);
    const codexFile = JSON.parse(
      readFileSync(join(repo, "examples/codex/hooks.json"), "utf8"),
    );
    expect(codexFile.hooks).toEqual(CODEX_HOOKS_SNIPPET.hooks);
    const toml = readFileSync(
      join(repo, "examples/codex/requirements.toml"),
      "utf8",
    );
    expect(toml).toContain(
      `matcher = "${CODEX_HOOKS_SNIPPET.hooks.PreToolUse[0]!.matcher}"`,
    );
    expect(setupText("dsh")).toContain("apply_patch");
  });
});

describe("patch headers", () => {
  it("reads indented and CRLF headers", () => {
    const crlf =
      "*** Begin Patch\r\n  *** Delete File: a.ts\r\n\t*** Add File: b.ts\r\n";
    expect(patchTargets(crlf)).toEqual([
      { op: "delete", path: "a.ts" },
      { op: "add", path: "b.ts" },
    ]);
  });
});

describe("the deadline covers reading stdin", () => {
  it.each<Dialect>(["codex", "dsh", "claude-code"])(
    "%s: stdin that never arrives is denied at the deadline",
    async (dialect) => {
      const r = await runHookAs(dialect, new Promise<string>(() => {}), {
        ...ENV,
        GUARDIAN_HOOK_DEADLINE_MS: "30",
      });
      expect(r.verdict?.decision).toBe("deny");
      expect(r.verdict?.reason).toMatch(/deadline/);
    },
  );

  it("a stdin read that fails is a deny", async () => {
    const r = await runHookAs("codex", Promise.reject(new Error("EPIPE")), ENV);
    expect(r.exitCode).toBe(2);
  });

  it("readHookInput answers on a complete object without waiting for end of input", async () => {
    const s = new PassThrough();
    const p = readHookInput(s);
    s.write('{"tool_name":');
    s.write('"Bash","tool_input":{"command":"x}"}}\n');
    await expect(p).resolves.toContain('"Bash"');
    s.destroy();
  });
});

// ---- The real CLI with stdin left open ------------------------------------

let dir = "";
let cli = "";
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "guardian-hook-stdin-"));
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

function runOpen(
  args: string[],
  write: string,
  env: Record<string, string>,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const kill = setTimeout(() => child.kill("SIGKILL"), 8_000);
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    if (write) child.stdin.write(write); // and never end it
  });
}

describe.each<Dialect>(["codex", "dsh"])(
  "%s CLI with stdin held open",
  (dialect) => {
    it("no input at all: denied at the deadline, exit 2", async () => {
      const r = await runOpen([dialect], "", {
        ...ENV,
        GUARDIAN_HOOK_DEADLINE_MS: "500",
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/deadline/);
      expect(r.ms).toBeLessThan(5_000);
      expect(r.stdout + r.stderr).not.toContain(CRED);
    });

    it("a complete input: answered without waiting for end of input", async () => {
      const r = await runOpen(
        [dialect],
        hookJson(dialect === "codex" ? "Bash" : "bash", { command: "ls" }),
        {}, // no config: a quick deny, well before any deadline
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/must be set/);
      expect(r.ms).toBeLessThan(5_000);
    });
  },
);
