import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isUnderPreviewRoots } from "../content-pins.js";
import {
  CONTENT_PIN_KEY,
  contentPreview,
  createGuard,
  normalizeFileArgPreviewRoots,
  normalizeFileArgPreviews,
  normalizeFileArgsSpec,
  type GuardianClient,
  type GuardianInvocation,
} from "../index.js";

/**
 * The opt-in file preview of a content pin. The golden file is shared with
 * the Python SDK (packages/python/tests/fixtures/content-preview.json,
 * written by `npm run fixtures:python`); this test fails when the
 * TypeScript output drifts from it, so the Python check stays meaningful.
 */

type GoldenCase = {
  case: string;
  name: string;
  base64: string;
  preview: unknown;
};

const golden = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../../../python/tests/fixtures/content-preview.json",
    ),
    "utf8",
  ),
) as GoldenCase[];

describe("contentPreview matches the shared golden file", () => {
  it("has cases", () => {
    expect(golden.length).toBeGreaterThan(30);
  });
  for (const c of golden) {
    it(c.case, () => {
      const bytes = new Uint8Array(Buffer.from(c.base64, "base64"));
      expect(contentPreview(c.name, bytes)).toEqual(c.preview);
    });
  }
});

type DeclarationCase = {
  case: string;
  declaration: unknown;
  spec?: unknown;
  preview?: unknown;
  previewRoots?: unknown;
  error?: string;
};

const declarationsGolden = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../../../python/tests/fixtures/file-arg-declarations.json",
    ),
    "utf8",
  ),
) as {
  declarations: DeclarationCase[];
  under: { path: string; roots: string[]; under: boolean }[];
};

describe("file argument declarations match the shared golden file", () => {
  for (const c of declarationsGolden.declarations) {
    it(c.case, () => {
      if (c.error !== undefined) {
        expect(() => normalizeFileArgsSpec("send_report", c.declaration)).toThrow(
          expect.objectContaining({ reasonCode: c.error }),
        );
        return;
      }
      expect(normalizeFileArgsSpec("send_report", c.declaration) ?? null).toEqual(
        c.spec,
      );
      expect(normalizeFileArgPreviews("send_report", c.declaration)).toEqual(
        c.preview,
      );
      expect(normalizeFileArgPreviewRoots("send_report", c.declaration)).toEqual(
        c.previewRoots,
      );
    });
  }
  for (const c of declarationsGolden.under) {
    it(`${c.path} in ${c.roots.join(",") || "no folders"}`, () => {
      expect(isUnderPreviewRoots(c.path, c.roots)).toBe(c.under);
    });
  }
});

describe("a declared preview rides inside the pin", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "guardian-preview-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function client(sent: GuardianInvocation[]): GuardianClient {
    return {
      async request(invocation) {
        sent.push(invocation);
        return {
          ok: true,
          requestId: "req_preview",
          decision: "DENY",
          reasonCode: "POLICY_DENY",
        };
      },
      async claim() {
        return { ok: false, reasonCode: "UNUSED" };
      },
      async execute() {
        return { ok: false, reasonCode: "UNUSED" };
      },
      async portableReceipt() {
        return { ok: false, reasonCode: "UNUSED" };
      },
      async receipts() {
        return { ok: false, reasonCode: "UNUSED" };
      },
    };
  }

  it("only with preview: true; the short form sends none", async () => {
    const path = join(dir, "q3.csv");
    await writeFile(path, "region,total\nnorth,120\n");
    const pinsFor = async (declaration: unknown) => {
      const sent: GuardianInvocation[] = [];
      await createGuard({
        client: client(sent),
        connectionId: "pcn_0123456789abcdef0123456789abcdef",
        onDeny: "result",
        fileArgs: { send_report: declaration as never },
      })("send_report", () => "never")({ attachmentPath: path });
      const args = (sent[0] as { arguments?: Record<string, unknown> })
        .arguments;
      return args?.[CONTENT_PIN_KEY] as Record<string, unknown>[];
    };
    const opted = await pinsFor({
      attachmentPath: { mode: "bytes", preview: true },
    });
    expect(opted[0]?.preview).toEqual({
      kind: "text",
      mediaType: "text/csv",
      size: 23,
      text: "region,total\nnorth,120\n",
      truncated: false,
    });
    const short = await pinsFor(["attachmentPath"]);
    expect(short[0]).not.toHaveProperty("preview");
    expect({ ...opted[0], preview: undefined }).toEqual({
      ...short[0],
      preview: undefined,
    });
  });

  it("with previewRoots, a file outside the folders is withheld: no content is sent", async () => {
    const reports = join(dir, "reports");
    await mkdir(reports);
    const inside = join(reports, "q3.csv");
    await writeFile(inside, "region,total\n");
    const secret = join(dir, "credentials");
    await writeFile(secret, "aws_secret_access_key=top-secret-value\n");
    const send = async (path: string) => {
      const sent: GuardianInvocation[] = [];
      await createGuard({
        client: client(sent),
        connectionId: "pcn_0123456789abcdef0123456789abcdef",
        onDeny: "result",
        fileArgs: {
          send_report: {
            attachmentPath: { preview: true, previewRoots: [reports] },
          },
        },
      })("send_report", () => "never")({ attachmentPath: path });
      return sent[0]!;
    };
    const shown = await send(inside);
    const pinsOf = (sent: GuardianInvocation) =>
      (sent as { arguments?: Record<string, unknown> }).arguments?.[
        CONTENT_PIN_KEY
      ] as Record<string, unknown>[];
    expect(pinsOf(shown)[0]?.preview).toMatchObject({
      kind: "text",
      text: "region,total\n",
    });
    const withheld = await send(secret);
    expect(pinsOf(withheld)[0]?.preview).toEqual({ kind: "withheld", size: 39 });
    expect(JSON.stringify(withheld)).not.toContain("top-secret");
  });
});
