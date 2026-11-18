/**
 * Saves what `guardian init` received to an env file the shell can load
 * (`. ~/.config/guardian/env`), as skill.md section 3.1 describes: one
 * `export NAME=value` line per variable. Guardian's lines are replaced and
 * every other line is kept. The file is written with mode 600 in a folder
 * with mode 700, through a temporary file and a rename. Values are never
 * printed.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export const ENV_NAMES = [
  "GUARDIAN_AGENT_CREDENTIAL",
  "GUARDIAN_CONNECTION_ID",
  "GUARDIAN_BASE_URL",
] as const;

export type EnvValues = Readonly<{
  GUARDIAN_AGENT_CREDENTIAL: string;
  GUARDIAN_CONNECTION_ID: string;
  GUARDIAN_BASE_URL: string;
}>;

/** Safe to write unquoted: letters, digits and URL punctuation only. */
const SAFE_VALUE = /^[A-Za-z0-9_.:/-]+$/;

const OWN_LINE = new RegExp(`^\\s*(?:export\\s+)?(?:${ENV_NAMES.join("|")})=`);

/** The file's new text: Guardian's lines replaced, every other line kept. */
export function mergeEnvText(existing: string, values: EnvValues): string {
  for (const name of ENV_NAMES) {
    if (!SAFE_VALUE.test(values[name])) {
      throw new Error(`${name} has characters that cannot be written`);
    }
  }
  const kept = existing
    .split("\n")
    .filter((line) => !OWN_LINE.test(line))
    .join("\n")
    .replace(/\n+$/, "");
  const ours = ENV_NAMES.map((name) => `export ${name}=${values[name]}`);
  return `${kept === "" ? "" : `${kept}\n`}${ours.join("\n")}\n`;
}

export function writeEnvFile(path: string, values: EnvValues): void {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const text = mergeEnvText(existing, values);
  const temporary = join(
    folder,
    `.guardian-env-${randomBytes(6).toString("hex")}.tmp`,
  );
  writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
