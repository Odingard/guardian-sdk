#!/usr/bin/env node
/** The `guardian` command. `guardian init` sets Guardian up; see init.ts. */
import { createInterface } from "node:readline";

import {
  defaultHome,
  INIT_WORDS,
  openBrowser,
  runInit,
  runInstall,
  type InitIo,
} from "./init.js";

function prompt(question: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => {
      if (!answered) resolve(null);
    });
  });
}

/** One line without echo; the value is never written anywhere. */
function promptHidden(question: string): Promise<string | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return prompt(question);
  return new Promise((resolve) => {
    process.stdout.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (result: string | null) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(result);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(value);
        if (ch === "\u0003" || ch === "\u0004") return finish(null);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function waitForEnter():
  | { pressed: Promise<void>; cancel(): void }
  | undefined {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin });
  const pressed = new Promise<void>((resolve) => {
    rl.once("line", () => {
      rl.close();
      resolve();
    });
  });
  return { pressed, cancel: () => rl.close() };
}

const [command, ...rest] = process.argv.slice(2);
const io: InitIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  prompt,
  promptHidden,
  waitForEnter,
  openBrowser,
  cwd: process.cwd(),
  home: defaultHome(),
  now: () => Date.now(),
  runInstall,
};

if (command !== "init") {
  const help = command === "--help" || command === "-h";
  (help ? io.out : io.err)(INIT_WORDS.usage);
  process.exit(help ? 0 : 2);
}
runInit(rest, io).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "failed"}\n`,
    );
    process.exit(1);
  },
);
