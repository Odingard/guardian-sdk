/**
 * Golden cross-language fixtures for the file preview of a content pin.
 *
 *   npm run fixtures:python   (from the repo root)
 *
 * Writes tests/fixtures/content-preview.json: each case is a file name and
 * its bytes (base64) with the preview the TypeScript `contentPreview`
 * returns. The Python `content_preview` must return the same, and the
 * TypeScript test checks the file still matches the TypeScript output.
 *
 * Also writes tests/fixtures/file-arg-declarations.json: declarations of
 * one tool's file arguments with what the TypeScript parser makes of them
 * (the mode per argument, the arguments with a preview and their
 * previewRoots) or the code it refuses them with, and resolved paths
 * checked against preview folders. The Python parser must agree.
 */
import { writeFileSync } from "node:fs";

import {
  ContentPinError,
  contentPreview,
  isUnderPreviewRoots,
  normalizeFileArgPreviewRoots,
  normalizeFileArgPreviews,
  normalizeFileArgsSpec,
} from "../../sdk/src/content-pins.js";

const here = new URL(".", import.meta.url);
const enc = new TextEncoder();
const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

const cases: [string, string, Uint8Array][] = [
  ["short csv", "q3.csv", enc.encode("region,total\nnorth,120\n")],
  ["empty file", "empty.txt", new Uint8Array()],
  ["30 lines", "app.log", enc.encode(lines(30))],
  ["exactly 20 lines", "a.txt", enc.encode(`${lines(20)}\n`)],
  ["20 lines without a final newline", "a.txt", enc.encode(lines(20))],
  ["21 lines, last one empty", "a.txt", enc.encode(`${lines(20)}\n\n`)],
  ["2048 ascii bytes", "x.txt", enc.encode("x".repeat(2048))],
  ["2049 ascii bytes", "x.txt", enc.encode("x".repeat(2049))],
  ["3-byte characters over the cap", "notes.md", enc.encode("€".repeat(1000))],
  ["4-byte characters over the cap", "e.txt", enc.encode("😀".repeat(600))],
  ["2-byte characters", "fr.txt", enc.encode("é".repeat(1500))],
  ["CRLF and a byte-order mark", "w.csv", enc.encode("﻿a,b\r\n1,2\r\n")],
  ["a lone CR", "cr.txt", enc.encode("a\rb\n")],
  ["CRLF on line 20", "a.txt", enc.encode(`${lines(20).replace(/\n/g, "\r\n")}\r\nmore`)],
  [
    "controls",
    "a.txt",
    enc.encode("a\tb\nc\u0007d\u001b[31me\u007ff\u0085g\u0000".slice(0, -1) + "h"),
  ],
  [
    "bidi and zero-width",
    "a.txt",
    enc.encode(
      "pay ‮exe.fdp‬ to ⁦evil⁩ ok​‌‍⁠﻿" +
        "‎‏‪‫‭⁧⁨  ؜᠎⁡⁤",
    ),
  ],
  ["replacements count toward the cap", "a.txt", enc.encode("\u0007".repeat(1000))],
  ["markup is text", "a.html", enc.encode("<b>Approve</b> [Deny](x) <script>1</script>")],
  ["NUL byte", "a.txt", enc.encode("abc\u0000def")],
  ["latin-1", "a.csv", new Uint8Array([0x63, 0x61, 0x66, 0xe9])],
  ["lone continuation byte", "a.csv", new Uint8Array([0x80])],
  ["overlong", "a.csv", new Uint8Array([0xc0, 0xaf])],
  ["surrogate", "a.csv", new Uint8Array([0xed, 0xa0, 0x80])],
  ["truncated sequence", "a.csv", new Uint8Array([0x61, 0xe2, 0x82])],
  ["above U+10FFFF", "a.csv", new Uint8Array([0xf4, 0x90, 0x80, 0x80])],
  ["pdf of ascii bytes", "r.pdf", enc.encode("%PDF-1.7 plain ascii")],
  ["png", "p.PNG", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["docx", "d.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
  ["zip", "a.zip", new Uint8Array([0x50, 0x4b, 0x05, 0x06])],
  ["uppercase json", "A.JSON", enc.encode('{"a":1}\n')],
  ["yaml", "c.yml", enc.encode("a: 1\n")],
  ["python", "s.py", enc.encode("print(1)\n")],
  ["no extension", "README", enc.encode("hello\n")],
  ["dotfile", ".env", enc.encode("A=1\n")],
  ["trailing dot", "file.", enc.encode("x\n")],
  ["unknown extension", "data.qqq", enc.encode("text\n")],
  ["unknown extension, binary", "data.qqq", new Uint8Array([0xff, 0xfe, 0x00])],
];

const out = cases.map(([caseName, name, bytes]) => ({
  case: caseName,
  name,
  base64: Buffer.from(bytes).toString("base64"),
  preview: contentPreview(name, bytes),
}));
writeFileSync(
  new URL("../tests/fixtures/content-preview.json", here),
  JSON.stringify(out, null, 1) + "\n",
);
console.log(`content-preview: ${out.length} cases`);

const declarations: [string, unknown][] = [
  ["list of names", ["attachmentPath", "cover"]],
  ["true for a mode", { attachmentPath: true }],
  ["explicit modes", { a: "bytes", b: "copy", c: "recheck" }],
  ["object form, no mode", { attachmentPath: { preview: true } }],
  ["object form, mode only", { attachmentPath: { mode: "copy" } }],
  ["object form, preview false", { attachmentPath: { mode: "bytes", preview: false } }],
  ["object form with a preview", { attachmentPath: { mode: "recheck", preview: true } }],
  [
    "previewRoots normalized and sorted",
    { attachmentPath: { preview: true, previewRoots: ["/srv//reports/", "/data", "/data/", "/"] } },
  ],
  ["two arguments, one with folders", { a: { preview: true }, b: { preview: true, previewRoots: ["/x"] } }],
  ["empty object", {}],
  ["empty list", []],
  ["mode null", { attachmentPath: { mode: null, preview: true } }],
  ["mode null alone", { attachmentPath: { mode: null } }],
  ["preview null", { attachmentPath: { preview: null } }],
  ["preview a string", { attachmentPath: { preview: "yes" } }],
  ["preview a number", { attachmentPath: { preview: 1 } }],
  ["unknown mode", { attachmentPath: { mode: "stream", preview: true } }],
  ["mode true", { attachmentPath: { mode: true } }],
  ["unknown key", { attachmentPath: { preview: true, lines: 40 } }],
  ["false for a mode", { attachmentPath: false }],
  ["null for a mode", { attachmentPath: null }],
  ["a list for a mode", { attachmentPath: [true] }],
  ["previewRoots without preview", { attachmentPath: { previewRoots: ["/srv"] } }],
  ["previewRoots with preview false", { attachmentPath: { preview: false, previewRoots: ["/srv"] } }],
  ["previewRoots null", { attachmentPath: { preview: true, previewRoots: null } }],
  ["previewRoots empty", { attachmentPath: { preview: true, previewRoots: [] } }],
  ["previewRoots a string", { attachmentPath: { preview: true, previewRoots: "/srv" } }],
  ["previewRoots relative", { attachmentPath: { preview: true, previewRoots: ["srv"] } }],
  ["previewRoots with ..", { attachmentPath: { preview: true, previewRoots: ["/srv/../etc"] } }],
  ["previewRoots with .", { attachmentPath: { preview: true, previewRoots: ["/srv/./a"] } }],
  ["previewRoots a number", { attachmentPath: { preview: true, previewRoots: [7] } }],
  ["previewRoots with NUL", { attachmentPath: { preview: true, previewRoots: ["/a\u0000b"] } }],
  [
    "17 previewRoots",
    { attachmentPath: { preview: true, previewRoots: Array.from({ length: 17 }, (_, i) => `/r${i}`) } },
  ],
  ["16 previewRoots", { attachmentPath: { preview: true, previewRoots: Array.from({ length: 16 }, (_, i) => `/r${i}`) } }],
  ["dotted name", { "a.b": true }],
  ["reserved name", { guardianContentPins: true }],
  ["empty name", { "": true }],
  ["repeated name in a list", ["a", "a"]],
  ["not a string in a list", ["a", 1]],
  ["a string", "attachmentPath"],
  ["a number", 3],
  // (null is left out: TypeScript refuses it, while Python reads None as
  // "no declaration", the idiomatic default of file_args.)
];

const parsed = declarations.map(([caseName, declaration]) => {
  try {
    return {
      case: caseName,
      declaration,
      spec: normalizeFileArgsSpec("send_report", declaration) ?? null,
      preview: normalizeFileArgPreviews("send_report", declaration),
      previewRoots: normalizeFileArgPreviewRoots("send_report", declaration),
    };
  } catch (err) {
    if (!(err instanceof ContentPinError)) throw err;
    return { case: caseName, declaration, error: err.reasonCode };
  }
});

const under: [string, string[], boolean?][] = [
  ["/srv/reports/q3.csv", ["/srv/reports"]],
  ["/srv/reports", ["/srv/reports"]],
  ["/srv/reports-old/q3.csv", ["/srv/reports"]],
  ["/srv/report", ["/srv/reports"]],
  ["/home/dev/.aws/credentials", ["/srv/reports"]],
  ["/home/dev/.aws/credentials", ["/"]],
  ["/a/b/c", ["/x", "/a/b"]],
  ["/a/b/c", []],
];

writeFileSync(
  new URL("../tests/fixtures/file-arg-declarations.json", here),
  JSON.stringify(
    {
      declarations: parsed,
      under: under.map(([path, roots]) => ({
        path,
        roots,
        under: isUnderPreviewRoots(path, roots),
      })),
    },
    null,
    1,
  ) + "\n",
);
console.log(`file-arg-declarations: ${parsed.length} cases`);
