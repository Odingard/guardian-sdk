#!/usr/bin/env node
/**
 * Checks skill.md (the setup file a coding agent reads) against the packages
 * in this repository, so the file cannot drift from the code it describes.
 *
 *   node scripts/check-skill.mjs            check ./skill.md (run after npm run build)
 *   node scripts/check-skill.mjs --static   skip the checks that run code
 *                                           (hook classify, tsc, sh -n, python)
 *
 * Two groups of checks:
 *   - drift: package pins, forbidden install patterns, environment variables,
 *     hook subcommands and tool names, the hook matchers, status words,
 *     canonical and check-copy URLs, size, and the changelog hash;
 *   - code blocks: sh blocks pass `sh -n`, json blocks parse, ts/js blocks
 *     type-check against the workspace packages, python blocks compile and
 *     import only names in odingard_guardian.__all__.
 *
 * Node built-ins only, plus the workspace's tsc and the system sh/python3.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CANONICAL_URL = "https://odingard.com/guardian/skill.md";
export const MAX_BYTES = 30 * 1024;

/** Workspace package directory for each package the file may pin. */
export const PACKAGE_DIRS = {
  "@odingard/guardian-sdk": "packages/sdk",
  "@odingard/guardian-hook": "packages/hook",
  "@odingard/guardian-mcp": "packages/mcp",
  "@odingard/guardian-langchain": "packages/langchain",
  "@odingard/guardian-vercel-ai": "packages/vercel-ai",
  "@odingard/guardian-openai-agents": "packages/openai-agents",
  "@odingard/guardian-openclaw": "packages/openclaw",
  "odingard-guardian": "packages/python",
};

/** Hook tool names the file may name; each must be in HOOK_TOOLS. */
export const HOOK_TOOL_NAMES = [
  "shell",
  "file_write",
  "web_fetch",
  "shell_deploy",
  "shell_destructive",
  "git_push",
  "shell_session",
];

/**
 * Status words per integration section. Each entry: the row label in the
 * root README "Works with" table and the status words, which must be the
 * row's status cell and must appear (any case) in that section of the file.
 * `source` overrides where the words must be found verbatim.
 */
export const STATUS = {
  "4A": [{ row: "Claude Code", status: "Proven on production" }],
  "4B": [
    { row: "Claude Agent SDK (TypeScript)", status: "Proven on production" },
  ],
  "4C": [{ row: "Codex CLI", status: "Example, not yet tested" }],
  "4D": [{ row: "DeepSeek Harness", status: "Example, not yet tested" }],
  "4E": [
    { row: "Any MCP server, local (stdio)", status: "Proven on production" },
    {
      row: "Any MCP server, remote (`--url`)",
      status: "Tested against Guardian; production proof pending",
    },
  ],
  "4F": [
    {
      row: "LangChain.js / LangGraph",
      status: "Tested against Guardian; production proof pending",
    },
    {
      row: "Vercel AI SDK",
      status: "Tested against Guardian; production proof pending",
    },
    {
      row: "OpenAI Agents SDK (TypeScript)",
      status:
        "Tested, but not yet proven against a live Guardian and a live model",
      source: "packages/openai-agents/README.md",
    },
  ],
  "4G": [
    {
      row: "Python with LangChain / OpenAI Agents SDK",
      status: "Tested against Guardian; production proof pending",
    },
    { row: "Python with CrewAI", status: "Example, not yet tested" },
    { row: "Claude Agent SDK (Python)", status: "Example, not yet tested" },
    { row: "Hermes Agent", status: "Example, not yet tested" },
  ],
  "4H": [{ row: "OpenClaw", status: "Proven on production (shell commands)" }],
};

/** Patterns an agent must never be told to run. */
const FORBIDDEN = [
  { re: /@latest\b/, what: "@latest" },
  { re: /\|\s*(sh|bash|zsh)\b/, what: "a pipe into a shell" },
  { re: /\b(bash|sh)\s+<\(/, what: "bash <(…)" },
  { re: /\bsudo\b/, what: "sudo" },
  {
    re: /--dangerously-skip-permissions/,
    what: "--dangerously-skip-permissions",
  },
  {
    re: /--dangerously-bypass-hook-trust/,
    what: "--dangerously-bypass-hook-trust",
  },
  { re: /--break-system-packages/, what: "--break-system-packages" },
  // dash (Debian/Ubuntu /bin/sh) prints nothing when the first of several
  // names is missing, so detection must ask one name at a time.
  {
    re: /\bcommand -v\s+[\w.-]+\s+[\w.-]/,
    what: "command -v with more than one name",
  },
];

/** A prose line that names a forbidden pattern only to forbid it. */
const FORBIDS = /\b(never|not|no|do not|don't|without)\b/i;

// ---------------------------------------------------------------- parsing

export function parseFrontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const fields = {};
  const packages = {};
  let inPackages = false;
  for (const line of match[1].split("\n")) {
    const nested = /^\s+"?([^":]+)"?:\s*(.+)$/.exec(line);
    if (inPackages && nested) {
      packages[nested[1].trim()] = nested[2].trim();
      continue;
    }
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      inPackages = top[1] === "packages" && top[2] === "";
      if (!inPackages) fields[top[1]] = top[2].trim();
    }
  }
  return { fields, packages, body: text.slice(match[0].length) };
}

/** Fenced code blocks: { lang, code, line }. */
export function codeBlocks(text) {
  const blocks = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\w*)\s*$/.exec(lines[i]);
    if (!open) continue;
    const start = i;
    const code = [];
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) {
      code.push(lines[i]);
    }
    blocks.push({ lang: open[1], code: code.join("\n"), line: start + 1 });
  }
  return blocks;
}

/** Split the body into sections keyed by heading id ("0", "3", "4A", …). */
export function sections(body) {
  const out = {};
  let key = "";
  for (const line of body.split("\n")) {
    const heading = /^#{2,3} (\d+[A-H]?)(?:\.\d+)?\.? /.exec(line);
    if (heading && !/^### \d+\.\d+/.test(line)) key = heading[1];
    out[key] = (out[key] ?? "") + line + "\n";
  }
  return out;
}

/** Status cell of a row in the README's "Works with" table. */
export function readmeStatus(readme, row) {
  for (const line of readme.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length >= 5 && cells[1] === row) return cells[3];
  }
  return undefined;
}

function proseLines(text) {
  const out = [];
  let fenced = false;
  text.split("\n").forEach((line, index) => {
    if (/^```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) out.push({ line, number: index + 1 });
  });
  return out;
}

function walk(dir, ext, files = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === "dist") {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, ext, files);
    else if (ext.some((e) => name.endsWith(e)) && !/\.test\./.test(name)) {
      files.push(path);
    }
  }
  return files;
}

// ----------------------------------------------------------------- checks

/**
 * The drift checks. Pure apart from reading the repository at `root`.
 * Returns a list of error strings (empty when the file is consistent).
 */
export function checkDrift(text, root) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const read = (path) => readFileSync(join(root, path), "utf8");

  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    fail(`skill.md is ${Buffer.byteLength(text, "utf8")} bytes; the limit is ${MAX_BYTES}`);
  }
  const front = parseFrontMatter(text);
  if (!front) {
    fail("skill.md has no YAML front matter");
    return errors;
  }
  const { fields, packages, body } = front;
  for (const key of [
    "name",
    "description",
    "guardian-skill-version",
    "date",
    "canonical",
    "check-copy",
  ]) {
    if (!fields[key]) fail(`front matter is missing ${key}`);
  }
  const version = fields["guardian-skill-version"];
  if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`guardian-skill-version ${version} is not x.y.z`);
  }
  if (fields.canonical !== CANONICAL_URL) {
    fail(`canonical is ${fields.canonical}; expected ${CANONICAL_URL}`);
  }
  const checkCopy = `https://raw.githubusercontent.com/Odingard/guardian-sdk/skill-v${version}/skill.md`;
  if (fields["check-copy"] !== checkCopy) {
    fail(`check-copy is ${fields["check-copy"]}; expected ${checkCopy}`);
  }
  if (!body.includes(`guardian-skill-version: ${version}`)) {
    fail("the version check in section 0 does not quote guardian-skill-version");
  }
  if (!body.includes(fields.canonical ?? "\u0000")) {
    fail("the body does not use the canonical URL for the raw download");
  }

  // Front matter pins equal the workspace versions.
  for (const [name, pinned] of Object.entries(packages)) {
    const dir = PACKAGE_DIRS[name];
    if (!dir) {
      fail(`front matter pins ${name}, which is not a workspace package`);
      continue;
    }
    let actual;
    if (name === "odingard-guardian") {
      actual = /^version\s*=\s*"([^"]+)"/m.exec(read(`${dir}/pyproject.toml`))?.[1];
    } else {
      actual = JSON.parse(read(`${dir}/package.json`)).version;
    }
    if (pinned !== actual) {
      fail(`front matter pins ${name} ${pinned}; the workspace has ${actual}`);
    }
  }

  // Every pin in the body equals the front matter.
  for (const match of body.matchAll(/@odingard\/(guardian-[a-z-]+)@([^\s"'`)]+)/g)) {
    const name = `@odingard/${match[1]}`;
    if (!(name in PACKAGE_DIRS)) fail(`body names ${name}, which is not a workspace package`);
    else if (packages[name] !== match[2]) {
      fail(`body pins ${name}@${match[2]}; front matter has ${packages[name]}`);
    }
  }
  for (const match of body.matchAll(/odingard-guardian==([^\s"'`]+)/g)) {
    if (packages["odingard-guardian"] !== match[1]) {
      fail(`body pins odingard-guardian==${match[1]}; front matter has ${packages["odingard-guardian"]}`);
    }
  }
  // An @odingard package without a version is allowed only as an import path.
  body.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/@odingard\/guardian-[a-z-]+(?![a-z-]*[@/])/g)) {
      const isImport = /\bfrom\s+["']@odingard\//.test(line) || /\bimport\s+["']@odingard\//.test(line);
      if (!isImport) fail(`line ${index + 1}: ${match[0]} without a pinned version`);
    }
    if (/\bpip\s+install\b/.test(line) && /odingard/.test(line) && !/==/.test(line)) {
      fail(`line ${index + 1}: pip install without ==`);
    }
  });

  // Forbidden patterns: never in a code block; in prose only outside
  // section 0 when the line forbids them.
  const bySection = sections(body);
  for (const block of codeBlocks(body)) {
    for (const { re, what } of FORBIDDEN) {
      if (re.test(block.code)) fail(`code block at body line ${block.line} contains ${what}`);
    }
  }
  let offset = 0;
  for (const [key, chunk] of Object.entries(bySection)) {
    for (const { line, number } of proseLines(chunk)) {
      for (const { re, what } of FORBIDDEN) {
        if (re.test(line) && key !== "0" && !FORBIDS.test(line)) {
          fail(`body line ${offset + number}: ${what} outside a rule that forbids it`);
        }
      }
    }
    offset += chunk.split("\n").length - 1;
  }
  if (/gac1/.test(text)) fail("contains gac1 (hosted credentials start with gak_)");
  if (/\bcon_/.test(text)) fail("contains con_ (connection ids start with pcn_)");

  // Environment variables are read by some package.
  const sources = Object.values(PACKAGE_DIRS)
    .flatMap((dir) => walk(join(root, dir, "src"), [".ts", ".py"]))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  for (const name of new Set(body.match(/\bGUARDIAN_[A-Z_]+\b/g) ?? [])) {
    if (!sources.includes(name)) fail(`${name} is not read anywhere in packages/*/src`);
  }

  // Hook subcommands and tool names.
  const hookIndex = read("packages/hook/src/index.ts");
  const hookRun = read("packages/hook/src/run.ts");
  const dialects = /export const DIALECTS[^=]*=\s*\[([^\]]*)\]/.exec(hookRun)?.[1] ?? "";
  for (const match of body.matchAll(/guardian-hook(?:@[\d.]+)?\s+(setup|classify|codex|dsh|[a-z][\w-]*)\b/g)) {
    const sub = match[1];
    const handled = hookIndex.includes(`command === "${sub}"`) || dialects.includes(`"${sub}"`);
    if (!handled) fail(`guardian-hook ${sub} is not a subcommand in packages/hook/src/index.ts`);
  }
  const classifySource = read("packages/hook/src/classify.ts");
  const hookTools = /export const HOOK_TOOLS = \[([\s\S]*?)\] as const;/.exec(classifySource)?.[1] ?? "";
  const known = new Set([...hookTools.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]));
  for (const name of HOOK_TOOL_NAMES) {
    if (new RegExp(`\`${name}\``).test(body) && !known.has(name)) {
      fail(`hook tool ${name} is not in HOOK_TOOLS`);
    }
  }
  for (const match of body.matchAll(/`(shell_[a-z_]+|git_[a-z_]+|file_[a-z_]+|web_[a-z_]+)`/g)) {
    if (!known.has(match[1])) fail(`hook tool ${match[1]} is not in HOOK_TOOLS`);
  }

  // Hook matchers match the hook README.
  const hookReadme = read("packages/hook/README.md");
  const claudeMatcher = /"matcher":\s*"([^"]+)"/.exec(bySection["4A"] ?? "")?.[1];
  if (!claudeMatcher) fail("section 4A has no Claude Code matcher");
  else if (!hookReadme.includes(`"matcher": "${claudeMatcher}"`)) {
    fail(`Claude Code matcher ${claudeMatcher} differs from packages/hook/README.md`);
  }
  const codexMatcher = /matcher `([^`]+)`/.exec(bySection["4C"] ?? "")?.[1];
  if (!codexMatcher) fail("section 4C has no Codex matcher");
  else if (!hookReadme.includes(`"matcher": "${codexMatcher}"`)) {
    fail(`Codex matcher ${codexMatcher} differs from packages/hook/README.md`);
  }

  // Status words.
  const rootReadme = read("README.md");
  for (const [key, rows] of Object.entries(STATUS)) {
    const section = (bySection[key] ?? "").toLowerCase();
    if (!section) {
      fail(`section ${key} is missing`);
      continue;
    }
    for (const { row, status, source } of rows) {
      const cell = readmeStatus(rootReadme, row);
      if (source && !read(source).includes(status)) {
        fail(`"${status}" is not in ${source}`);
      }
      if (cell !== status) {
        fail(`README status for ${row} is "${cell}"; the file uses "${status}"`);
      }
      if (!section.includes(status.toLowerCase())) {
        fail(`section ${key} does not state "${status}" for ${row}`);
      }
    }
  }

  // Changelog entry with this file's hash.
  const changelogPath = join(root, "skill/CHANGELOG.md");
  if (!existsSync(changelogPath)) fail("skill/CHANGELOG.md is missing");
  else {
    const changelog = readFileSync(changelogPath, "utf8");
    const entry = new RegExp(`^## ${version?.replace(/\./g, "\\.")}\\b[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "m").exec(changelog)?.[0];
    if (!entry) fail(`skill/CHANGELOG.md has no entry for ${version}`);
    else {
      const sha = createHash("sha256").update(text).digest("hex");
      if (!entry.includes(sha)) {
        fail(`skill/CHANGELOG.md entry ${version} does not record the SHA-256 ${sha}`);
      }
    }
  }

  // Plain CommonMark: no HTML outside code.
  for (const { line, number } of proseLines(body)) {
    const outsideCode = line.replace(/`[^`]*`/g, "");
    if (/<[A-Za-z!/][^>]*>/.test(outsideCode)) fail(`body line ${number}: HTML outside code`);
  }
  return errors;
}

/**
 * The checks that run code: the hook's classification of the test command,
 * and the code blocks. Needs `npm run build` first.
 */
export function checkCode(text, root) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const body = parseFrontMatter(text)?.body ?? text;

  const hookBin = join(root, "packages/hook/dist/index.js");
  if (!existsSync(hookBin)) {
    fail("packages/hook/dist/index.js is missing; run npm run build first");
  } else {
    const classify = (command) =>
      spawnSync(process.execPath, [hookBin, "classify", command], { encoding: "utf8" }).stdout.trim();
    const testCommand = /^rm -r \.\/guardian-ask-test$/m.test(body) ? "rm -r ./guardian-ask-test" : undefined;
    if (!testCommand) fail("section 6 does not contain the test command rm -r ./guardian-ask-test");
    else if (classify(testCommand) !== "shell_destructive") {
      fail(`"${testCommand}" classifies as ${classify(testCommand)}, not shell_destructive`);
    }
    if (classify("ls") !== "shell") fail(`"ls" classifies as ${classify("ls")}, not shell`);
  }

  const blocks = codeBlocks(body);
  const skipped = [];
  const work = mkdtempSync(join(tmpdir(), "guardian-skill-"));
  // TypeScript resolves packages from the workspace, so its scratch folder
  // sits in the repository (git-ignored) and is removed afterwards.
  const tsWork = join(root, ".skill-check");
  try {
    rmSync(tsWork, { recursive: true, force: true });
    mkdirSync(tsWork);
    const tsFiles = [];
    let pythonNames = null;
    blocks.forEach((block, index) => {
      const where = `code block at body line ${block.line} (${block.lang || "no language"})`;
      if (block.lang === "sh") {
        if (/<[^>]+>/.test(block.code)) {
          skipped.push(where);
          return;
        }
        const file = join(work, `block-${index}.sh`);
        writeFileSync(file, `${block.code}\n`);
        const result = spawnSync("sh", ["-n", file], { encoding: "utf8" });
        if (result.status !== 0) fail(`${where}: sh -n failed: ${result.stderr.trim()}`);
      } else if (block.lang === "json") {
        try {
          JSON.parse(block.code);
        } catch (cause) {
          fail(`${where}: not valid JSON: ${cause.message}`);
        }
      } else if (block.lang === "ts" || block.lang === "js") {
        const file = join(tsWork, `block-${index}.${block.lang === "ts" ? "mts" : "mjs"}`);
        writeFileSync(file, `${block.code}\nexport {};\n`);
        tsFiles.push(file);
      } else if (block.lang === "python") {
        const file = join(work, `block_${index}.py`);
        writeFileSync(file, `${block.code}\n`);
        const result = spawnSync("python3", ["-I", "-m", "py_compile", file], { encoding: "utf8" });
        if (result.status !== 0) fail(`${where}: py_compile failed: ${result.stderr.trim()}`);
        if (pythonNames === null) {
          const init = readFileSync(join(root, "packages/python/src/odingard_guardian/__init__.py"), "utf8");
          const all = /__all__\s*=\s*\[([\s\S]*?)\]/.exec(init)?.[1] ?? "";
          pythonNames = new Set([...all.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
        }
        for (const match of block.code.matchAll(/from odingard_guardian import ([^\n]+)/g)) {
          for (const name of match[1].split(",").map((n) => n.trim()).filter(Boolean)) {
            if (!pythonNames.has(name)) fail(`${where}: ${name} is not in odingard_guardian.__all__`);
          }
        }
      } else {
        fail(`${where}: unknown language; use sh, json, ts, js or python`);
      }
    });
    if (tsFiles.length > 0) {
      const tsc = join(root, "node_modules/.bin/tsc");
      const result = spawnSync(
        tsc,
        [
          "--noEmit",
          "--strict",
          "--allowJs",
          "--checkJs",
          "--skipLibCheck",
          "--target", "es2022",
          "--module", "nodenext",
          "--moduleResolution", "nodenext",
          "--types", "node",
          "--typeRoots", join(root, "node_modules/@types"),
          ...tsFiles,
        ],
        { encoding: "utf8", cwd: root },
      );
      if (result.status !== 0) {
        fail(`TypeScript/JavaScript code blocks do not type-check:\n${(result.stdout + result.stderr).trim()}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(tsWork, { recursive: true, force: true });
  }
  return { errors, skipped };
}

// -------------------------------------------------------------------- CLI

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const text = readFileSync(join(root, "skill.md"), "utf8");
  const errors = checkDrift(text, root);
  let skipped = [];
  if (!process.argv.includes("--static")) {
    const code = checkCode(text, root);
    errors.push(...code.errors);
    skipped = code.skipped;
  }
  for (const where of skipped) console.log(`skipped (placeholders): ${where}`);
  if (errors.length > 0) {
    for (const error of errors) console.error(`skill.md: ${error}`);
    process.exit(1);
  }
  console.log(`skill.md: ok (${Buffer.byteLength(text, "utf8")} bytes)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
