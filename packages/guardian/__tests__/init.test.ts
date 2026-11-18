import {
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  GuardianClient,
  GuardianRequestResult,
} from "@odingard/guardian-sdk";

import { mergeEnvText, writeEnvFile } from "../src/env-file.js";
import {
  connectUrl,
  INIT_WORDS,
  parseInitArgs,
  runInit,
  splitTools,
  type InitIo,
} from "../src/init.js";
import {
  detectProject,
  matchCode,
  VERSIONS,
  wrapExample,
} from "../src/project.js";
import { runSetupTest } from "../src/setup-test.js";

const CREDENTIAL = `gak_${"B".repeat(43)}`;
const CONNECTION = "pcn_0000000000005001";

describe("arguments", () => {
  it("reads every option", () => {
    const parsed = parseInitArgs([
      "--tools",
      "read_ticket, send_reply",
      "--name",
      "Support",
      "--server",
      "Support tools",
      "--env-file",
      "/tmp/x/env",
      "--console",
      "http://127.0.0.1:5173",
      "--api",
      "https://api.example.test/ignored/path",
      "--no-browser",
      "--no-test",
      "--yes",
    ]);
    expect(parsed).toEqual({
      ok: true,
      options: {
        tools: ["read_ticket", "send_reply", "guardian_setup_test"],
        name: "Support",
        server: "Support tools",
        envFile: "/tmp/x/env",
        console: "http://127.0.0.1:5173",
        api: "https://api.example.test",
        browser: false,
        test: false,
        yes: true,
      },
    });
  });

  it("refuses unknown options, missing values and unsafe addresses", () => {
    for (const argv of [
      ["--wat"],
      ["--tools"],
      ["--tools", "--yes"],
      ["--console", "http://guardian.example.test"],
      ["--api", "ftp://x"],
      ["--api", "https://user:pass@x.test"],
      ["--tools", "Bad Name"],
    ]) {
      expect(parseInitArgs(argv).ok, argv.join(" ")).toBe(false);
    }
    expect(parseInitArgs(["--help"])).toMatchObject({ ok: false, help: true });
  });

  it("keeps tool names Guardian accepts and adds the test tool once", () => {
    expect(splitTools("a,b,a")).toEqual({
      ok: true,
      tools: ["a", "b", "guardian_setup_test"],
    });
    expect(splitTools("guardian_setup_test")).toEqual({
      ok: true,
      tools: ["guardian_setup_test"],
    });
    expect(splitTools(" , ").ok).toBe(false);
    expect(
      splitTools(Array.from({ length: 64 }, (_, i) => `t${i}`).join(",")).ok,
    ).toBe(false);
  });
});

describe("the project", () => {
  const folder = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "guardian-init-"));
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };

  it("finds the framework from package.json", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ dependencies: { "@langchain/core": "1" } }, "langchain"],
      [{ dependencies: { ai: "6" } }, "vercel-ai"],
      [{ devDependencies: { "@openai/agents": "0.21" } }, "openai-agents"],
      [{ dependencies: { express: "5" } }, "node"],
    ];
    for (const [manifest, framework] of cases) {
      const dir = folder({
        "package.json": JSON.stringify({
          name: "@acme/support-bot",
          ...manifest,
        }),
      });
      expect(detectProject(dir)).toMatchObject({
        framework,
        name: "support-bot",
        packageManager: "npm",
      });
    }
    expect(
      detectProject(folder({ "package.json": "{}", "pnpm-lock.yaml": "" }))
        .packageManager,
    ).toBe("pnpm");
  });

  it("finds a Python project", () => {
    expect(
      detectProject(
        folder({ "pyproject.toml": '[project]\nname = "billing-agent"\n' }),
      ),
    ).toMatchObject({ framework: "python", name: "billing-agent" });
    expect(
      detectProject(folder({ "requirements.txt": "httpx\n" })).framework,
    ).toBe("python");
    expect(detectProject(folder({})).framework).toBeNull();
  });

  it("pins the versions released from this repository", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const version = (dir: string) =>
      (
        JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as {
          version: string;
        }
      ).version;
    expect(VERSIONS["@odingard/guardian-sdk"]).toBe(version("sdk"));
    expect(VERSIONS["@odingard/guardian-langchain"]).toBe(version("langchain"));
    expect(VERSIONS["@odingard/guardian-vercel-ai"]).toBe(version("vercel-ai"));
    expect(VERSIONS["@odingard/guardian-openai-agents"]).toBe(
      version("openai-agents"),
    );
    const pyproject = readFileSync(join(root, "python/pyproject.toml"), "utf8");
    expect(pyproject).toContain(`version = "${VERSIONS["odingard-guardian"]}"`);
  });

  it("shows how to wrap the first tool", () => {
    expect(wrapExample("langchain", "send_reply")).toContain(
      'const sendReply = guard("send_reply"',
    );
    expect(wrapExample("python", "send.reply")).toContain("def send_reply(");
  });
});

describe("the code and the link", () => {
  it("matches the console's code for the same state", () => {
    // The same vector is pinned in the console's own test.
    expect(matchCode("s".repeat(43))).toBe("TS5S-7JFH");
  });

  it("puts the names and tools in the link and never a credential", () => {
    const url = new URL(
      connectUrl({
        consoleOrigin: "https://guardian.example.test",
        port: 53111,
        state: "s".repeat(43),
        agentName: "Support agent",
        serverName: "Support tools",
        tools: ["read_ticket", "guardian_setup_test"],
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://guardian.example.test/connect",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      v: "1",
      port: "53111",
      state: "s".repeat(43),
      agent: "Support agent",
      server: "Support tools",
      tools: "read_ticket,guardian_setup_test",
    });
  });
});

describe("the env file", () => {
  const values = {
    GUARDIAN_AGENT_CREDENTIAL: CREDENTIAL,
    GUARDIAN_CONNECTION_ID: CONNECTION,
    GUARDIAN_BASE_URL: "https://guardian-api.odingard.com",
  };

  it("replaces Guardian's lines and keeps the rest", () => {
    const merged = mergeEnvText(
      "export OTHER=1\nexport GUARDIAN_AGENT_CREDENTIAL=gak_old\nGUARDIAN_BASE_URL=x\n# note\n",
      values,
    );
    expect(merged).toBe(
      [
        "export OTHER=1",
        "# note",
        `export GUARDIAN_AGENT_CREDENTIAL=${CREDENTIAL}`,
        `export GUARDIAN_CONNECTION_ID=${CONNECTION}`,
        "export GUARDIAN_BASE_URL=https://guardian-api.odingard.com",
        "",
      ].join("\n"),
    );
  });

  it("sets an existing default folder to mode 700, and leaves a named one", () => {
    const base = mkdtempSync(join(tmpdir(), "guardian-env-"));
    const folder = join(base, "guardian");
    mkdirSync(folder, { mode: 0o755 });
    chmodSync(folder, 0o755);
    writeEnvFile(join(folder, "env"), values, { restrictFolder: true });
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const named = join(base, "project");
    mkdirSync(named, { mode: 0o755 });
    chmodSync(named, 0o755);
    writeEnvFile(join(named, ".guardian.env"), values);
    expect(statSync(named).mode & 0o777).toBe(0o755);
    expect(statSync(join(named, ".guardian.env")).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind when the rename fails", () => {
    const folder = mkdtempSync(join(tmpdir(), "guardian-env-"));
    // A folder where the file should go makes the rename fail.
    mkdirSync(join(folder, "env"));
    expect(() => writeEnvFile(join(folder, "env"), values)).toThrow();
    expect(readdirSync(folder)).toEqual(["env"]);
  });

  it("refuses a value it cannot write safely", () => {
    expect(() =>
      mergeEnvText("", { ...values, GUARDIAN_BASE_URL: "https://x; rm -rf /" }),
    ).toThrow();
  });
});

function fakeClient(script: {
  request: GuardianRequestResult;
  claims?: GuardianRequestResult[];
}) {
  const calls: string[] = [];
  const client: GuardianClient = {
    async request(invocation) {
      calls.push(
        `request:${invocation.action}:${"toolName" in invocation ? invocation.toolName : ""}`,
      );
      return script.request;
    },
    async claim(requestId) {
      calls.push(`claim:${requestId}`);
      return (
        script.claims?.shift() ?? { ok: false, reasonCode: "APPROVAL_PENDING" }
      );
    },
    async execute({ requestId }) {
      calls.push(`execute:${requestId}`);
      return {
        ok: true,
        receipt: { requestId, status: "sent-verified" } as never,
      };
    },
    async portableReceipt() {
      return { ok: false, reasonCode: "UNUSED" };
    },
    async receipts() {
      return { ok: false, reasonCode: "UNUSED" };
    },
  };
  return { client, calls };
}

describe("the test action", () => {
  const instant = { sleep: async () => undefined, pollMs: 0 };

  it("records an allowed action", async () => {
    const { client, calls } = fakeClient({
      request: {
        ok: true,
        requestId: "req_t1",
        decision: "ALLOW",
        capabilityToken: "cap",
      },
    });
    await expect(
      runSetupTest({
        client,
        connectionId: CONNECTION,
        onWaiting: () => undefined,
        ...instant,
      }),
    ).resolves.toEqual({ kind: "allowed", requestId: "req_t1" });
    expect(calls).toEqual([
      "request:tool.invoke:guardian_setup_test",
      "execute:req_t1",
    ]);
  });

  it("waits for the person, then records the approved action", async () => {
    const waiting = vi.fn();
    const { client, calls } = fakeClient({
      request: {
        ok: false,
        reasonCode: "APPROVAL_REQUIRED",
        requestId: "req_t2",
      },
      claims: [
        { ok: false, reasonCode: "APPROVAL_PENDING" },
        {
          ok: true,
          requestId: "req_t2",
          decision: "ALLOW",
          capabilityToken: "cap",
        },
      ],
    });
    await expect(
      runSetupTest({
        client,
        connectionId: CONNECTION,
        onWaiting: waiting,
        ...instant,
      }),
    ).resolves.toEqual({ kind: "approved", requestId: "req_t2" });
    expect(waiting).toHaveBeenCalledWith("req_t2");
    expect(calls).toEqual([
      "request:tool.invoke:guardian_setup_test",
      "claim:req_t2",
      "claim:req_t2",
      "execute:req_t2",
    ]);
  });

  it("reports a denial and a refusal without running anything", async () => {
    const denied = fakeClient({
      request: {
        ok: true,
        requestId: "req_t3",
        decision: "DENY",
        reasonCode: "POLICY_DENY",
      },
    });
    await expect(
      runSetupTest({
        client: denied.client,
        connectionId: CONNECTION,
        onWaiting: () => undefined,
        ...instant,
      }),
    ).resolves.toEqual({
      kind: "denied",
      requestId: "req_t3",
      reasonCode: "POLICY_DENY",
    });
    expect(denied.calls).not.toContain("execute:req_t3");
    const refused = fakeClient({
      request: { ok: false, reasonCode: "INVALID_REQUEST" },
    });
    await expect(
      runSetupTest({
        client: refused.client,
        connectionId: CONNECTION,
        onWaiting: () => undefined,
        ...instant,
      }),
    ).resolves.toEqual({ kind: "refused", reasonCode: "INVALID_REQUEST" });
  });

  it("stops waiting at the deadline", async () => {
    let clock = 0;
    const { client } = fakeClient({
      request: {
        ok: false,
        reasonCode: "APPROVAL_REQUIRED",
        requestId: "req_t4",
      },
    });
    await expect(
      runSetupTest({
        client,
        connectionId: CONNECTION,
        onWaiting: () => undefined,
        sleep: async () => {
          clock += 1_000;
        },
        now: () => clock,
        waitMs: 3_000,
      }),
    ).resolves.toEqual({
      kind: "expired",
      requestId: "req_t4",
      reasonCode: "APPROVAL_PENDING",
    });
  });
});

describe("guardian init, end to end with a stand-in browser", () => {
  function setup(answers: Array<string | null>) {
    const home = mkdtempSync(join(tmpdir(), "guardian-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "guardian-project-"));
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "support-bot",
        dependencies: { "@langchain/core": "1" },
      }),
    );
    const out: string[] = [];
    const err: string[] = [];
    const { client, calls } = fakeClient({
      request: {
        ok: true,
        requestId: "req_t5",
        decision: "ALLOW",
        capabilityToken: "cap",
      },
    });
    let opened = "";
    const io: InitIo = {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      prompt: async () => (answers.length > 0 ? answers.shift()! : null),
      promptHidden: async () => null,
      openBrowser: (url) => {
        opened = url;
        // The console page: posts the handoff to the terminal.
        const link = new URL(url);
        void fetch(
          `http://127.0.0.1:${link.searchParams.get("port")}/guardian-init`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: link.origin,
            },
            body: JSON.stringify({
              v: 1,
              state: link.searchParams.get("state"),
              credential: CREDENTIAL,
              agentId: "agt_0000000000005001",
              connectionId: CONNECTION,
            }),
          },
        );
      },
      cwd,
      home,
      now: (() => {
        let t = 0;
        return () => (t += 1_000);
      })(),
      client: () => client,
    };
    return { io, out, err, home, calls, opened: () => opened };
  }

  it("saves the credential, shows how to wrap a tool and sends the test action", async () => {
    // Answers: save? (Enter = yes), rules turned on (Enter).
    const run = setup(["", ""]);
    const code = await runInit(["--tools", "send_reply"], run.io);
    expect(code, run.err.join("\n")).toBe(0);
    const link = new URL(run.opened());
    expect(link.searchParams.get("agent")).toBe("support-bot");
    expect(link.searchParams.get("server")).toBe("support-bot tools");
    expect(link.searchParams.get("tools")).toBe(
      "send_reply,guardian_setup_test",
    );
    const envPath = join(run.home, ".config", "guardian", "env");
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain(`export GUARDIAN_AGENT_CREDENTIAL=${CREDENTIAL}`);
    expect(env).toContain(`export GUARDIAN_CONNECTION_ID=${CONNECTION}`);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(envPath)).mode & 0o777).toBe(0o700);
    expect(run.out).toContain(INIT_WORDS.found("LangChain (TypeScript)"));
    expect(run.out).toContain(INIT_WORDS.testAllowed);
    expect(run.calls).toEqual([
      "request:tool.invoke:guardian_setup_test",
      "execute:req_t5",
    ]);
    // The credential is never printed.
    expect([...run.out, ...run.err].join("\n")).not.toContain(CREDENTIAL);
  });

  it("saves nothing without a yes", async () => {
    const run = setup(["n"]);
    const code = await runInit(["--tools", "send_reply", "--no-test"], run.io);
    expect(code).toBe(0);
    expect(run.out).toContain(INIT_WORDS.notSaved);
    expect(() =>
      readFileSync(join(run.home, ".config", "guardian", "env"), "utf8"),
    ).toThrow();
    expect(run.calls).toEqual([]);
  });

  it("avoids the words the product wording rules out", () => {
    const words: string[] = [];
    for (const value of Object.values(INIT_WORDS)) {
      words.push(typeof value === "string" ? value : value("X" as never));
    }
    const banned = /\b(only|first|nobody|tamper-proof|phone|receipts?)\b/i;
    for (const text of words) expect(text, text).not.toMatch(banned);
  });
});
