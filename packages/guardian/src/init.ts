/**
 * `guardian init`: set Guardian up for the project in this folder.
 *
 * 1. Finds the framework (read-only).
 * 2. Asks which tools the agent runs through Guardian.
 * 3. Opens the console to sign in. There the person checks the code, and
 *    creates the agent and a record-only tool server for those tools; the
 *    console sends the agent credential to this command on 127.0.0.1
 *    (handoff.ts). If the browser cannot reach it, the person pastes it.
 * 4. Saves the credential and ids to an env file (mode 600), after a yes.
 * 5. Shows the pinned install line and how to wrap a tool.
 * 6. The person turns on the suggested rules in the browser (nothing is
 *    allowed before that), then one test action goes through Guardian.
 *
 * The credential is never printed, logged or put in a URL.
 */
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createGuardianClient,
  type GuardianClient,
} from "@odingard/guardian-sdk";

import { writeEnvFile, type EnvValues } from "./env-file.js";
import {
  CONNECTION_ID,
  CREDENTIAL,
  startHandoffServer,
  type Handoff,
  type HandoffServer,
} from "./handoff.js";
import {
  cleanName,
  detectProject,
  FRAMEWORK_LABELS,
  installCommand,
  matchCode,
  PYTHON_INSTALL,
  wrapExample,
  type Project,
} from "./project.js";
import { runSetupTest, SETUP_TEST_TOOL } from "./setup-test.js";

export const DEFAULT_CONSOLE = "https://guardian.odingard.com";
export const DEFAULT_API = "https://guardian-api.odingard.com";
/** How long the command waits for the browser. */
export const BROWSER_WAIT_MS = 10 * 60_000;

// Mirrors the tool name rule of the Guardian API.
const TOOL_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_TOOLS = 64;

/** Every word `guardian init` prints, in one place. */
export const INIT_WORDS = Object.freeze({
  usage: [
    "Usage: guardian init [options]",
    "",
    "Sets Guardian up for the project in this folder: signs you in in the",
    "browser, creates the agent and its tool server, saves the agent",
    "credential to an env file and sends one test action.",
    "",
    "  --tools <a,b>       tool names your agent runs through Guardian",
    "  --name <name>       agent name (default: the project name)",
    "  --server <name>     tool server name (default: <agent name> tools)",
    "  --env-file <path>   where to save the credential (default ~/.config/guardian/env)",
    "  --console <url>     Guardian console (default https://guardian.odingard.com)",
    "  --api <url>         Guardian API (default https://guardian-api.odingard.com)",
    "  --no-browser        print the link instead of opening the browser",
    "  --no-test           skip the test action",
    "  --yes               answer yes to every question",
    "  --help              print this help",
  ].join("\n"),
  title: "Guardian setup",
  found: (label: string) => `Found: ${label}.`,
  notFound:
    "No package.json, pyproject.toml or requirements.txt in this folder.",
  toolsPrompt:
    "Tool names your agent runs through Guardian (comma-separated): ",
  toolsInvalid: (name: string) =>
    `"${name}" is not a tool name Guardian accepts: lower-case letters and digits, separated by ".", "_" or "-".`,
  toolsTooMany: `At most ${MAX_TOOLS} tools.`,
  toolsNone: "Name at least one tool.",
  openPage: (url: string) => `Open this page to continue: ${url}`,
  code: (code: string) => `Code: ${code} (the page shows the same code)`,
  waiting:
    "Waiting for the browser. Press Enter to paste the credential instead.",
  waitingNoPaste: "Waiting for the browser.",
  credentialPrompt: "Agent credential (input hidden): ",
  credentialInvalid: "That is not an agent credential (it starts with gak_).",
  connectionPrompt: "Connection id: ",
  connectionInvalid: "That is not a connection id (it starts with pcn_).",
  received: "Got the agent credential and the connection id.",
  timedOut:
    "The browser did not answer in time. Nothing was saved. Run guardian init again.",
  savePrompt: (path: string) => `Save them to ${path}? [Y/n] `,
  saved: (path: string) => `Saved to ${path} (file mode 600).`,
  loadHint: (path: string) =>
    `Load it in the shell that starts your agent: . ${path}`,
  notSaved:
    "Not saved. The credential is not shown again: in the console, revoke the agent and run guardian init again.",
  installTitle: "Install:",
  installPrompt: "Run the install now? [Y/n] ",
  installFailed: "The install did not finish. Run the line above yourself.",
  wrapTitle: "Wrap each tool your agent runs, like this:",
  rulesPrompt:
    "Turn on the suggested rules in the browser, then press Enter to send a test action.",
  testWaiting: (requestId: string) =>
    `Test action: waiting for you to approve it in the console (request ${requestId}).`,
  testAllowed: "Test action: allowed and recorded.",
  testApproved: "Test action: approved and recorded.",
  testUnknown: (code: string, requestId: string) =>
    `Test action: Guardian could not confirm that it was recorded (${code}). Do not run it again; check request ${requestId} in the console.`,
  testExpired: "Test action: no one approved it in time.",
  testRefused: (code: string) =>
    `Test action refused (${code}). Check the rules for ${SETUP_TEST_TOOL} in the browser.`,
  testRetryPrompt: "Press Enter to try again, or type n to stop: ",
  done: (seconds: number) => `Done in ${seconds} seconds.`,
  badUrl: (flag: string) =>
    `${flag} must be an https address (http is accepted for 127.0.0.1 or localhost).`,
  unknownFlag: (flag: string) => `Unknown option: ${flag}`,
  missingValue: (flag: string) => `${flag} needs a value.`,
});

export type InitIo = Readonly<{
  out(text: string): void;
  err(text: string): void;
  /** Reads one line; null at end of input. */
  prompt(question: string): Promise<string | null>;
  /** Reads one line without echoing it; null when that is not possible. */
  promptHidden(question: string): Promise<string | null>;
  /** Resolves when the person presses Enter; never when input is not a terminal. */
  waitForEnter?(): { pressed: Promise<void>; cancel(): void } | undefined;
  openBrowser(url: string): void;
  cwd: string;
  home: string;
  now(): number;
  runInstall?(command: string, args: readonly string[]): boolean;
  client?(baseUrl: string, credential: string): GuardianClient;
  startServer?: typeof startHandoffServer;
}>;

type Options = {
  tools: string[] | null;
  name: string | null;
  server: string | null;
  envFile: string | null;
  console: string;
  api: string;
  browser: boolean;
  test: boolean;
  yes: boolean;
};

function allowedUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  // An IPv6 literal cannot be written to the env file unquoted.
  if (url.hostname.startsWith("[")) return null;
  return url.origin;
}

export function parseInitArgs(
  argv: readonly string[],
):
  | { ok: true; options: Options }
  | { ok: false; message: string; help?: true } {
  const options: Options = {
    tools: null,
    name: null,
    server: null,
    envFile: null,
    console: DEFAULT_CONSOLE,
    api: DEFAULT_API,
    browser: true,
    test: true,
    yes: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      i += 1;
      return next;
    };
    switch (flag) {
      case "--help":
      case "-h":
        return { ok: false, message: INIT_WORDS.usage, help: true };
      case "--no-browser":
        options.browser = false;
        break;
      case "--no-test":
        options.test = false;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--tools":
      case "--name":
      case "--server":
      case "--env-file":
      case "--console":
      case "--api": {
        const given = value();
        if (given === null) {
          return { ok: false, message: INIT_WORDS.missingValue(flag) };
        }
        if (flag === "--tools") {
          const tools = splitTools(given);
          if (!tools.ok) return { ok: false, message: tools.message };
          options.tools = tools.tools;
        } else if (flag === "--name") options.name = given;
        else if (flag === "--server") options.server = given;
        else if (flag === "--env-file") options.envFile = given;
        else {
          const origin = allowedUrl(given);
          if (origin === null) {
            return { ok: false, message: INIT_WORDS.badUrl(flag) };
          }
          if (flag === "--console") options.console = origin;
          else options.api = origin;
        }
        break;
      }
      default:
        return { ok: false, message: INIT_WORDS.unknownFlag(flag) };
    }
  }
  return { ok: true, options };
}

/** Tool names from a comma-separated list, with the test tool added. */
export function splitTools(
  text: string,
): { ok: true; tools: string[] } | { ok: false; message: string } {
  const names = [
    ...new Set(
      text
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    ),
  ];
  if (names.length === 0) return { ok: false, message: INIT_WORDS.toolsNone };
  for (const name of names) {
    if (name.length > 64 || !TOOL_NAME.test(name)) {
      return { ok: false, message: INIT_WORDS.toolsInvalid(name) };
    }
  }
  if (!names.includes(SETUP_TEST_TOOL)) names.push(SETUP_TEST_TOOL);
  if (names.length > MAX_TOOLS) {
    return { ok: false, message: INIT_WORDS.toolsTooMany };
  }
  return { ok: true, tools: names };
}

/** The console page that connects this terminal. */
export function connectUrl(input: {
  consoleOrigin: string;
  port: number;
  state: string;
  agentName: string;
  serverName: string;
  tools: readonly string[];
}): string {
  const params = new URLSearchParams({
    v: "1",
    port: String(input.port),
    state: input.state,
    agent: input.agentName,
    server: input.serverName,
    tools: input.tools.join(","),
  });
  return `${input.consoleOrigin}/connect?${params.toString()}`;
}

const yesAnswer = (answer: string | null): boolean =>
  answer !== null && /^(|y|yes)$/i.test(answer.trim());

async function askYes(io: InitIo, yes: boolean, question: string) {
  if (yes) return true;
  return yesAnswer(await io.prompt(question));
}

/** Waits for the browser, or for a pasted credential after Enter. */
async function receiveHandoff(
  io: InitIo,
  server: HandoffServer,
): Promise<Handoff | null> {
  const enter = io.waitForEnter?.();
  io.out(enter ? INIT_WORDS.waiting : INIT_WORDS.waitingNoPaste);
  const fromBrowser = server.received.then(
    (handoff) => ({ kind: "browser" as const, handoff }),
    () => ({ kind: "stopped" as const }),
  );
  const fromEnter = enter
    ? enter.pressed.then(() => ({ kind: "paste" as const }))
    : new Promise<never>(() => undefined);
  const first = await Promise.race([fromBrowser, fromEnter]);
  enter?.cancel();
  if (first.kind === "browser") return first.handoff;
  if (first.kind === "stopped") {
    io.err(INIT_WORDS.timedOut);
    return null;
  }
  server.close();
  for (;;) {
    const credential = await io.promptHidden(INIT_WORDS.credentialPrompt);
    if (credential === null) return null;
    if (CREDENTIAL.test(credential.trim())) {
      for (;;) {
        const connection = await io.prompt(INIT_WORDS.connectionPrompt);
        if (connection === null) return null;
        if (CONNECTION_ID.test(connection.trim())) {
          return {
            credential: credential.trim(),
            connectionId: connection.trim(),
          };
        }
        io.err(INIT_WORDS.connectionInvalid);
      }
    }
    io.err(INIT_WORDS.credentialInvalid);
  }
}

export async function runInit(
  argv: readonly string[],
  io: InitIo,
): Promise<number> {
  const parsed = parseInitArgs(argv);
  if (!parsed.ok) {
    (parsed.help ? io.out : io.err)(parsed.message);
    return parsed.help ? 0 : 2;
  }
  const options = parsed.options;
  const started = io.now();
  io.out(INIT_WORDS.title);
  const project: Project = detectProject(io.cwd);
  io.out(
    project.framework === null
      ? INIT_WORDS.notFound
      : INIT_WORDS.found(FRAMEWORK_LABELS[project.framework]),
  );

  let tools = options.tools;
  while (tools === null) {
    const answer = await io.prompt(INIT_WORDS.toolsPrompt);
    if (answer === null) return 2;
    const split = splitTools(answer);
    if (split.ok) tools = split.tools;
    else io.err(split.message);
  }
  const agentName = cleanName(options.name) ?? project.name ?? "My agent";
  const serverName =
    cleanName(options.server) ?? cleanName(`${agentName} tools`) ?? "My tools";

  const server = await (io.startServer ?? startHandoffServer)({
    consoleOrigin: options.console,
    timeoutMs: BROWSER_WAIT_MS,
  });
  const url = connectUrl({
    consoleOrigin: options.console,
    port: server.port,
    state: server.state,
    agentName,
    serverName,
    tools,
  });
  io.out(INIT_WORDS.openPage(url));
  io.out(INIT_WORDS.code(matchCode(server.state)));
  if (options.browser) io.openBrowser(url);
  const handoff = await receiveHandoff(io, server);
  server.close();
  if (handoff === null) return 1;
  io.out(INIT_WORDS.received);

  const envFile =
    options.envFile ?? join(io.home, ".config", "guardian", "env");
  const values: EnvValues = {
    GUARDIAN_AGENT_CREDENTIAL: handoff.credential,
    GUARDIAN_CONNECTION_ID: handoff.connectionId,
    GUARDIAN_BASE_URL: options.api,
  };
  if (await askYes(io, options.yes, INIT_WORDS.savePrompt(envFile))) {
    writeEnvFile(envFile, values, { restrictFolder: options.envFile === null });
    io.out(INIT_WORDS.saved(envFile));
    io.out(INIT_WORDS.loadHint(envFile));
  } else {
    io.out(INIT_WORDS.notSaved);
  }

  const framework = project.framework ?? "node";
  const install = installCommand({ ...project, framework });
  io.out(INIT_WORDS.installTitle);
  io.out(
    install === null
      ? PYTHON_INSTALL
      : [install.command, ...install.args].join(" "),
  );
  if (
    install !== null &&
    project.framework !== null &&
    io.runInstall !== undefined &&
    (await askYes(io, options.yes, INIT_WORDS.installPrompt))
  ) {
    if (!io.runInstall(install.command, install.args)) {
      io.err(INIT_WORDS.installFailed);
    }
  }
  const firstTool = tools.find((name) => name !== SETUP_TEST_TOOL) ?? tools[0]!;
  io.out(INIT_WORDS.wrapTitle);
  io.out(wrapExample(framework, firstTool));

  if (options.test) {
    const client = (io.client ?? defaultClient)(
      options.api,
      handoff.credential,
    );
    if ((await io.prompt(INIT_WORDS.rulesPrompt)) === null) return 1;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await runSetupTest({
        client,
        connectionId: handoff.connectionId,
        onWaiting: (requestId) => io.out(INIT_WORDS.testWaiting(requestId)),
      });
      if (outcome.kind === "allowed") io.out(INIT_WORDS.testAllowed);
      else if (outcome.kind === "approved") io.out(INIT_WORDS.testApproved);
      else if (outcome.kind === "expired") io.out(INIT_WORDS.testExpired);
      else if (outcome.kind === "unknown") {
        // It may have been recorded: never sent again.
        io.err(INIT_WORDS.testUnknown(outcome.reasonCode, outcome.requestId));
        return 1;
      } else {
        io.err(INIT_WORDS.testRefused(outcome.reasonCode));
        if (attempt === 2) return 1;
        const again = await io.prompt(INIT_WORDS.testRetryPrompt);
        if (again === null || /^n/i.test(again.trim())) return 1;
        continue;
      }
      break;
    }
  }
  io.out(INIT_WORDS.done(Math.round((io.now() - started) / 1000)));
  return 0;
}

function defaultClient(baseUrl: string, credential: string): GuardianClient {
  return createGuardianClient({ baseUrl, credential });
}

/** Opens the default browser; on a failure the printed link still works. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The link is printed; the person can open it.
  }
}

/** Runs the install with the terminal attached; no shell except on Windows. */
export function runInstall(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

export function defaultHome(): string {
  return homedir();
}
