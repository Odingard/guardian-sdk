import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_BASE_URL, runCli, USAGE } from "../cli.js";

const fixtures = join(import.meta.dirname, "fixtures");
const receiptText = readFileSync(
  join(fixtures, "staging-receipt.json"),
  "utf8",
);
const keysText = readFileSync(join(fixtures, "staging-keys.json"), "utf8");
const receipt = JSON.parse(receiptText) as {
  receiptId: string;
  decision: { decision: string };
  proof: { keyId: string };
};

function io(files: Record<string, string>, fetch?: typeof globalThis.fetch) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
      readFile: (path: string) => {
        if (!(path in files)) throw new Error("ENOENT");
        return files[path]!;
      },
      ...(fetch ? { fetch } : {}),
    },
  };
}

const offline = async () => {
  throw new Error("no network in an offline verification");
};

describe("guardian-sdk verify", () => {
  it("verifies a receipt offline against a supplied key set", async () => {
    const run = io(
      { "r.json": receiptText, "k.json": keysText },
      offline as never,
    );
    expect(await runCli(["verify", "r.json", "--keys", "k.json"], run.io)).toBe(
      0,
    );
    expect(run.out.join("\n")).toContain(`VALID ${receipt.receiptId}`);
    expect(run.out.join("\n")).toContain("keys:     k.json");
    expect(run.err).toEqual([]);
  });

  it("accepts an API answer that wraps the receipt", async () => {
    const wrapped = JSON.stringify({
      ok: true,
      receipt: JSON.parse(receiptText),
    });
    const run = io({ "r.json": wrapped, "k.json": keysText });
    expect(await runCli(["verify", "r.json", "--keys", "k.json"], run.io)).toBe(
      0,
    );
  });

  it("refuses a changed receipt with the verifier's reason code", async () => {
    const changed = JSON.parse(receiptText) as typeof receipt;
    changed.decision.decision =
      changed.decision.decision === "ALLOW" ? "DENY" : "ALLOW";
    const run = io({ "r.json": JSON.stringify(changed), "k.json": keysText });
    expect(
      await runCli(["verify", "r.json", "--keys", "k.json", "--json"], run.io),
    ).toBe(1);
    expect(JSON.parse(run.out[0]!)).toEqual({
      valid: false,
      reasonCode: "SIGNATURE_INVALID",
      keys: "k.json",
    });
  });

  it("refuses a receipt signed by a key that is not in the set", async () => {
    const run = io({
      "r.json": receiptText,
      "k.json": JSON.stringify({ keys: [] }),
    });
    expect(await runCli(["verify", "r.json", "--keys", "k.json"], run.io)).toBe(
      1,
    );
    expect(run.out[0]).toMatch(/^NOT VALID: /);
  });

  it("fetches the published keys for the receipt's key id when no key set is given", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(keysText, { status: 200 });
    }) as typeof globalThis.fetch;
    const run = io({ "r.json": receiptText }, fetch);
    expect(await runCli(["verify", "r.json"], run.io)).toBe(0);
    expect(urls).toEqual([
      `${DEFAULT_BASE_URL}/v1/receipts/verification-keys?kid=${receipt.proof.keyId}`,
    ]);
    const other = io({ "r.json": receiptText }, fetch);
    expect(
      await runCli(
        ["verify", "r.json", "--base-url", "https://guardian.example.com/"],
        other.io,
      ),
    ).toBe(0);
    expect(urls[1]).toBe(
      `https://guardian.example.com/v1/receipts/verification-keys?kid=${receipt.proof.keyId}`,
    );
  });

  it("reports a key download failure as an error, not as a verdict", async () => {
    const fetch = (async () =>
      new Response("{}", { status: 503 })) as typeof globalThis.fetch;
    const run = io({ "r.json": receiptText }, fetch);
    expect(await runCli(["verify", "r.json"], run.io)).toBe(2);
    expect(run.out).toEqual([]);
    expect(run.err[0]).toContain("could not fetch the verification keys");
  });

  it("explains its usage and rejects bad input", async () => {
    const cases: [string[], string][] = [
      [[], USAGE],
      [["verify"], USAGE],
      [["check", "r.json"], USAGE],
      [["verify", "missing.json"], "could not read JSON from missing.json"],
      [["verify", "r.json", "--keys"], "--keys needs a value"],
      [
        ["verify", "r.json", "--base-url", "http://insecure.example"],
        "--base-url must be an https:// URL",
      ],
      [
        [
          "verify",
          "r.json",
          "--keys",
          "k.json",
          "--base-url",
          "https://x.example",
        ],
        "use --keys or --base-url, not both",
      ],
      [["verify", "r.json", "--nope"], "unknown option --nope"],
      [["verify", "r.json", "s.json"], "one receipt file at a time"],
    ];
    for (const [argv, message] of cases) {
      const run = io({ "r.json": receiptText, "k.json": keysText });
      expect(await runCli(argv, run.io)).toBe(2);
      expect(run.err[0]).toContain(message);
    }
  });
});
