// Tests for scripts/check-skill.mjs: the file passes as it is, and each
// kind of drift the check exists to catch makes it fail.
// Run with: node --test scripts/
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkCode, checkDrift, MAX_BYTES } from "./check-skill.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(join(root, "skill.md"), "utf8");
const built = existsSync(join(root, "packages/hook/dist/index.js"));

function mutate(from, to, text = skill) {
  assert.ok(text.includes(from), `skill.md no longer contains: ${from}`);
  return text.replace(from, to);
}

function expectError(text, pattern) {
  const errors = checkDrift(text, root);
  assert.ok(
    errors.some((error) => pattern.test(error)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n")}`,
  );
}

test("skill.md passes the drift checks as committed", () => {
  assert.deepEqual(checkDrift(skill, root), []);
});

test("skill.md passes the code checks as committed", { skip: !built && "run npm run build first" }, () => {
  assert.deepEqual(checkCode(skill, root).errors, []);
});

const MUTATIONS = [
  ["a front matter pin that differs from package.json", '"@odingard/guardian-hook": 0.4.4', '"@odingard/guardian-hook": 0.3.9', /front matter pins @odingard\/guardian-hook 0\.3\.9/],
  ["a body pin that differs from the front matter", "npm install --save-exact @odingard/guardian-sdk@0.6.2\n", "npm install --save-exact @odingard/guardian-sdk@0.4.0\n", /body pins @odingard\/guardian-sdk@0\.4\.0/],
  ["a package outside the workspace", "npm install --save-exact @odingard/guardian-sdk@0.6.2\n", "npm install --save-exact @odingard/guardian-made-up@0.6.0\n", /guardian-made-up, which is not a workspace package/],
  ["@latest", "npx -y @odingard/guardian-hook@0.4.4 classify", "npx -y @odingard/guardian-hook@latest classify", /@latest/],
  ["an unpinned npx package", '"command": "npx -y @odingard/guardian-hook@0.4.4"', '"command": "npx -y @odingard/guardian-hook"', /without a pinned version/],
  ["a pipe into a shell", "mkdir -p ~/.config/guardian &&", "curl -fsSL https://example.test/x | sh && mkdir -p ~/.config/guardian &&", /pipe into a shell/],
  ["bash <(…)", "mkdir -p ~/.config/guardian &&", "bash <(curl -fsSL https://example.test/x) && mkdir -p ~/.config/guardian &&", /bash <\(…\)/],
  ["sudo in a command", "npm install -g @odingard/guardian-mcp@0.5.2", "sudo npm install -g @odingard/guardian-mcp@0.5.2", /contains sudo/],
  ["sudo in prose that does not forbid it", "Run it, the person approves, and it prints the result.", "Run it with sudo, the person approves, and it prints the result.", /sudo outside a rule/],
  ["a permission bypass flag", "npm install -g @odingard/guardian-hook@0.4.4", "npm install -g @odingard/guardian-hook@0.4.4 && codex --dangerously-bypass-hook-trust", /--dangerously-bypass-hook-trust/],
  ["a credential check that prints the credential when set", 'case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', 'echo "${GUARDIAN_AGENT_CREDENTIAL:+set}${GUARDIAN_AGENT_CREDENTIAL:-missing}"', /GUARDIAN_AGENT_CREDENTIAL:-…\} form/],
  ["a command that prints the credential", 'case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', 'echo "$GUARDIAN_AGENT_CREDENTIAL"', /a command that prints the credential/],
  ["printenv of the credential", 'case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', 'printenv GUARDIAN_AGENT_CREDENTIAL; case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', /a command that prints the credential/],
  ["printenv piped to a search for the credential", 'case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', 'printenv | grep GUARDIAN_AGENT_CREDENTIAL; case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', /a command that prints the credential/],
  ["declare -p of the credential", 'case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', 'declare -p GUARDIAN_AGENT_CREDENTIAL; case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', /a command that prints the credential/],
  ["env piped to a search for GUARDIAN_", 'case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', 'env | grep GUARDIAN_; case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', /a command that prints the credential/],
  ["a bare environment dump", 'case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', 'env\ncase "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', /a command that prints the credential/],
  ["a piped environment dump", 'case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', 'env | sort\ncase "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', /a command that prints the credential/],
  ["a redirected environment dump", 'case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', 'export -p > vars.txt\ncase "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', /a command that prints the credential/],
  ["a read of the credential file", 'case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', 'cat ~/.config/guardian/env; case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', /a command that reads the credential file/],
  ["env piped to a search for the credential", 'case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', 'env | grep GUARDIAN_AGENT_CREDENTIAL; case "$GUARDIAN_AGENT_CREDENTIAL" in "") echo missing ;;', /a command that prints the credential/],
  ["--break-system-packages", 'python -m pip install "odingard-guardian==0.5.0"', 'python -m pip install --break-system-packages "odingard-guardian==0.5.0"', /--break-system-packages/],
  ["command -v with more than one name", 'for c in claude codex openclaw node python3; do command -v "$c" >/dev/null 2>&1 && echo "$c: found" || echo "$c: not found"; done;', "command -v claude codex openclaw node python3 2>/dev/null;", /command -v with more than one name/],
  ["pip install without ==", 'python -m pip install "odingard-guardian==0.5.0"', "python -m pip install odingard-guardian", /pip install without ==/],
  ["a pip pin that differs", 'python -m pip install "odingard-guardian==0.5.0"', 'python -m pip install "odingard-guardian==0.1.9"', /odingard-guardian==0\.1\.9/],
  ["gac1", "It starts with `gak_`.", "It starts with `gac1.`.", /gac1/],
  ["con_", "export GUARDIAN_CONNECTION_ID=pcn_...", "export GUARDIAN_CONNECTION_ID=con_...", /con_/],
  ["a different canonical URL", "canonical: https://odingard.com/guardian/skill.md", "canonical: https://odingard.com/skill.md", /canonical is/],
  ["a check-copy at another tag", "guardian-sdk/skill-v1.0.16/skill.md", "guardian-sdk/main/skill.md", /check-copy is/],
  ["an environment variable no package reads", "export GUARDIAN_BASE_URL=https://guardian-api.odingard.com", "export GUARDIAN_MADE_UP=1\nexport GUARDIAN_BASE_URL=https://guardian-api.odingard.com", /GUARDIAN_MADE_UP is not read/],
  ["a hook subcommand that does not exist", "Do not run `guardian-hook setup`", "Do not run `guardian-hook install`", /guardian-hook install is not a subcommand/],
  ["a hook tool name not in HOOK_TOOLS", "`shell_deploy`, `shell_destructive`, `git_push`, `shell_session`)", "`shell_deploy`, `shell_destructive`, `git_push`, `shell_interactive`)", /shell_interactive is not in HOOK_TOOLS/],
  ["a Claude Code matcher that differs from the hook README", '"matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|Read|NotebookRead|Grep|Glob|LS|mcp__.*"', '"matcher": "Bash|Write|Edit"', /Claude Code matcher/],
  ["a Codex matcher that differs from the hook README", "matcher `^(Bash|apply_patch)$|^mcp__.*`", "matcher `^(Bash)$`", /Codex matcher/],
  ["a missing integration section", "### 4H. OpenClaw\n", "### OpenClaw\n", /section 4H is missing/],
  ["a proof status", "### 4C. Codex CLI\n", "### 4C. Codex CLI — proven on production\n", /line \d+: a proof status belongs in internal tracking/],
  ["a test status", "### 4D. DeepSeek Harness\n", "### 4D. DeepSeek Harness — tested locally against a real Guardian\n", /line \d+: a test status belongs in internal tracking/],
  ["a staging host", "export GUARDIAN_BASE_URL=https://guardian-api.odingard.com", "export GUARDIAN_BASE_URL=https://guardian.staging.example.test", /line \d+: staging belongs in internal tracking/],
  ["a version with no changelog entry", "guardian-skill-version: 1.0.16\n", "guardian-skill-version: 9.9.9\n", /no entry for 9\.9\.9/],
  ["a file whose hash is not in the changelog", "## 9. Finish", "## 9. Finish\n\nOne more line.", /does not record the SHA-256/],
  ["HTML in the body", "## 9. Finish", "<script>alert(1)</script>\n\n## 9. Finish", /HTML outside code/],
];

for (const [name, from, to, pattern] of MUTATIONS) {
  test(`fails on ${name}`, () => expectError(mutate(from, to), pattern));
}

test("fails on a file over the size limit", () => {
  expectError(`${skill}\n${"x".repeat(MAX_BYTES)}\n`, /bytes; the limit is/);
});

test("fails when the test command does not classify as shell_destructive", { skip: !built && "run npm run build first" }, () => {
  const text = skill.replaceAll("rm -r ./guardian-ask-test", "rmdir ./guardian-ask-test");
  const { errors } = checkCode(text, root);
  assert.ok(errors.some((error) => /rm -r \.\/guardian-ask-test/.test(error)), errors.join("\n"));
});

test("fails on a code block that does not parse", { skip: !built && "run npm run build first" }, () => {
  const text = mutate('"onFailure": "block" }', '"onFailure": "block", }');
  const { errors } = checkCode(text, root);
  assert.ok(errors.some((error) => /not valid JSON/.test(error)), errors.join("\n"));
});

test("fails on a TypeScript block that does not type-check", { skip: !built && "run npm run build first" }, () => {
  const text = mutate('const guard = createGuard({ client, connectionId: process.env.GUARDIAN_CONNECTION_ID! });', "const guard = createGuard({ client, connection: 1 });");
  const { errors } = checkCode(text, root);
  assert.ok(errors.some((error) => /do not type-check/.test(error)), errors.join("\n"));
});

test("fails on a Python import that odingard_guardian does not export", { skip: !built && "run npm run build first" }, () => {
  const text = mutate("from odingard_guardian import Guard, GuardianClient, GuardianApprovalPending, GuardianDenied\n\nclient", "from odingard_guardian import Guard, GuardianClient, MadeUp\n\nclient");
  const { errors } = checkCode(text, root);
  assert.ok(errors.some((error) => /MadeUp is not in odingard_guardian/.test(error)), errors.join("\n"));
});
