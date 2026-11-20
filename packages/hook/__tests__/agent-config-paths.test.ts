/**
 * A file that sets the agent's own MCP servers, hooks or permissions is
 * routed to the Ask tier however its path is spelled: repeated separators,
 * `.` and `..` segments, backslashes, a relative path, `~`, letter case, or
 * a symbolic link that leads there.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyCommand,
  governedCall,
  isAgentConfigPath,
  tierOf,
} from "../src/classify.js";

const ALIASES = [
  "/work/.claude//settings.json",
  "/work/.claude/./settings.json",
  "/work//.claude///settings.local.json",
  "/work/.claude/tmp/../settings.json",
  "/work/src/../.claude/x/../hooks/pre.sh",
  "/work/.CLAUDE//Settings.json",
  "/work/sub/..//.mcp.json",
  "/work/.claude\\\\settings.json",
  ".claude//settings.json",
  "./.claude/./settings.json",
  "~/.claude//settings.json",
  "/work/.codex/./hooks.json",
  "/work/x/../.cursor//mcp.json",
];

/** One call per file tool the hook knows, for `path`. */
const fileCalls = (path: string): [string, Record<string, unknown>][] => [
  ["Write", { file_path: path, content: "{}" }],
  ["Edit", { file_path: path, old_string: "a", new_string: "b" }],
  ["MultiEdit", { file_path: path, edits: [] }],
  ["NotebookEdit", { notebook_path: path, new_source: "x" }],
  ["write", { file_path: path, content: "{}" }], // DeepSeek Harness
  ["edit", { file_path: path, new_string: "{}" }],
  ["str_replace_editor", { command: "create", path, file_text: "{}" }],
  ["str_replace_editor", { command: "str_replace", path, new_str: "{}" }],
];

describe("another spelling of an agent configuration path", () => {
  describe.each(ALIASES)("%s", (path) => {
    it.each(fileCalls(path))("%s %j → Ask tier", (tool, input) => {
      const call = governedCall({ tool, input, cwd: "/work" })!;
      expect(call.toolName).toBe("shell_destructive");
      expect(tierOf(call.toolName)).toBe("ask");
      expect(call.arguments.touches).toBe("agent-config");
      // Proposed as the agent wrote it.
      expect(call.arguments.path).toBe(path);
    });

    it("apply_patch (Codex and DeepSeek Harness) → Ask tier", () => {
      const patch = `*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: ${path}\n+{}\n*** End Patch`;
      for (const input of [{ command: patch }, { input: patch }]) {
        const call = governedCall({ tool: "apply_patch", input, cwd: "/work" })!;
        expect(call.toolName).toBe("shell_destructive");
        expect(call.arguments.touches).toBe("agent-config");
        expect(call.arguments.paths).toContain(path);
      }
    });
  });

  it("a patch that moves a file onto an alias → Ask tier", () => {
    const patch =
      "*** Begin Patch\n*** Update File: a.json\n*** Move to: .claude/./settings.json\n*** End Patch";
    const call = governedCall({
      tool: "apply_patch",
      input: { command: patch },
    })!;
    expect(call.toolName).toBe("shell_destructive");
  });

  it("ordinary paths stay on file_write, also with odd spellings", () => {
    for (const path of [
      "/work/src//a.ts",
      "/work/src/./a.ts",
      "/work/a/../b.json",
      "/work/claude/settings.json",
      "/work/.claude/worktrees/x/src/a.ts",
    ]) {
      for (const [tool, input] of fileCalls(path)) {
        const call = governedCall({ tool, input, cwd: "/work" })!;
        expect(call.toolName, `${tool} ${path}`).toBe("file_write");
      }
    }
  });

  it("a path that cannot be resolved goes to the Ask tier", () => {
    const call = governedCall({
      tool: "Write",
      input: { file_path: "/work/a\0b.json", content: "{}" },
      cwd: "/work",
    })!;
    expect(call.toolName).toBe("shell_destructive");
    expect(isAgentConfigPath("/work/a\0b.json")).toBe(true);
  });
});

describe("a symbolic link that leads to agent configuration", () => {
  const work = join(mkdtempSync(join(tmpdir(), "guardian-hook-")), "work");
  mkdirSync(join(work, ".claude"), { recursive: true });
  writeFileSync(join(work, ".claude", "settings.json"), "{}");
  // The file itself is a link; a folder on the way is a link.
  symlinkSync(join(work, ".claude", "settings.json"), join(work, "innocent.json"));
  symlinkSync(join(work, ".claude"), join(work, "notes"), "dir");
  // A link whose target does not exist yet.
  symlinkSync(join(work, ".mcp.json"), join(work, "later.json"));
  // A link that loops.
  symlinkSync(join(work, "loop-b"), join(work, "loop-a"));
  symlinkSync(join(work, "loop-a"), join(work, "loop-b"));

  // `deep/..` is `.claude/hooks`, not `work`, once the link is followed.
  mkdirSync(join(work, ".claude", "hooks", "sub"), { recursive: true });
  symlinkSync(join(work, ".claude", "hooks", "sub"), join(work, "deep"), "dir");

  it.each([
    join(work, "deep") + "/../pre.sh",
    join(work, "innocent.json"),
    join(work, "notes", "settings.json"),
    join(work, "notes", "settings.local.json"), // does not exist yet
    join(work, "later.json"),
    join(work, "loop-a", "x.json"), // cannot be resolved
    "notes/settings.json", // relative to the hook input's cwd
    "./innocent.json",
  ])("%s → Ask tier", (path) => {
    for (const [tool, input] of fileCalls(path)) {
      const call = governedCall({ tool, input, cwd: work })!;
      expect(call.toolName, tool).toBe("shell_destructive");
      expect(call.arguments.path).toBe(path);
    }
    const patch = `*** Begin Patch\n*** Update File: ${path}\n*** End Patch`;
    expect(
      governedCall({ tool: "apply_patch", input: { command: patch }, cwd: work })!
        .toolName,
    ).toBe("shell_destructive");
  });

  it("a plain file next to them stays on file_write", () => {
    const call = governedCall({
      tool: "Write",
      input: { file_path: join(work, "a.json"), content: "{}" },
      cwd: work,
    })!;
    expect(call.toolName).toBe("file_write");
  });
});

describe("a command word that is another spelling of agent configuration", () => {
  it.each([
    "echo '{}' > .claude//settings.json",
    "echo '{}' >> .claude/./settings.local.json",
    "cp x.json /work/.claude/./settings.json",
    "tee .claude/tmp/../settings.json < x",
    "cat x > '.claude//settings.local.json'",
    "cp x ./sub/..//.mcp.json",
    "sudoedit .claude//settings.json",
    "sed -i s/a/b/ src/../.claude/x/../hooks/pre.sh",
    "git mv a.json .claude//settings.json",
    "find . -fprint .claude/./settings.json",
    "mv a.json .codex/./hooks.json",
  ])("%s → shell_destructive", (command) => {
    expect(classifyCommand(command)).toBe("shell_destructive");
    expect(governedCall({ tool: "Bash", input: { command } })!.toolName).toBe(
      "shell_destructive",
    );
    expect(governedCall({ tool: "bash", input: { command } })!.toolName).toBe(
      "shell_destructive",
    );
  });

  it("ordinary commands with odd path spellings stay on shell", () => {
    for (const command of [
      "cp src//a.ts dst/./a.ts",
      "echo hi > out/../log.txt",
      "ls ./src/../test",
    ]) {
      expect(classifyCommand(command), command).toBe("shell");
    }
  });
});
