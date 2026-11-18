#!/usr/bin/env node
// Checks the type output of @odingard/guardian-sdk as a consumer sees it:
// packs packages/sdk (build it first), installs the tarball into a temporary
// TypeScript 5.x project and type-checks an import of each entry point with
// `skipLibCheck: false`, for NodeNext, Node16 and Bundler resolution.
//
//   npm run build && node scripts/check-sdk-types.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import console from "node:console";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TYPESCRIPT = "typescript@5.9.3";
const TYPES_NODE = "@types/node@22";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "guardian-sdk-types-"));

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(r.stdout + r.stderr);
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
  }
  return r.stdout;
}

const CONFIGS = [
  { module: "NodeNext", moduleResolution: "NodeNext" },
  { module: "Node16", moduleResolution: "Node16" },
  { module: "ESNext", moduleResolution: "Bundler" },
];

try {
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--json", "--silent", "--pack-destination", work],
      join(root, "packages/sdk"),
    ),
  );
  const tarball = join(work, packed[0].filename);

  const project = join(work, "consumer");
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", tarball, TYPESCRIPT, TYPES_NODE],
    project,
  );
  writeFileSync(
    join(project, "index.ts"),
    [
      'import * as sdk from "@odingard/guardian-sdk";',
      'import * as contracts from "@odingard/guardian-sdk/contracts";',
      'import type { GuardianPublicCatalog } from "@odingard/guardian-sdk";',
      "const catalog: GuardianPublicCatalog = sdk.guardianCatalog;",
      "export const used = [sdk, contracts, catalog.verticals.length];",
      "",
    ].join("\n"),
  );

  const tsc = join(project, "node_modules/typescript/bin/tsc");
  let failed = false;
  for (const config of CONFIGS) {
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          ...config,
          target: "ES2022",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
        },
        files: ["index.ts"],
      }),
    );
    const r = spawnSync(process.execPath, [tsc, "-p", "."], {
      cwd: project,
      encoding: "utf8",
    });
    const label = `${config.module}/${config.moduleResolution}`;
    if (r.status === 0) {
      console.log(`ok    ${label}`);
    } else {
      failed = true;
      console.log(`FAIL  ${label}\n${r.stdout}${r.stderr}`);
    }
  }
  if (failed) {
    console.error(`@odingard/guardian-sdk types do not check with ${TYPESCRIPT}`);
    process.exitCode = 1;
  } else {
    console.log(`@odingard/guardian-sdk types check with ${TYPESCRIPT}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
