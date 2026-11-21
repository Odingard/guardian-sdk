/**
 * What `guardian init` finds in the current folder (read-only), the
 * install line for it and how to wrap a tool. The install lines and code
 * follow skill.md sections 4F and 4G. No file is changed here.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type Framework =
  | "langchain"
  | "vercel-ai"
  | "openai-agents"
  | "node"
  | "python";

export type Project = Readonly<{
  framework: Framework | null;
  /** A default agent name from the project, if it names itself. */
  name: string | null;
  /** The JavaScript package manager the folder uses. */
  packageManager: "npm" | "pnpm" | "yarn";
}>;

/** Released versions this command installs (checked against the packages). */
export const VERSIONS = Object.freeze({
  "@odingard/guardian-sdk": "0.6.2",
  "@odingard/guardian-langchain": "0.6.0",
  "@odingard/guardian-vercel-ai": "0.6.0",
  "@odingard/guardian-openai-agents": "0.4.0",
  "odingard-guardian": "0.5.0",
});

export const FRAMEWORK_LABELS: Readonly<Record<Framework, string>> =
  Object.freeze({
    langchain: "LangChain (TypeScript)",
    "vercel-ai": "Vercel AI SDK (TypeScript)",
    "openai-agents": "OpenAI Agents SDK (TypeScript)",
    node: "a Node.js project",
    python: "a Python project",
  });

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function dependencyNames(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = manifest[field];
    if (deps !== null && typeof deps === "object" && !Array.isArray(deps)) {
      for (const name of Object.keys(deps)) names.add(name);
    }
  }
  return names;
}

const NAME_MAX = 120;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A usable agent name, or null. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/^@[^/]+\//, "").trim();
  return name.length > 0 && name.length <= NAME_MAX && !CONTROL.test(name)
    ? name
    : null;
}

export function detectProject(dir: string): Project {
  const manifest = readJson(join(dir, "package.json"));
  const packageManager = existsSync(join(dir, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(join(dir, "yarn.lock"))
      ? "yarn"
      : "npm";
  if (manifest !== null) {
    const deps = dependencyNames(manifest);
    const framework: Framework =
      deps.has("@langchain/core") || deps.has("langchain")
        ? "langchain"
        : deps.has("ai")
          ? "vercel-ai"
          : deps.has("@openai/agents")
            ? "openai-agents"
            : "node";
    return {
      framework,
      name: cleanName(manifest.name) ?? cleanName(basename(dir)),
      packageManager,
    };
  }
  const pyproject = join(dir, "pyproject.toml");
  if (existsSync(pyproject) || existsSync(join(dir, "requirements.txt"))) {
    let name: string | null = null;
    try {
      const match = /^\s*name\s*=\s*["']([^"'\n]+)["']/m.exec(
        readFileSync(pyproject, "utf8"),
      );
      name = cleanName(match?.[1]);
    } catch {
      name = null;
    }
    return {
      framework: "python",
      name: name ?? cleanName(basename(dir)),
      packageManager,
    };
  }
  return { framework: null, name: cleanName(basename(dir)), packageManager };
}

/** The packages to install, pinned, for a TypeScript framework. */
export function packagesFor(framework: Framework): readonly string[] {
  const sdk = `@odingard/guardian-sdk@${VERSIONS["@odingard/guardian-sdk"]}`;
  switch (framework) {
    case "langchain":
      return [
        `@odingard/guardian-langchain@${VERSIONS["@odingard/guardian-langchain"]}`,
        sdk,
      ];
    case "vercel-ai":
      return [
        `@odingard/guardian-vercel-ai@${VERSIONS["@odingard/guardian-vercel-ai"]}`,
        sdk,
      ];
    case "openai-agents":
      return [
        `@odingard/guardian-openai-agents@${VERSIONS["@odingard/guardian-openai-agents"]}`,
        sdk,
      ];
    default:
      return [sdk];
  }
}

/** The install command, as a program and its arguments (no shell). */
export function installCommand(project: Project): {
  command: string;
  args: readonly string[];
} | null {
  if (project.framework === null || project.framework === "python") {
    return null;
  }
  const packages = packagesFor(project.framework);
  switch (project.packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["add", "--save-exact", ...packages] };
    case "yarn":
      return { command: "yarn", args: ["add", "--exact", ...packages] };
    default:
      return {
        command: "npm",
        args: ["install", "--save-exact", ...packages],
      };
  }
}

export const PYTHON_INSTALL = `python -m pip install "odingard-guardian==${VERSIONS["odingard-guardian"]}"`;

/** How to wrap one tool, for the framework found. */
export function wrapExample(framework: Framework, toolName: string): string {
  const fn = toolName.replace(/[^A-Za-z0-9]+(.)/g, (_m, c: string) =>
    c.toUpperCase(),
  );
  if (framework === "python") {
    const pyName = toolName.replace(/[^A-Za-z0-9_]/g, "_");
    return [
      "import os",
      "from odingard_guardian import Guard, GuardianClient",
      "",
      "client = GuardianClient(",
      '    credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"],',
      '    base_url=os.environ.get("GUARDIAN_BASE_URL", "https://guardian-api-azure.odingard.com"),',
      ")",
      'guard = Guard(client, connection_id=os.environ["GUARDIAN_CONNECTION_ID"])',
      "",
      `@guard("${toolName}")`,
      `def ${pyName}(**kwargs): ...  # the existing code`,
    ].join("\n");
  }
  const lines = [
    'import { createGuard, createGuardianClient } from "@odingard/guardian-sdk";',
    "const client = createGuardianClient({",
    '  baseUrl: process.env.GUARDIAN_BASE_URL ?? "https://guardian-api-azure.odingard.com",',
    "  credential: process.env.GUARDIAN_AGENT_CREDENTIAL!,",
    "});",
    "const guard = createGuard({ client, connectionId: process.env.GUARDIAN_CONNECTION_ID! });",
    `const ${fn} = guard("${toolName}", async (input) => /* the existing code */ input);`,
  ];
  if (framework === "langchain") {
    lines.push(
      "",
      '// LangChain: guardianTool(tool, { client, connectionId, mode: "inProcess" })',
    );
  } else if (framework === "vercel-ai") {
    lines.push(
      "",
      '// Vercel AI: withGuardian(tools, { client, connectionId, mode: "inProcess" })',
    );
  } else if (framework === "openai-agents") {
    lines.push(
      "",
      "// OpenAI Agents: createGuardianTool({ client, connectionId })",
    );
  }
  return lines.join("\n");
}

// Crockford base32: no I, L, O or U, so the code reads aloud cleanly.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The code shown in the terminal and on the console page: the first 40
 * bits of SHA-256(state) as 8 Crockford base32 characters, `XXXX-XXXX`.
 */
export function matchCode(state: string): string {
  const digest = createHash("sha256").update(state, "utf8").digest();
  let bits = 0;
  for (const byte of digest.subarray(0, 5)) bits = bits * 256 + byte;
  let code = "";
  for (let shift = 35; shift >= 0; shift -= 5) {
    code += CODE_ALPHABET[Math.floor(bits / 2 ** shift) % 32];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
