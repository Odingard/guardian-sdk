import { homedir } from "node:os";

import { describe, expect, it } from "vitest";

import { tierOf } from "../../hook/src/classify.js";
import {
  controlRootsFromEnv,
  governOpenClawCall,
  normalizeOpenClawPath,
  patchPaths,
} from "../src/classify.js";

const name = (toolName: string, params: Record<string, unknown> = {}) =>
  governOpenClawCall({ toolName, params })?.toolName ?? null;

describe("governOpenClawCall (OpenClaw tool ids → Guardian tools)", () => {
  it("routes exec by consequence, with guardian-hook's classifier", () => {
    expect(name("exec", { command: "ls -la" })).toBe("shell");
    expect(name("bash", { command: "npm test" })).toBe("shell");
    expect(name("exec", { command: "terraform apply -auto-approve" })).toBe(
      "shell_deploy",
    );
    expect(name("exec", { command: "rm -rf build" })).toBe("shell_destructive");
    expect(name("exec", { command: "git push origin main" })).toBe("git_push");
  });

  it("sends attempts to read a process environment to the Ask tier", () => {
    expect(name("exec", { command: "cat /proc/1/environ" })).toBe(
      "shell_destructive",
    );
    expect(name("exec", { command: "echo $GUARDIAN_AGENT_CREDENTIAL" })).toBe(
      "shell_destructive",
    );
    expect(name("read", { path: "/proc/self/environ" })).toBe(
      "shell_destructive",
    );
    expect(name("read", { path: "src/index.ts" })).toBeNull();
  });

  it("shows env override names and a digest, never their values", () => {
    const call = governOpenClawCall({
      toolName: "exec",
      params: {
        command: "deploy.sh",
        env: { API_KEY: "sk-secret" },
        workdir: "/w",
      },
    })!;
    expect(JSON.stringify(call)).not.toContain("sk-secret");
    expect(call.arguments).toMatchObject({
      cwd: "/w",
      envKeys: ["API_KEY"],
      envDigest: expect.stringMatching(/^sha256:/),
    });
  });

  it("governs file changes with a digest instead of the content", () => {
    const write = governOpenClawCall({
      toolName: "write",
      params: { path: "a.txt", content: "TOP SECRET BODY" },
    })!;
    expect(write.toolName).toBe("file_write");
    expect(JSON.stringify(write)).not.toContain("TOP SECRET BODY");
    expect(name("edit", { path: "a.txt", oldText: "a", newText: "b" })).toBe(
      "file_write",
    );
    const patch = governOpenClawCall({
      toolName: "apply_patch",
      params: {
        input:
          "*** Begin Patch\n*** Add File: x.txt\n+hi\n*** Delete File: old.txt\n*** End Patch",
      },
    })!;
    expect(patch.toolName).toBe("file_write");
    expect(patch.arguments.files).toEqual([
      { operation: "add", path: "x.txt" },
      { operation: "delete", path: "old.txt" },
    ]);
  });

  it("maps web_fetch and namespaced MCP tools (Composio)", () => {
    expect(name("web_fetch", { url: "https://example.com" })).toBe("web_fetch");
    expect(name("composio__GMAIL_SEND_EMAIL", { to: "a@b.c" })).toBe(
      "mcp.composio.gmail_send_email",
    );
  });

  it("governs process input like a shell command, skips process reads", () => {
    expect(name("process", { action: "poll", sessionId: "s1" })).toBeNull();
    expect(name("process", { action: "log", sessionId: "s1" })).toBeNull();
    expect(
      name("process", { action: "paste", sessionId: "s1", text: "rm -rf /" }),
    ).toBe("shell_destructive");
    expect(name("process", { action: "kill", sessionId: "s1" })).toBe("shell");
    expect(name("process", { action: "something-new" })).toBe(
      "openclaw.process",
    );
  });

  it("skips only the known read-only tools", () => {
    for (const tool of [
      "read",
      "web_search",
      "session_status",
      "tool_search",
    ]) {
      expect(name(tool)).toBeNull();
    }
  });

  it("fails closed: outbound, agent and unknown tools go to the Ask tier", () => {
    for (const [tool, expected] of [
      ["message", "openclaw.message"],
      ["browser", "openclaw.browser"],
      ["sessions_spawn", "openclaw.sessions_spawn"],
      ["gateway", "openclaw.gateway"],
      ["cron", "openclaw.cron"],
      ["code_execution", "openclaw.code_execution"],
      ["tool_call", "openclaw.tool_call"],
      ["Some-Plugin.Tool", "openclaw.some_plugin_tool"],
    ] as const) {
      const toolName = name(tool, { action: "send" })!;
      expect(toolName).toBe(expected);
      expect(tierOf(toolName as never)).toBe("ask");
    }
  });

  it("parses moves in a patch", () => {
    expect(
      patchPaths("*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y"),
    ).toEqual([
      { operation: "update", path: "a.ts" },
      { operation: "move", path: "b.ts" },
    ]);
  });
});

describe("fields Guardian decides on must be strings", () => {
  it("refuses a non-string command, path, url, patch or typed text", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["exec", { command: ["rm", "-rf", "/"] }],
      ["exec", {}],
      ["write", { path: { toString: () => "x" }, content: "y" }],
      ["edit", { oldText: "a", newText: "b" }],
      ["web_fetch", { url: 42 }],
      ["apply_patch", { input: null }],
      ["process", { action: "paste", text: ["rm -rf /"] }],
    ];
    for (const [toolName, params] of bad) {
      expect(() => governOpenClawCall({ toolName, params })).toThrow(
        /must be a string/,
      );
    }
  });
});

describe("process input: Guardian sees the exact bytes OpenClaw writes", () => {
  const proc = (params: Record<string, unknown>) =>
    governOpenClawCall({
      toolName: "process",
      params: { sessionId: "s1", ...params },
    });

  it("send-keys: literal + hex + keys are what is classified", () => {
    const literal = proc({
      action: "send-keys",
      literal: "git push --force origin main\r",
    })!;
    expect(literal.toolName).toBe("shell_destructive");
    expect(literal.arguments.command).toContain("git push --force origin main");

    // "rm -rf /\r" spelled as hex bytes.
    const hex = proc({
      action: "send-keys",
      hex: ["72", "6d", "20", "2d", "72", "66", "20", "2f", "0d"],
    })!;
    expect(hex.toolName).toBe("shell_destructive");
    expect(hex.arguments.command).toContain("rm -rf /");

    const mixed = proc({
      action: "send-keys",
      literal: "vercel deploy",
      hex: ["0x20"],
      keys: ["Enter"],
    })!;
    expect(mixed.arguments.command).toBe("vercel deploy <Enter>");
  });

  it("write classifies data; paste classifies text", () => {
    expect(
      proc({ action: "write", data: "vercel deploy --prod\n" })!.toolName,
    ).toBe("shell_deploy");
    expect(proc({ action: "paste", text: "rm -rf /" })!.toolName).toBe(
      "shell_destructive",
    );
  });

  it("refuses decoy fields the action does not write", () => {
    for (const params of [
      { action: "write", text: "ls", data: "vercel deploy --prod\n" },
      { action: "write", keys: ["Enter"], data: "x" },
      { action: "send-keys", text: "ls", literal: "git push --force\r" },
      { action: "send-keys", data: "ls", hex: ["0d"] },
      { action: "paste", data: "ls", text: "x" },
      { action: "paste", literal: "rm -rf /" },
      { action: "submit", text: "ls" },
      { action: "send-keys", keys: "Enter" },
      { action: "send-keys", hex: [13] },
    ]) {
      expect(() => proc(params), JSON.stringify(params)).toThrow();
    }
  });

  it("is never on the everyday tier, even when a chunk looks harmless", () => {
    // Commands can be split across calls ("git pu" + "sh --force\r").
    for (const params of [
      { action: "write", data: "sh --force\n" },
      { action: "send-keys", literal: "ls\r" },
      { action: "send-keys", keys: ["Enter"] },
      { action: "paste", text: "echo hi" },
      { action: "submit" },
    ]) {
      const call = proc(params)!;
      // "sh --force" now reads as starting a shell (`shell_session`, Ask
      // tier, from guardian-hook); either way it is never Allow.
      expect(
        ["openclaw.process_input", "shell_session"],
        JSON.stringify(params),
      ).toContain(call.toolName);
      expect(tierOf(call.toolName)).toBe("ask");
    }
  });
});

describe("the agent cannot switch Guardian off on the everyday tier", () => {
  const roots = ["/srv/oc-state", "/etc/oc/openclaw-main.json5"];
  const call = (toolName: string, params: Record<string, unknown>) =>
    governOpenClawCall({ toolName, params, controlRoots: roots })!;

  it("OpenClaw CLI and config/state commands go to the Ask tier", () => {
    for (const command of [
      "openclaw plugins disable guardian",
      "openclaw config set plugins.entries.guardian.enabled false",
      "npx openclaw config unset plugins.entries.guardian",
      "/usr/local/bin/openclaw gateway restart",
      "node openclaw.mjs plugins uninstall guardian",
      "sed -i 's/true/false/' /data/.openclaw/openclaw.json",
      "cp /tmp/x.json ~/.openclaw/openclaw.json",
      "rm -rf ~/.openclaw/extensions/guardian",
      "echo '{}' > $OPENCLAW_CONFIG_PATH",
      "cd /data/.openclaw && ls",
      "cat /data/.openclaw/workspace/../openclaw.json",
      "jq . /srv/oc-state/plugins.json",
      "echo x > /etc/oc/openclaw-main.json5",
      "rm -rf node_modules/@odingard/guardian-openclaw",
    ]) {
      const c = call("exec", { command });
      expect(c.toolName, command).toBe("shell_destructive");
      expect(tierOf(c.toolName)).toBe("ask");
    }
  });

  it("write, edit and apply_patch on config/state paths go to the Ask tier", () => {
    for (const path of [
      "/data/.openclaw/openclaw.json",
      "~/.openclaw/openclaw.json",
      "/home/u/.openclaw/extensions/guardian/dist/index.js",
      "../openclaw.json",
      "../extensions/guardian/dist/index.js",
      "/srv/oc-state/openclaw.json",
      "/etc/oc/openclaw-main.json5",
      "/data/.openclaw/workspace/../openclaw.json",
    ]) {
      expect(call("write", { path, content: "{}" }).toolName, path).toBe(
        "shell_destructive",
      );
      expect(
        call("edit", { path, oldText: "true", newText: "false" }).toolName,
        path,
      ).toBe("shell_destructive");
    }
    expect(
      call("apply_patch", {
        input:
          "*** Begin Patch\n*** Update File: /data/.openclaw/openclaw.json\n@@\n-true\n+false\n*** End Patch",
      }).toolName,
    ).toBe("shell_destructive");
    expect(
      call("apply_patch", {
        input:
          "*** Begin Patch\n*** Update File: a.ts\n*** Move to: ../openclaw.json\n*** End Patch",
      }).toolName,
    ).toBe("shell_destructive");
  });

  it("ordinary workspace work stays on the everyday tier", () => {
    expect(
      call("exec", { command: "ls ~/.openclaw/workspace/notes" }).toolName,
    ).toBe("shell");
    expect(call("exec", { command: "npm test" }).toolName).toBe("shell");
    expect(
      call("write", { path: "/data/.openclaw/workspace/a.md", content: "x" })
        .toolName,
    ).toBe("file_write");
    expect(
      call("write", { path: "/srv/oc-state/workspace/a.md", content: "x" })
        .toolName,
    ).toBe("file_write");
    expect(
      call("edit", { path: "src/a.ts", oldText: "a", newText: "b" }).toolName,
    ).toBe("file_write");
  });

  it("paths are matched as OpenClaw resolves them (@, unicode spaces, file://, ~, ..)", () => {
    for (const path of [
      "file:///data/%2Eopenclaw/openclaw%2Ejson",
      "file:///data/.openclaw/openclaw.json",
      "file://localhost/data/%2eopenclaw/extensions/guardian/dist/index.js",
      "file:///srv/oc%2Dstate/plugins.json",
      "file:///data/.openclaw/workspace/%2E%2E/openclaw.json",
      "@/data/.openclaw/openclaw.json",
      "@file:///data/%2Eopenclaw/openclaw%2Ejson",
      "/data/.openclaw/workspace\u00A0/../openclaw.json",
      "/data/.openclaw/workspace x/../../.openclaw/openclaw.json",
      "/data/.openclaw/workspace evil",
      "/data/.openclaw",
      "/srv/./oc-state//x.json",
      "/srv/oc-state/workspace/../../oc-state/x.json",
      "a b/../../openclaw.json",
      "~/.openclaw/extensions/x.js",
    ]) {
      for (const tool of ["write", "edit"]) {
        const c = call(tool, { path, content: "{}" });
        expect(c.toolName, `${tool} ${path}`).toBe("shell_destructive");
        expect(tierOf(c.toolName)).toBe("ask");
      }
      expect(
        call("apply_patch", {
          input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-a\n+b\n*** End Patch`,
        }).toolName,
        `apply_patch ${path}`,
      ).toBe("shell_destructive");
    }
  });

  it("paths Guardian cannot normalise go to the Ask tier", () => {
    for (const path of [
      "file:///data/%2Eopenclaw%2Fopenclaw.json",
      "file://evil-host/data/.openclaw/openclaw.json",
      "file:///data/x%00.json",
      "https://example.com/openclaw.json",
      "smb://host/share/x",
      "/data/x\u0000.json",
      "@",
    ]) {
      const c = call("write", { path, content: "{}" });
      expect(c.toolName, path).toBe("shell_destructive");
      expect(c.arguments.pathUnresolved, path).toBe(true);
      expect(call("edit", { path, oldText: "a", newText: "b" }).toolName).toBe(
        "shell_destructive",
      );
      expect(call("read", { path }).toolName, `read ${path}`).toBe(
        "shell_destructive",
      );
    }
  });

  it("an encoded read of a process environment is governed", () => {
    for (const path of [
      "file:///pro%63/self/%65nviron",
      "file:///%70roc/1/env%69ron",
      "@/proc/1/environ",
      "file:///proc/self/environ",
    ]) {
      expect(call("read", { path })?.toolName, path).toBe("shell_destructive");
    }
    expect(call("read", { path: "file:///data/notes.md" })).toBeNull();
    expect(call("read", { path: "src/a.ts" })).toBeNull();
  });

  it("an exec whose workdir is the state directory goes to the Ask tier", () => {
    for (const workdir of [
      "/data/.openclaw",
      "/data/.openclaw/extensions",
      "/srv/oc-state",
      "file:///data/%2Eopenclaw",
    ]) {
      expect(
        call("exec", { command: "cp /tmp/x.js extensions/g/index.js", workdir })
          .toolName,
        workdir,
      ).toBe("shell_destructive");
    }
    expect(
      call("exec", { command: "ls", workdir: "/data/.openclaw/workspace/a" })
        .toolName,
    ).toBe("shell");
  });

  it("quoting or escaping the openclaw CLI name does not hide it", () => {
    for (const command of [
      '"openclaw" plugins disable guardian',
      "'openclaw' config set plugins.entries.guardian.enabled false",
      "o'p'enclaw plugins disable guardian",
      "open\\claw plugins uninstall guardian",
      "$(which openclaw) plugins disable guardian",
      "x=openclaw; $x plugins disable guardian",
      "$CLI plugins disable guardian",
      "$CLI config set plugins.entries.guardian.enabled false",
      "$CLI plugins remove @odingard/guardian",
    ]) {
      expect(call("exec", { command }).toolName, command).toBe(
        "shell_destructive",
      );
    }
  });

  it("normalizeOpenClawPath matches OpenClaw's expandPath", () => {
    const home = homedir();
    expect(
      normalizeOpenClawPath("file:///data/%2Eopenclaw/openclaw%2Ejson"),
    ).toBe("/data/.openclaw/openclaw.json");
    expect(normalizeOpenClawPath("@~/a")).toBe(`${home}/a`);
    expect(normalizeOpenClawPath("~")).toBe(home);
    expect(normalizeOpenClawPath("a\u2003b/./c/../d")).toBe("a b/d");
    expect(normalizeOpenClawPath("../x")).toBe("../x");
    expect(normalizeOpenClawPath("file://h/x")).toBeNull();
    expect(normalizeOpenClawPath("http://x/y")).toBeNull();
  });

  it("link creation is Ask tier, so a link cannot switch Guardian off in two Allow steps", () => {
    // Step 1 alone would be everyday shell; step 2 is an in-workspace write.
    expect(
      call("exec", { command: "ln -s .. s", workdir: "~/.openclaw/workspace" })
        .toolName,
    ).toBe("shell_destructive");
    for (const command of [
      "ln -s .. s",
      "ln -sf /data/.openclaw s",
      "ln -s ~ h",
      "ln ../openclaw.json x",
      "ln x y",
      "/bin/ln -s .. s",
      "busybox ln -s .. s",
      "find . -name a -exec ln -s .. {} \\;",
      "'l'n -s .. s",
      "link ../openclaw.json x",
      "cp -s ../openclaw.json x",
      "cp -rs .. s",
      "cp --symbolic-link .. s",
      "cp -l ../openclaw.json x",
      "cp --link ../openclaw.json x",
      `python3 -c 'import os; os.symlink("..", "s")'`,
      `node -e 'require("fs").symlinkSync("..", "s")'`,
      `perl -e 'symlink("..", "s")'`,
      `ruby -e 'File.link("..", "s")'`,
      "New-Item -ItemType SymbolicLink -Path s -Target ..",
      "mklink /D s ..",
    ]) {
      expect(call("exec", { command }).toolName, command).toBe(
        "shell_destructive",
      );
    }
    for (const command of [
      "ls -la",
      "cp -r src dst",
      "echo lines",
      "git log",
    ]) {
      expect(call("exec", { command }).toolName, command).not.toBe(
        "shell_destructive",
      );
    }
  });

  it("backstop: link calls the earlier patterns missed are Ask tier", () => {
    for (const command of [
      `python3 -c 'from pathlib import Path; Path("s").symlink_to("..")'`,
      `python3 -c 'import pathlib; pathlib.Path("h").hardlink_to("../openclaw.json")'`,
      "cp --sym ../openclaw.json x",
      "cp --symb .. s",
      "cp --li ../openclaw.json x",
      "cp -r --l ../extensions x",
      `ruby -e 'require "fileutils"; FileUtils.ln_s("..", "s")'`,
      `ruby -rfileutils -e 'FileUtils::ln_sf "..", "s"'`,
      `perl -e 'symlink "..", "s"'`,
      `perl -e 'link "../openclaw.json", "x"'`,
      `python3 -c "import os; f = os.symlink; f('..', 's')"`,
      // Interpreters the bare-word rule does not know: the call patterns.
      `ipython -c 'Path("s").symlink_to("..")'`,
      `pypy3 -c 'Path("h").hardlink_to("x")'`,
      `jruby -e 'FileUtils.ln_s("..", "s")'`,
      `truffleruby -e 'FileUtils::symlink("..", "s")'`,
    ]) {
      expect(
        call("exec", { command, workdir: "/srv/app" }).toolName,
        command,
      ).toBe("shell_destructive");
    }
    for (const command of [
      "cp --sparse=always a b",
      "cp --suffix=~ a b",
      "perl -e 'print 1'",
    ]) {
      expect(
        call("exec", { command, workdir: "/srv/app" }).toolName,
        command,
      ).toBe("shell");
    }
  });

  it("backstop: '..' operands are Ask tier when the cwd may be the workspace", () => {
    for (const command of [
      "mv ../extensions/guardian x",
      "cp -r evil/. ..",
      "tar -C .. -xf evil.tar",
      "git --work-tree=.. checkout -- .",
      "rsync -a x/ ../",
      "cat a/../../openclaw.json",
      "mv '..'/extensions x",
    ]) {
      for (const workdir of [
        undefined,
        "~/.openclaw/workspace",
        "sub/dir",
        "/srv/oc-state/ws",
      ]) {
        expect(
          call("exec", { command, ...(workdir ? { workdir } : {}) }).toolName,
          `${command} @ ${workdir}`,
        ).toBe("shell_destructive");
      }
    }
    expect(
      call("exec", { command: "mv ../a b", workdir: "/srv/app" }).toolName,
    ).toBe("shell");
    for (const command of ["git log HEAD..main", "echo ...", "ls ./x"]) {
      expect(call("exec", { command }).toolName, command).toBe("shell");
    }
  });

  it("apply_patch headers with leading whitespace are still read", () => {
    const input = [
      "*** Begin Patch",
      "  *** Add File: /data/.openclaw/openclaw.json",
      "+{}",
      "\t*** Update File: src/a.ts",
      " *** Move to: ../extensions/guardian/index.js",
      "*** End Patch",
    ].join("\n");
    expect(patchPaths(input)).toEqual([
      { operation: "add", path: "/data/.openclaw/openclaw.json" },
      { operation: "update", path: "src/a.ts" },
      { operation: "move", path: "../extensions/guardian/index.js" },
    ]);
    expect(
      call("apply_patch", {
        input:
          "*** Begin Patch\n *** Add File: ~/.openclaw/openclaw.json\n+{}\n*** End Patch",
      }).toolName,
    ).toBe("shell_destructive");
  });

  it("the legacy ~/.clawdbot state directory and clawdbot.json are control plane", () => {
    for (const path of [
      "~/.clawdbot/clawdbot.json",
      "~/.clawdbot/extensions/guardian/index.js",
      "/data/.CLAWDBOT/x",
      "/etc/clawdbot.json",
      "file:///home/u/%2Eclawdbot/x",
    ]) {
      expect(call("write", { path, content: "{}" }).toolName, path).toBe(
        "shell_destructive",
      );
    }
    for (const command of [
      "rm -rf ~/.clawdbot/extensions/guardian",
      "cat ~/.ClawdBot/settings",
      "sed -i s/a/b/ clawdbot.json",
    ]) {
      expect(call("exec", { command }).toolName, command).toBe(
        "shell_destructive",
      );
    }
    expect(
      call("write", { path: "~/.clawdbot/workspace/notes.md", content: "" })
        .toolName,
    ).toBe("file_write");
  });

  it("control roots match case-insensitively (APFS)", () => {
    for (const path of [
      "/SRV/OC-STATE/plugins.json",
      "/srv/Oc-State",
      "file:///Srv/oc-state/x",
      "/ETC/oc/OpenClaw-Main.json5",
    ]) {
      expect(call("write", { path, content: "{}" }).toolName, path).toBe(
        "shell_destructive",
      );
    }
    expect(call("exec", { command: "jq . /SRV/oc-state/x" }).toolName).toBe(
      "shell_destructive",
    );
    expect(
      call("exec", { command: "ls", workdir: "/Srv/OC-State" }).toolName,
    ).toBe("shell_destructive");
  });

  it("reads the extra roots from the Gateway environment", () => {
    expect(
      controlRootsFromEnv({
        OPENCLAW_STATE_DIR: "/srv/oc-state/",
        OPENCLAW_CONFIG_PATH: " /etc/oc/c.json ",
        OPENCLAW_HOME: "/",
        HOME: "/home/u",
      }),
    ).toEqual(["/srv/oc-state", "/etc/oc/c.json"]);
  });
});

describe("exec env overrides and Code Mode", () => {
  it("an exec carrying env overrides is never on the everyday tier", () => {
    for (const env of [
      { X: "vercel deploy --prod" },
      { BASH_ENV: "/tmp/x.sh" },
      { LD_PRELOAD: "/tmp/x.so" },
    ]) {
      expect(name("exec", { command: 'bash -c "$X"', env })).toBe(
        "shell_destructive",
      );
      expect(name("exec", { command: "ls", env })).toBe("shell_destructive");
    }
    expect(name("exec", { command: "ls", env: {} })).toBe("shell");
    // A consequential command keeps its own name.
    expect(name("exec", { command: "terraform apply", env: { A: "b" } })).toBe(
      "shell_deploy",
    );
  });

  it("Code Mode exec is governed as its own tool, not as a shell command", () => {
    const c = governOpenClawCall({
      toolName: "exec",
      toolKind: "code_mode_exec",
      params: { code: "return 1 + 1", command: "return 1 + 1" },
    })!;
    expect(c.toolName).toBe("openclaw.code_mode_exec");
    expect(tierOf(c.toolName)).toBe("ask");
    expect(c.arguments).toMatchObject({
      language: "javascript",
      code: "return 1 + 1",
      codeDigest: expect.stringMatching(/^sha256:/),
    });
  });
});
