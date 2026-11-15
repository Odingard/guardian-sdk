#!/usr/bin/env node
/** The `guardian-sdk` command. See cli.ts. */
import { runCli } from "./cli.js";

runCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
}).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "failed"}\n`,
    );
    process.exit(2);
  },
);
