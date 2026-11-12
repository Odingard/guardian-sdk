// CI check: no fixture names Base mainnet outside the refusal tests and the
// mainnet-enabled fake-signer test, and that test asserts no RPC or
// facilitator call is made.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const MAINNET = ["eip155", "8453"].join(":");
// Each pattern is built from parts so this file does not match itself.
const MAINNET_PATTERNS = [
  new RegExp(`${MAINNET}(?!\\d)`),
  new RegExp(`\\b${["BASE", "MAINNET"].join("_")}\\b`),
  new RegExp(["0x833589fcd6edb6e08f4c7c32d4", "f71b54bda02913"].join(""), "i"),
  // a v1 network name of "base" (it maps to Base mainnet)
  new RegExp(`["']?network["']?\\s*:\\s*["']${"base"}["']`, "i"),
  // chain id 8453 (decimal or 0x2105) named as a chain id
  new RegExp(`chain_?id["']?\\s*[:=]\\s*["']?(?:${"84"}53|0x${"21"}05)(?![0-9a-f])`, "i"),
];
const namesMainnet = (text: string) => MAINNET_PATTERNS.some((p) => p.test(text));
const ALLOWED = new Set(["refusals.test.ts", "mainnet.test.ts"]);
const roots = [here, join(here, "..", "..", "..", "examples", "x402")];

function files(dir: string): string[] {
  let out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(files(p));
    else if (/\.(m?[jt]s|json)$/.test(name)) out.push(p);
  }
  return out;
}

describe("Base mainnet fixtures", () => {
  it("appear only in the refusal tests and the mainnet fake-signer test", () => {
    const offenders = roots
      .flatMap(files)
      .filter((f) => !(dirname(f) === here && ALLOWED.has(f.slice(here.length + 1))))
      .filter((f) => namesMainnet(readFileSync(f, "utf8")))
      .map((f) => relative(join(here, ".."), f));
    expect(offenders).toEqual([]);
  });

  it("the check catches each way a fixture can name Base mainnet", () => {
    const parts = {
      caip: ["eip155", "8453"].join(":"),
      constant: ["BASE", "MAINNET"].join("_"),
      asset: ["0x833589fCD6eDb6E08f4c7C32D4", "f71b54bdA02913"].join(""),
      v1: ["network: ", '"', "base", '"'].join(""),
    };
    expect(namesMainnet(`{ network: "${parts.caip}" }`)).toBe(true);
    expect(namesMainnet(`import { ${parts.constant} } from "x";`)).toBe(true);
    expect(namesMainnet(`asset: "${parts.asset}"`)).toBe(true);
    expect(namesMainnet(`asset: "${parts.asset.toLowerCase()}"`)).toBe(true);
    expect(namesMainnet(`{ ${parts.v1} }`)).toBe(true);
    expect(namesMainnet(`{ "network": ${JSON.stringify(["ba", "se"].join(""))} }`)).toBe(true);
    expect(namesMainnet(`{ NETWORK: "${["BA", "SE"].join("")}" }`)).toBe(true);
    expect(namesMainnet(`{ chainId: ${["84", "53"].join("")} }`)).toBe(true);
    expect(namesMainnet(`{ "chain_id": "${["84", "53"].join("")}" }`)).toBe(true);
    expect(namesMainnet(`{ chainId: 0x${["21", "05"].join("")} }`)).toBe(true);
    expect(namesMainnet(`{ network: "base-sepolia", chain: "eip155:84532", chainId: 84532 }`)).toBe(false);
  });

  it("the mainnet-enabled test asserts that no RPC or facilitator call is made", () => {
    const src = readFileSync(join(here, "mainnet.test.ts"), "utf8");
    expect(src).toContain("no RPC or facilitator call is made");
    expect(src).toMatch(/expect\(s\.seen\.map/);
    expect(src).toMatch(/expect\(s\.paid\)\.toHaveLength\(0\)/);
  });
});
