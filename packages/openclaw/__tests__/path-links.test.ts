/**
 * A write through a symbolic link that leads into OpenClaw's config, state
 * or plugins is governed like a write to the file it leads to. Other
 * spellings of such a path (repeated separators, `.` and `..` segments,
 * backslashes, letter case) are too.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { governOpenClawCall } from "../src/classify.js";

const base = mkdtempSync(join(tmpdir(), "guardian-oc-"));
const state = join(base, "state");
const workspace = join(state, "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(state, "openclaw.json"), "{}");
// The file itself is a link; a folder on the way is a link.
symlinkSync(join(state, "openclaw.json"), join(workspace, "innocent.json"));
symlinkSync(state, join(workspace, "notes"), "dir");
// A link whose target does not exist yet, and a link that loops.
symlinkSync(join(state, "extensions", "x.js"), join(workspace, "later.js"));
symlinkSync(join(workspace, "loop-b"), join(workspace, "loop-a"));
symlinkSync(join(workspace, "loop-a"), join(workspace, "loop-b"));
// The state directory reached through a link, as a second control root would be.
symlinkSync(state, join(base, "alias"), "dir");

const roots = [state];

const routes = (path: string): (string | undefined)[] => [
  governOpenClawCall({
    toolName: "write",
    params: { path, content: "{}" },
    controlRoots: roots,
  })?.toolName,
  governOpenClawCall({
    toolName: "edit",
    params: { path, oldText: "a", newText: "b" },
    controlRoots: roots,
  })?.toolName,
  governOpenClawCall({
    toolName: "apply_patch",
    params: {
      input: `*** Begin Patch\n*** Update File: ${path}\n*** End Patch`,
    },
    controlRoots: roots,
  })?.toolName,
];

describe("paths that lead into OpenClaw's control plane", () => {
  it.each([
    join(workspace, "innocent.json"),
    join(workspace, "notes", "data.bin"),
    join(workspace, "notes", "extensions", "new.js"),
    join(workspace, "later.js"),
    join(workspace, "loop-a", "x.json"),
    join(base, "alias", "data.bin"),
  ])("through a symbolic link: %s → Ask tier", (path) => {
    expect(routes(path)).toEqual([
      "shell_destructive",
      "shell_destructive",
      "shell_destructive",
    ]);
  });

  it.each([
    `${state}//openclaw.json`,
    `${state}/./openclaw.json`,
    `${state}/workspace/../openclaw.json`,
    `${state}/workspace//..//data.bin`,
    `${state.toUpperCase()}/data.bin`,
    `${state}\\openclaw.json`,
  ])("another spelling: %s → Ask tier", (path) => {
    expect(routes(path)).toEqual([
      "shell_destructive",
      "shell_destructive",
      "shell_destructive",
    ]);
  });

  it("a relative link target is taken from the link's real folder", () => {
    // workspace/d → <state>/extensions/x; workspace/d/f → ../../data.bin,
    // which is <state>/data.bin, not a file in the workspace.
    mkdirSync(join(state, "extensions", "x"), { recursive: true });
    symlinkSync(join(state, "extensions", "x"), join(workspace, "d"), "dir");
    symlinkSync("../../data.bin", join(workspace, "d", "f"));
    symlinkSync("f", join(workspace, "d", "f0"));
    const base2 = mkdtempSync(join(tmpdir(), "guardian-oc-"));
    const plain = join(base2, "plain");
    mkdirSync(join(plain, "a", "b"), { recursive: true });
    symlinkSync(join(state, "workspace", "d"), join(plain, "in"), "dir");
    for (const path of [
      join(workspace, "d", "f"),
      join(workspace, "d", "f0"),
      join(plain, "in", "f"),
    ]) {
      expect(routes(path), path).toEqual([
        "shell_destructive",
        "shell_destructive",
        "shell_destructive",
      ]);
    }
    // On disk: the write goes to the state directory.
    writeFileSync(join(plain, "in", "f"), "x");
    expect(existsSync(join(state, "data.bin"))).toBe(true);
  });

  it.skipIf(process.platform === "win32").each([
    ["at the start", "\\s"],
    ["in the middle", "m\\n"],
    ["at the end", "x\\"],
    ["repeated at the end", "y\\\\"],
    ["as the whole name", "\\"],
  ])("a link whose name has a backslash %s → Ask tier", (_where, name) => {
    // On POSIX a backslash is an ordinary character in a file name.
    const out = mkdtempSync(join(tmpdir(), "guardian-oc-"));
    symlinkSync(join(state, "data.bin"), join(out, name));
    expect(routes(join(out, name))).toEqual([
      "shell_destructive",
      "shell_destructive",
      "shell_destructive",
    ]);
    symlinkSync(state, join(out, `dir${name}`), "dir");
    expect(routes(join(out, `dir${name}`, "data2.bin"))).toEqual([
      "shell_destructive",
      "shell_destructive",
      "shell_destructive",
    ]);
  });

  it("the path is proposed as the agent wrote it", () => {
    const path = join(workspace, "innocent.json");
    const call = governOpenClawCall({
      toolName: "write",
      params: { path, content: "{}" },
      controlRoots: roots,
    })!;
    expect(call.arguments.path).toBe(path);
  });

  it("an ordinary workspace file stays on file_write", () => {
    writeFileSync(join(workspace, "a.json"), "{}");
    symlinkSync(join(workspace, "a.json"), join(workspace, "a-link.json"));
    for (const path of [
      join(workspace, "a.json"),
      join(workspace, "a-link.json"),
      join(workspace, "new", "b.json"),
      "src/a.ts",
    ]) {
      expect(routes(path), path).toEqual([
        "file_write",
        "file_write",
        "file_write",
      ]);
    }
  });
});
