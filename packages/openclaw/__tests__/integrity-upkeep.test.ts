import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { checkInstallIntegrity, npmConfigFiles } from "../src/integrity.js";
import { protectedInstall, type Fixture } from "./install-fixture.js";

/** Install integrity: npm config read by a root upkeep, catalogs, config backups. */
const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

let fx: Fixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

const problems = (f: Fixture, extra: Record<string, unknown> = {}) => {
  const r = checkInstallIntegrity({ ...f.install, ...extra });
  return r.ok ? [] : r.problems;
};

describe("npm config the Gateway's HOME would give npm", () => {
  it("a protected install with a read-only $HOME/.npmrc passes", () => {
    fx = protectedInstall({ npm: true });
    expect(checkInstallIntegrity(fx.install)).toEqual({ ok: true });
  });

  it("a writable $HOME/.npmrc blocks", () => {
    fx = protectedInstall();
    chmodSync(fx.npmrc, 0o666);
    expect(problems(fx)).toContain(fx.npmrc);
  });

  it("a missing $HOME/.npmrc the Gateway user could create blocks (Maritime: /data is 1775 root:node)", () => {
    fx = protectedInstall();
    rmSync(fx.npmrc);
    chmodSync(fx.home, 0o1777); // sticky: existing entries are safe, new ones are not
    expect(problems(fx).join("\n")).toContain(
      `can create an npm config file ${fx.npmrc}`,
    );
  });

  it("npm_config_userconfig (any case) moves the user config, and /dev/null is skipped", () => {
    fx = protectedInstall();
    const alt = join(fx.root, "alt-npmrc");
    writeFileSync(alt, "");
    chmodSync(alt, 0o666);
    for (const key of ["NPM_CONFIG_USERCONFIG", "npm_config_userconfig"]) {
      const env = { ...fx.install.env, [key]: alt };
      expect(problems(fx, { env })).toContain(alt);
    }
    rmSync(fx.npmrc);
    chmodSync(fx.home, 0o1777);
    const env = { ...fx.install.env, NPM_CONFIG_USERCONFIG: "/dev/null" };
    expect(problems(fx, { env })).toEqual([]);
  });

  it("the global config (<node prefix>/etc/npmrc, or npm_config_globalconfig / _prefix) is covered", () => {
    fx = protectedInstall();
    const prefix = join(fx.root, "node");
    mkdirSync(join(prefix, "etc"), { recursive: true, mode: 0o755 });
    chmodSync(prefix, 0o755);
    chmodSync(join(prefix, "etc"), 0o755);
    expect(problems(fx, { nodePrefix: prefix })).toEqual([]);
    chmodSync(join(prefix, "etc"), 0o777);
    expect(problems(fx, { nodePrefix: prefix }).join("\n")).toContain(
      `can create an npm config file ${join(prefix, "etc", "npmrc")}`,
    );
    chmodSync(join(prefix, "etc"), 0o755);
    const global = join(prefix, "etc", "npmrc");
    writeFileSync(global, "");
    chmodSync(global, 0o666);
    expect(problems(fx, { nodePrefix: prefix })).toContain(global);
    chmodSync(global, 0o644);
    const other = join(fx.root, "g-npmrc");
    writeFileSync(other, "");
    chmodSync(other, 0o666);
    const env = { ...fx.install.env, NPM_CONFIG_GLOBALCONFIG: other };
    expect(problems(fx, { env, nodePrefix: prefix })).toContain(other);
    const env2 = { ...fx.install.env, npm_config_prefix: join(fx.root, "p") };
    mkdirSync(join(fx.root, "p", "etc"), { recursive: true, mode: 0o777 });
    chmodSync(join(fx.root, "p", "etc"), 0o777);
    expect(
      problems(fx, { env: env2, nodePrefix: prefix }).join("\n"),
    ).toContain(join(fx.root, "p", "etc", "npmrc"));
  });

  it("npmConfigFiles follows npm 10's defaults", () => {
    expect(npmConfigFiles({ HOME: "/data" }, "/usr/local")).toEqual([
      "/data/.npmrc",
      "/usr/local/etc/npmrc",
    ]);
    expect(
      npmConfigFiles(
        {
          HOME: "/data",
          NPM_CONFIG_USERCONFIG: "~/x/.npmrc",
          npm_config_prefix: "/opt/p",
        },
        "/usr/local",
      ),
    ).toEqual(["/data/x/.npmrc", "/opt/p/etc/npmrc"]);
    expect(
      npmConfigFiles(
        {
          HOME: "/data",
          NPM_CONFIG_USERCONFIG: "/dev/null",
          NPM_CONFIG_GLOBALCONFIG: "/dev/null",
        },
        "/usr/local",
      ),
    ).toEqual([]);
  });
});

describe("plugin catalogs: <config dir>/mpm and <config dir>/plugins", () => {
  it("a writable catalog file blocks", () => {
    for (const [dir, file] of [
      ["mpmDir", "catalog.json"],
      ["mpmDir", "plugins.json"],
      ["pluginsDir", "catalog.json"],
    ] as const) {
      fx = protectedInstall();
      const p = join(fx[dir], file);
      writeFileSync(p, "{}");
      chmodSync(p, 0o666);
      expect(problems(fx), p).toContain(p);
      fx.cleanup();
      fx = undefined;
    }
  });

  it("a writable mpm/ or plugins/ directory blocks", () => {
    fx = protectedInstall();
    chmodSync(fx.pluginsDir, 0o777);
    expect(problems(fx)).toContain(fx.pluginsDir);
  });

  it("a missing mpm/ or plugins/ the Gateway user could create blocks", () => {
    fx = protectedInstall();
    rmSync(fx.mpmDir, { recursive: true });
    rmSync(fx.pluginsDir, { recursive: true });
    chmodSync(fx.stateDir, 0o1777);
    const text = problems(fx).join("\n");
    expect(text).toContain(`can create a plugin catalog ${fx.mpmDir}`);
    expect(text).toContain(`can create a plugin catalog ${fx.pluginsDir}`);
  });
});

describe("config backups: <config>.bak and <config>.bak.*", () => {
  it("a writable openclaw.json.bak blocks", () => {
    fx = protectedInstall();
    chmodSync(`${fx.config}.bak`, 0o666);
    expect(problems(fx)).toContain(`${fx.config}.bak`);
  });

  it("a missing openclaw.json.bak the Gateway user could create blocks", () => {
    fx = protectedInstall();
    rmSync(`${fx.config}.bak`);
    chmodSync(fx.stateDir, 0o1777);
    expect(problems(fx).join("\n")).toContain(
      `can create the OpenClaw config backup ${fx.config}.bak`,
    );
  });

  it("a writable rotated backup (openclaw.json.bak.<n>) blocks", () => {
    fx = protectedInstall();
    const rotated = `${fx.config}.bak.1`;
    writeFileSync(rotated, "{}");
    chmodSync(rotated, 0o666);
    expect(problems(fx)).toContain(rotated);
  });
});

describe("README: the Maritime recipe and upkeep", () => {
  const readme = readFileSync(join(PKG, "README.md"), "utf8");
  const section = readme.slice(
    readme.indexOf("### Maritime / the official OpenClaw image"),
    readme.indexOf("### Other hosts"),
  );
  const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(
    (m) => m[1]!,
  );

  it("the recipe makes $HOME/.npmrc, mpm/, plugins/ and openclaw.json.bak root-owned and read-only", () => {
    const recipe = blocks[0]!;
    expect(recipe).toMatch(/\/data\/\.npmrc/);
    expect(recipe).toMatch(/chmod 0444[^\n]*\/data\/\.npmrc/);
    expect(recipe).toMatch(/"\$S\/mpm"/);
    expect(recipe).toMatch(/"\$S\/plugins"/);
    expect(recipe).toMatch(/openclaw\.json\.bak/);
    expect(recipe).toMatch(/rm -rf \/data\/\.npm\b/);
  });

  it("every npm or openclaw command run as root ignores npm config the Gateway user can write", () => {
    const upkeep = blocks.slice(1).join("\n");
    expect(upkeep).toMatch(/NPM_CONFIG_USERCONFIG=\/dev\/null/);
    // npm 10 refuses the same file (/dev/null) as both user and global config.
    expect(upkeep).toMatch(/NPM_CONFIG_GLOBALCONFIG=\/root\/empty\.npmrc/);
    expect(upkeep).toMatch(/^: > \/root\/empty\.npmrc$/m);
    expect(upkeep).toMatch(/NPM_CONFIG_CACHE=\/root\/\.npm/);
    expect(upkeep).toMatch(/registry\.npmjs\.org/);
    // OpenClaw drops npm_config_cache from the env it gives npm, so root's
    // HOME must not be the Gateway's: npm would fall back to $HOME/.npm.
    const upkeepBlock = blocks[1]!;
    const lines = upkeepBlock.split("\n");
    const exportAt = lines.findIndex((l) =>
      /^export HOME=\/root .*NPM_CONFIG_USERCONFIG=\/dev\/null/.test(l),
    );
    expect(exportAt).toBeGreaterThan(-1);
    lines.forEach((line, i) => {
      const runsTool = /(^|\s)(openclaw|npm) /.test(line.replace(/#.*$/, ""));
      if (!runsTool) return;
      expect(i, line).toBeGreaterThan(exportAt);
      // The only openclaw command is a read-only one, run as the Gateway user.
      if (/(^|\s)openclaw /.test(line)) {
        expect(line).toMatch(
          /^\(cd \/app && setpriv --reuid node .*openclaw config validate\)$/,
        );
      }
    });
    for (const line of lines) {
      if (/HOME=\/data\b/.test(line)) {
        expect(line).toMatch(/setpriv --reuid node .* env HOME=\/data /);
      }
    }
    // The integrity step after every upkeep.
    expect(upkeep).toMatch(/sha256sum/);
    expect(upkeep).toMatch(/dist\/index\.js/);
  });

  it("the README says a writable working directory blocks", () => {
    expect(section).toMatch(/working directory[\s\S]{0,400}blocked/);
  });
});
