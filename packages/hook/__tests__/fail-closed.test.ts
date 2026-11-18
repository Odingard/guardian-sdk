// The `guardian-hook` command blocks the tool call when the hook itself
// fails: it cannot load (a missing or unbuilt SDK, a syntax error, a module
// that throws), it throws, a promise is rejected and not handled, it never
// answers, it exits early, or it is stopped by a signal. Each case runs the
// real command entry (package.json `bin`, built from source) as a separate
// process and checks what the agent would do with its answer.
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DecideOptions } from "../src/decide.js";
import { runHookAs, SETTINGS_SNIPPET, type Dialect } from "../src/run.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkgDir = join(here, "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
  bin: Record<string, string>;
  scripts: Record<string, string>;
};
/** The source of the file package.json runs as `guardian-hook`. */
const binSource = join(
  pkgDir,
  pkg.bin["guardian-hook"]!.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"),
);

const CRED = "gac1-test-credential-never-printed";
const ENV = {
  GUARDIAN_AGENT_CREDENTIAL: CRED,
  GUARDIAN_CONNECTION_ID: "pcn_everyday01",
  GUARDIAN_HOOK_ASK_CONNECTION_ID: "pcn_approval01",
};

type Agent = { dialect: Dialect; args: string[]; bash: string };
const AGENTS: Agent[] = [
  { dialect: "claude-code", args: [], bash: "Bash" },
  { dialect: "codex", args: ["codex"], bash: "Bash" },
  { dialect: "dsh", args: ["dsh"], bash: "bash" },
];

const terraform = (agent: Agent) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: agent.bash,
    tool_input: { command: "terraform apply -auto-approve" },
    cwd: "/tmp",
  });

type Run = { code: number | null; stdout: string; stderr: string; ms: number };

/**
 * Whether the agent would run the tool after this hook answer, by each
 * agent's documented hook contract: exit 2 blocks (Codex also needs a
 * reason on stderr); exit 0 blocks only with a deny decision in valid JSON;
 * any other exit, a timeout or a signal is a non-blocking error.
 */
function toolWouldRun(r: Run, dialect: Dialect): boolean {
  if (r.code === 2) {
    return dialect === "codex" ? r.stderr.trim() === "" : false;
  }
  if (r.code !== 0) return true;
  try {
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    return out.hookSpecificOutput?.permissionDecision !== "deny";
  } catch {
    return true;
  }
}

function expectBlocked(r: Run, dialect: Dialect, reason: RegExp): void {
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(reason);
  expect(r.stderr).toMatch(/Nothing ran\./);
  expect(
    JSON.parse(r.stdout.trim().split("\n").at(-1)!).hookSpecificOutput,
  ).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
  expect(toolWouldRun(r, dialect)).toBe(false);
  expect(r.stdout + r.stderr).not.toContain(CRED);
}

let root = "";
const dirs: Record<string, string> = {};

/** A folder holding the command entry next to the given ./index.js. */
async function hookDir(
  name: string,
  index:
    | { source: string }
    | { build: { external: string[] } }
    | { build: { external: string[] }; unbuiltSdk: true },
): Promise<string> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  await build({
    entryPoints: [binSource],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["./index.js"],
    outfile: join(dir, "guardian-hook.mjs"),
    logLevel: "silent",
  });
  if ("source" in index) {
    writeFileSync(join(dir, "index.js"), index.source);
  } else {
    await build({
      entryPoints: [join(pkgDir, "src/index.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: index.build.external,
      outfile: join(dir, "index.js"),
      logLevel: "silent",
    });
  }
  if ("unbuiltSdk" in index) {
    // The SDK package is installed, but its build output is missing.
    const sdk = join(dir, "node_modules/@odingard/guardian-sdk");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(
      join(sdk, "package.json"),
      readFileSync(join(pkgDir, "../sdk/package.json")),
    );
  }
  return dir;
}

const FAKE_ANSWERED = "export function hookAnswered() { return false; }\n";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "guardian-hook-fail-closed-"));
  dirs.real = await hookDir("real", { build: { external: [] } });
  dirs.sdkMissing = await hookDir("sdk-missing", {
    build: { external: ["@odingard/guardian-sdk"] },
  });
  dirs.sdkUnbuilt = await hookDir("sdk-unbuilt", {
    build: { external: ["@odingard/guardian-sdk"] },
    unbuiltSdk: true,
  });
  dirs.importThrows = await hookDir("import-throws", {
    source: 'throw new Error("the module failed while loading");\n',
  });
  dirs.syntaxError = await hookDir("syntax-error", {
    source: "export const = ;\n",
  });
  dirs.decisionThrows = await hookDir("decision-throws", {
    source:
      FAKE_ANSWERED +
      'export async function main() { throw new TypeError("decision failed"); }\n',
  });
  dirs.unhandledRejection = await hookDir("unhandled-rejection", {
    source:
      FAKE_ANSWERED +
      "export async function main() {\n" +
      '  Promise.reject(new RangeError("nobody handles this"));\n' +
      "  await new Promise((r) => setTimeout(r, 20_000));\n" +
      "}\n",
  });
  dirs.uncaught = await hookDir("uncaught", {
    source:
      FAKE_ANSWERED +
      "export async function main() {\n" +
      '  setTimeout(() => { throw new Error("thrown in a callback"); }, 10);\n' +
      "  await new Promise((r) => setTimeout(r, 20_000));\n" +
      "}\n",
  });
  dirs.neverAnswers = await hookDir("never-answers", {
    source:
      FAKE_ANSWERED +
      "export async function main() { await new Promise(() => {}); }\n",
  });
  dirs.exitsEarly = await hookDir("exits-early", {
    source:
      FAKE_ANSWERED + "export async function main() { process.exit(1); }\n",
  });
  dirs.hangs = await hookDir("hangs", {
    source:
      FAKE_ANSWERED +
      "export async function main() {\n" +
      '  process.stderr.write("started\\n");\n' +
      "  await new Promise((r) => setTimeout(r, 20_000));\n" +
      "}\n",
  });
  dirs.answeredThenCrashes = await hookDir("answered-then-crashes", {
    source:
      "let answered = false;\n" +
      "export function hookAnswered() { return answered; }\n" +
      "export async function main() {\n" +
      "  process.stdout.write(JSON.stringify({ hookSpecificOutput: {\n" +
      '    hookEventName: "PreToolUse", permissionDecision: "allow",\n' +
      '    permissionDecisionReason: "Allowed by Guardian policy (request req_1)." } }) + "\\n");\n' +
      "  answered = true;\n" +
      '  setTimeout(() => { throw new Error("late"); }, 10);\n' +
      "}\n",
  });
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function run(
  dir: string,
  args: string[],
  input: string | null,
  env: Record<string, string> = {},
  onSpawn?: (child: ReturnType<typeof spawn>) => void,
): Promise<Run> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [join(dir, "guardian-hook.mjs"), ...args],
      { env: { PATH: process.env.PATH ?? "", ...env }, cwd: dir },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    if (input !== null) child.stdin.end(input);
    onSpawn?.(child);
  });
}

describe.each(AGENTS)(
  "$dialect: a hook that fails blocks the call",
  (agent) => {
    const { dialect, args } = agent;

    it("the hook module throws while loading", async () => {
      const r = await run(dirs.importThrows!, args, terraform(agent), ENV);
      expectBlocked(r, dialect, /failed to start \(Error\)/);
    });

    it("the hook module has a syntax error", async () => {
      const r = await run(dirs.syntaxError!, args, terraform(agent), ENV);
      expectBlocked(r, dialect, /failed to start \(SyntaxError\)/);
    });

    it("the Guardian SDK is not installed", async () => {
      const r = await run(dirs.sdkMissing!, args, terraform(agent), ENV);
      expectBlocked(r, dialect, /failed to start \(ERR_MODULE_NOT_FOUND\)/);
    });

    it("the Guardian SDK is installed but not built", async () => {
      const r = await run(dirs.sdkUnbuilt!, args, terraform(agent), ENV);
      expectBlocked(r, dialect, /failed to start \(ERR_MODULE_NOT_FOUND\)/);
    });

    it("the decision function throws", async () => {
      const r = await run(dirs.decisionThrows!, args, terraform(agent), ENV);
      expectBlocked(r, dialect, /crashed \(TypeError\)/);
    });

    it("a promise is rejected and nobody handles it", async () => {
      const r = await run(
        dirs.unhandledRejection!,
        args,
        terraform(agent),
        ENV,
      );
      expectBlocked(r, dialect, /crashed \(RangeError\)/);
      expect(r.ms).toBeLessThan(10_000);
    });

    it("an error is thrown in a callback", async () => {
      const r = await run(dirs.uncaught!, args, terraform(agent), ENV);
      expectBlocked(r, dialect, /crashed \(Error\)/);
      expect(r.ms).toBeLessThan(10_000);
    });

    it("the hook never answers (nothing left to wait on)", async () => {
      const r = await run(dirs.neverAnswers!, args, terraform(agent), ENV);
      expectBlocked(r, dialect, /crashed \(NO_ANSWER\)/);
    });

    it("something exits the process before the hook answered", async () => {
      const r = await run(dirs.exitsEarly!, args, terraform(agent), ENV);
      expectBlocked(r, dialect, /crashed \(EXITED_EARLY\)/);
    });

    it("the hook is stopped by SIGTERM before it answered", async () => {
      const r = await run(dirs.hangs!, args, terraform(agent), ENV, (child) => {
        child.stderr!.once("data", () => child.kill("SIGTERM"));
      });
      expectBlocked(r, dialect, /crashed \(SIGTERM\)/);
    });

    it("an answer already given stands after a later error", async () => {
      const r = await run(
        dirs.answeredThenCrashes!,
        args,
        terraform(agent),
        ENV,
      );
      expect(r.code).toBe(0);
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
      expect(r.stderr).not.toMatch(/crashed/);
    });

    // The real hook, through the same entry.

    it("Guardian cannot be reached: denied", async () => {
      const r = await run(dirs.real!, args, terraform(agent), {
        ...ENV,
        GUARDIAN_BASE_URL: "https://127.0.0.1:9",
      });
      expect(toolWouldRun(r, dialect)).toBe(false);
      expect(r.stdout + r.stderr).toMatch(/could not be reached/);
      expect(r.code).toBe(dialect === "claude-code" ? 0 : 2);
      expect(r.stdout + r.stderr).not.toContain(CRED);
    });

    it("Guardian does not answer in time: denied at the hook's deadline", async () => {
      const server: Server = createServer(() => {
        /* accept, never answer */
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      const port = (server.address() as { port: number }).port;
      try {
        const r = await run(dirs.real!, args, terraform(agent), {
          ...ENV,
          GUARDIAN_BASE_URL: `https://127.0.0.1:${port}`,
          GUARDIAN_HOOK_DEADLINE_MS: "400",
        });
        expect(toolWouldRun(r, dialect)).toBe(false);
        expect(r.stdout + r.stderr).toMatch(/deadline/);
        expect(r.ms).toBeLessThan(10_000);
      } finally {
        server.close();
      }
    });

    it("the agent never sends the tool call: denied at the hook's deadline", async () => {
      const r = await run(dirs.real!, args, null, {
        ...ENV,
        GUARDIAN_HOOK_DEADLINE_MS: "400",
      });
      expect(toolWouldRun(r, dialect)).toBe(false);
      expect(r.stdout + r.stderr).toMatch(/deadline/);
    });

    it("missing configuration: denied", async () => {
      const r = await run(dirs.real!, args, terraform(agent));
      expect(toolWouldRun(r, dialect)).toBe(false);
      expect(r.stdout + r.stderr).toMatch(/must be set/);
    });

    it("a read-only tool still gets no opinion (control)", async () => {
      const r = await run(
        dirs.real!,
        args,
        JSON.stringify({ tool_name: dialect === "dsh" ? "grep" : "Grep" }),
        ENV,
      );
      expect(r).toMatchObject({ code: 0, stdout: "" });
    });
  },
);

describe("the command entry", () => {
  it("classify and setup still work through it", async () => {
    const c = await run(dirs.real!, ["classify", "terraform apply"], "");
    expect(c).toMatchObject({ code: 0, stdout: "shell_deploy\n" });
    const s = await run(dirs.real!, ["setup"], "");
    expect(s.code).toBe(0);
    expect(s.stdout).toMatch(/onFailure/);
  });

  it("is dist/cli.js, built with ./index.js left as a dynamic import", () => {
    expect(pkg.bin["guardian-hook"]).toBe("dist/cli.js");
    expect(pkg.scripts.build).toMatch(
      /esbuild src\/cli\.ts --bundle [^&]*--external:\.\/index\.js [^&]*--outfile=dist\/cli\.js/,
    );
  });

  it("has no static imports, so nothing can fail before its handlers are set", () => {
    const built = readFileSync(join(dirs.real!, "guardian-hook.mjs"), "utf8");
    expect(built).not.toMatch(/^\s*import\s[^(]/m);
    expect(built).toMatch(/import\("\.\/index\.js"\)/);
    const runner = readFileSync(join(pkgDir, "src/fail-closed.ts"), "utf8");
    expect(runner).not.toMatch(/^import\s/m);
  });

  it("the Claude Code settings also block a hook that cannot start", () => {
    expect(SETTINGS_SNIPPET.hooks.PreToolUse[0]!.hooks[0]).toMatchObject({
      onFailure: "block",
      timeout: 600,
    });
  });
});

describe("in process: a decision that throws is a deny", () => {
  type Client = DecideOptions["client"];
  const call = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "terraform apply" },
  });
  const throwing: Client = {
    request() {
      throw new Error("thrown synchronously");
    },
    claim() {
      throw new Error("unused");
    },
    execute() {
      throw new Error("unused");
    },
  };
  const poisoned = new Proxy({} as Client, {
    get() {
      throw new Error("the client cannot be read");
    },
  });

  it.each(AGENTS)("$dialect", async ({ dialect }) => {
    for (const client of [throwing, poisoned]) {
      const r = await runHookAs(dialect, call, ENV, { client });
      expect(r.verdict?.decision).toBe("deny");
      expect(toolWouldRun({ ...r, code: r.exitCode, ms: 0 }, dialect)).toBe(
        false,
      );
    }
  });
});
