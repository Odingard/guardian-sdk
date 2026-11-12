import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The x402 releases this guard was built and tested against: 2.30.x, the
 * same range as the peer dependencies (`~2.30.0`).
 */
export const TESTED_X402_MAJOR = 2;
export const TESTED_X402_MINOR = 30;
export const TESTED_X402_RANGE = "~2.30.0";

const require = createRequire(import.meta.url);
const checked = new Map<string, string>();

function installedVersion(name: string): string | null {
  let dir: string;
  try {
    dir = dirname(require.resolve(name));
  } catch {
    return null;
  }
  for (let i = 0; i < 8; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === name && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** True only for a plain release in the tested range (no prerelease). */
export function isSupportedX402Version(version: string | null | undefined): boolean {
  const parts = typeof version === "string" ? version.match(/^(\d+)\.(\d+)\.(\d+)$/) : null;
  if (!parts) return false;
  return Number(parts[1]) === TESTED_X402_MAJOR && Number(parts[2]) === TESTED_X402_MINOR;
}

/**
 * Refuses an x402 package outside the tested range (another major or minor
 * line, a prerelease, or none installed). Throws; the guard is not built.
 */
export function assertSupportedX402(
  name: string,
  readVersion: (name: string) => string | null = installedVersion,
): string {
  const cached = checked.get(name);
  if (cached && readVersion === installedVersion) return cached;
  const version = readVersion(name);
  if (!isSupportedX402Version(version)) {
    throw new Error(
      `guardian-x402 supports ${name} ${TESTED_X402_RANGE}; found ${version ?? "none"}.`,
    );
  }
  if (readVersion === installedVersion) checked.set(name, version!);
  return version!;
}
