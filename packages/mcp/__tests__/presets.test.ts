import { describe, expect, it } from "vitest";

import { parseCli } from "../src/config.js";
import { renderSuggestions, suggestTool } from "../src/presets.js";

const tool = (name: string, annotations?: Record<string, unknown>) => ({
  name,
  inputSchema: { type: "object" },
  ...(annotations ? { annotations } : {}),
});

describe("governed MCP setups: tool suggestions", () => {
  it("trusts the server's own annotations first", () => {
    expect(suggestTool(tool("run", { readOnlyHint: true })).suggestedMode).toBe(
      "allow",
    );
    expect(
      suggestTool(tool("list_files", { destructiveHint: true })).suggestedMode,
    ).toBe("ask");
  });

  it("falls back to the verb, and anything unclear is ask", () => {
    expect(suggestTool(tool("read_file")).suggestedMode).toBe("allow");
    expect(suggestTool(tool("search_issues")).suggestedMode).toBe("allow");
    expect(suggestTool(tool("write_file")).suggestedMode).toBe("ask");
    expect(suggestTool(tool("create_pull_request")).suggestedMode).toBe("ask");
    expect(suggestTool(tool("execute")).suggestedMode).toBe("ask");
  });

  it("flags names Guardian would reject, so every call would be denied", () => {
    expect(suggestTool(tool("createIssue")).governable).toBe(false);
    expect(suggestTool(tool("get-me")).governable).toBe(true);
    const text = renderSuggestions("srv", [
      tool("createIssue"),
      tool("get_me"),
    ]);
    expect(text).toContain("⚠ 1 tool name(s)");
    expect(text).toContain("get_me");
  });

  it("parses `tools` without any Guardian settings", () => {
    const parsed = parseCli(["tools", "--json", "--", "npx", "-y", "srv"], {});
    expect(parsed).toEqual({
      ok: true,
      config: expect.objectContaining({
        mode: {
          kind: "tools",
          command: "npx",
          args: ["-y", "srv"],
          json: true,
        },
      }),
    });
    expect(parseCli(["tools"], {}).ok).toBe(false);
  });
});
