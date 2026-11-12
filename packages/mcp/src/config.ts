/**
 * CLI configuration. Missing settings produce one readable message
 * (never a stack trace) that says exactly what to set.
 */
/**
 * A remote MCP upstream reached over Streamable HTTP or SSE. The
 * URL and header values are already resolved from the environment; they are
 * secrets and are never printed (see `secretsOf`).
 */
export type RemoteUpstream = {
  url: string;
  transport: "streamable-http" | "sse";
  headers: Record<string, string>;
};

export type UpstreamTarget =
  | { command: string; args: string[] }
  | { remote: RemoteUpstream };

export type CliMode =
  | { kind: "dispatch" }
  | ({
      kind: "proxy";
      /**
       * `--pin-file <tool>:<arg>` (repeatable): declared file arguments,
       * tool → argument names. Stdio upstreams only.
       */
      pinFiles?: Record<string, string[]>;
    } & UpstreamTarget)
  | ({ kind: "tools"; json: boolean } & UpstreamTarget);

export type GuardianMcpConfig = {
  baseUrl: string;
  credential: string;
  connectionId?: string;
  adapterId?: string;
  autoRegister: boolean;
  mode: CliMode;
};

export const USAGE = `guardian-mcp — route an agent's tool calls through Guardian (ALLOW / ASK / DENY).

Usage:
  guardian-mcp                               Guardian tools (guardian_invoke_tool, guardian_claim, guardian_receipt)
  guardian-mcp proxy -- <command> [args...]  Govern every tool of an existing stdio MCP server
  guardian-mcp proxy --pin-file <tool>:<arg> [--pin-file ...] -- <command> [args...]
                                             Also pin the file a path argument names: its SHA-256
                                             goes into the approved arguments and is checked again
                                             just before the call is forwarded (stdio upstreams
                                             only; the path must be absolute)
  guardian-mcp proxy --url <https-url> [--transport streamable-http|sse] [--header "Name: value"]...
                                             Govern every tool of a remote MCP server (Streamable
                                             HTTP by default, or SSE). The agent still talks stdio.
  guardian-mcp tools [--json] -- <command> [args...]
  guardian-mcp tools [--json] --url <https-url> [--transport ...] [--header ...]
                                             List a server's tools with a suggested Guardian mode
                                             for each (no Guardian credential needed)

Remote upstreams:
  Write secrets as \${ENV_VAR} references, e.g. --header 'x-api-key: \${COMPOSIO_API_KEY}'
  (single quotes in a shell, so the key never appears in the process list; JSON configs need
  no quoting). guardian-mcp expands them itself, refuses a missing variable and any
  GUARDIAN_* variable, and never prints the URL or header values. The URL must be https://
  (plain http:// only for localhost).

Environment:
  GUARDIAN_BASE_URL          required, e.g. https://guardian-api.odingard.com
  GUARDIAN_AGENT_CREDENTIAL  required, the agent credential (gak_…) from the Guardian console
  GUARDIAN_CONNECTION_ID     tool connection id (required for proxy mode)
  GUARDIAN_ADAPTER_ID        optional adapter override
  GUARDIAN_AUTO_REGISTER     proxy: "true" to propose registering each upstream tool on first
                             use (mcp.install). Default off: register the tools once in the
                             console as "My own code (record-only)" and allow them for the agent

Examples (proxy):
  guardian-mcp proxy -- npx -y @modelcontextprotocol/server-filesystem ./data
  guardian-mcp proxy --url https://mcp.example.com/mcp --header 'Authorization: Bearer \${REMOTE_MCP_API_KEY}'
`;

export function parseCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; config: GuardianMcpConfig } | { ok: false; message: string } {
  let mode: CliMode = { kind: "dispatch" };
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { ok: false, message: USAGE };
  }
  if (argv[0] === "tools") {
    const json = argv[1] === "--json";
    const target = parseTarget("tools", argv.slice(json ? 2 : 1), env);
    if (!target.ok) return target;
    // Listing tools needs no Guardian settings at all.
    return {
      ok: true,
      config: {
        baseUrl: "",
        credential: "",
        autoRegister: false,
        mode: { kind: "tools", json, ...target.target },
      },
    };
  }
  if (argv[0] === "proxy") {
    const pins = extractPinFiles(argv.slice(1));
    if (!pins.ok) return pins;
    const target = parseTarget("proxy", pins.rest, env);
    if (!target.ok) return target;
    const declared = Object.keys(pins.pinFiles).length > 0;
    if (declared && "remote" in target.target) {
      return {
        ok: false,
        message:
          "guardian-mcp proxy: --pin-file is supported only for a stdio upstream " +
          "(CONTENT_PIN_REMOTE_UPSTREAM). A remote MCP server opens paths on " +
          `another machine, so the proxy cannot check the file it will read.\n\n${USAGE}`,
      };
    }
    mode = {
      kind: "proxy",
      ...target.target,
      ...(declared ? { pinFiles: pins.pinFiles } : {}),
    };
  } else if (argv.length > 0) {
    return {
      ok: false,
      message: `guardian-mcp: unknown argument "${argv[0]}".\n\n${USAGE}`,
    };
  }

  const missing = ["GUARDIAN_BASE_URL", "GUARDIAN_AGENT_CREDENTIAL"].filter(
    (name) => !env[name],
  );
  if (mode.kind === "proxy" && !env.GUARDIAN_CONNECTION_ID) {
    missing.push("GUARDIAN_CONNECTION_ID");
  }
  if (missing.length > 0) {
    return {
      ok: false,
      message: `guardian-mcp: missing required setting${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.\n\n${USAGE}`,
    };
  }
  return {
    ok: true,
    config: {
      baseUrl: env.GUARDIAN_BASE_URL!,
      credential: env.GUARDIAN_AGENT_CREDENTIAL!,
      ...(env.GUARDIAN_CONNECTION_ID
        ? { connectionId: env.GUARDIAN_CONNECTION_ID }
        : {}),
      ...(env.GUARDIAN_ADAPTER_ID
        ? { adapterId: env.GUARDIAN_ADAPTER_ID }
        : {}),
      // Off by default — production denies first-use registration
      // unless the grant pins mcp.install. Opt in with GUARDIAN_AUTO_REGISTER=true.
      autoRegister: /^(true|1|yes|on)$/i.test(env.GUARDIAN_AUTO_REGISTER ?? ""),
      mode,
    },
  };
}

/**
 * Environment handed to the upstream MCP server: everything except
 * Guardian's own settings — the upstream never sees the agent credential.
 */
export function upstreamEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("GUARDIAN_")) continue;
    out[key] = value;
  }
  return out;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Expand `${NAME}` references from the environment. Guardian's own settings
 * can never be expanded into an upstream request, so the agent credential
 * cannot be forwarded to a remote server by mistake.
 */
function expandEnv(
  cmd: "proxy" | "tools",
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  where: string,
): { ok: true; value: string } | { ok: false; message: string } {
  for (const match of value.matchAll(ENV_REF)) {
    const name = match[1]!;
    if (name.startsWith("GUARDIAN_")) {
      return {
        ok: false,
        message: `guardian-mcp ${cmd}: ${where} refers to \${${name}}; Guardian settings are never sent to the upstream server.`,
      };
    }
    if (!env[name]) {
      return {
        ok: false,
        message: `guardian-mcp ${cmd}: ${where} refers to \${${name}}, which is not set.`,
      };
    }
  }
  return {
    ok: true,
    value: value.replace(ENV_REF, (_, name: string) => env[name]!),
  };
}

/**
 * Take every `--pin-file <tool>:<arg>` (or `--pin-file=<tool>:<arg>`) out
 * of the proxy options before the upstream command (`--`), which is left
 * untouched.
 */
function extractPinFiles(
  argv: readonly string[],
):
  | { ok: true; pinFiles: Record<string, string[]>; rest: string[] }
  | { ok: false; message: string } {
  const pinFiles: Record<string, string[]> = {};
  const rest: string[] = [];
  const fail = (message: string) => ({
    ok: false as const,
    message: `guardian-mcp proxy: ${message}\n\n${USAGE}`,
  });
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    let value: string | undefined;
    if (arg === "--pin-file") {
      value = argv[++i];
    } else if (arg.startsWith("--pin-file=")) {
      value = arg.slice("--pin-file=".length);
    } else {
      rest.push(arg);
      continue;
    }
    const colon = value?.lastIndexOf(":") ?? -1;
    const tool = colon > 0 ? value!.slice(0, colon) : "";
    const name = colon > 0 ? value!.slice(colon + 1) : "";
    if (!tool || !name || name.includes(".")) {
      return fail(
        '--pin-file needs "<tool>:<argument>", naming a top-level argument.',
      );
    }
    const list = (pinFiles[tool] ??= []);
    if (!list.includes(name)) list.push(name);
  }
  rest.push(...argv.slice(i));
  return { ok: true, pinFiles, rest };
}

type TargetResult =
  | { ok: true; target: UpstreamTarget }
  | { ok: false; message: string };

function parseTarget(
  cmd: "proxy" | "tools",
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): TargetResult {
  const fail = (message: string): TargetResult => ({
    ok: false,
    message: `guardian-mcp ${cmd}: ${message}\n\n${USAGE}`,
  });
  if (argv[0] === "--") argv = argv.slice(1);
  else if (argv[0]?.startsWith("--")) return parseRemote(cmd, argv, env, fail);
  const [command, ...args] = argv;
  if (!command) {
    return fail(
      cmd === "proxy"
        ? "missing the upstream MCP server command (or --url for a remote server)."
        : "missing the MCP server command (or --url for a remote server).",
    );
  }
  return { ok: true, target: { command, args } };
}

function parseRemote(
  cmd: "proxy" | "tools",
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  fail: (message: string) => TargetResult,
): TargetResult {
  let rawUrl: string | undefined;
  let transport: RemoteUpstream["transport"] = "streamable-http";
  const rawHeaders: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    let value: string | undefined;
    if (flag !== arg) value = arg.slice(eq + 1);
    else if (
      flag === "--url" ||
      flag === "--transport" ||
      flag === "--header"
    ) {
      value = argv[++i];
    }
    if (flag === "--url") {
      if (rawUrl !== undefined) return fail("--url given more than once.");
      if (!value) return fail("--url needs a value.");
      rawUrl = value;
    } else if (flag === "--transport") {
      if (value !== "streamable-http" && value !== "sse" && value !== "http") {
        return fail('--transport must be "streamable-http" or "sse".');
      }
      transport = value === "sse" ? "sse" : "streamable-http";
    } else if (flag === "--header") {
      if (!value) return fail("--header needs a value.");
      rawHeaders.push(value);
    } else if (flag === "--") {
      return fail("give either --url or a command after --, not both.");
    } else {
      // Never echo the argument itself: it may be a misplaced secret.
      return fail(
        `unknown option at position ${i + 1} (expected --url, --transport or --header).`,
      );
    }
  }
  if (!rawUrl) return fail("--url is required with --transport or --header.");
  const expandedUrl = expandEnv(cmd, rawUrl, env, "--url");
  if (!expandedUrl.ok) return expandedUrl;
  let url: URL;
  try {
    url = new URL(expandedUrl.value);
  } catch {
    return fail("--url is not a valid URL.");
  }
  if (url.username || url.password) {
    return fail(
      "--url must not carry a user name or password; send credentials with --header.",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
  ) {
    return fail(
      "--url must be https:// (plain http:// is accepted only for localhost).",
    );
  }
  const headers: Record<string, string> = {};
  for (const [n, raw] of rawHeaders.entries()) {
    const colon = raw.indexOf(":");
    const name = colon > 0 ? raw.slice(0, colon).trim() : "";
    if (!name || !HEADER_NAME.test(name)) {
      return fail(`--header #${n + 1} must look like "Name: value".`);
    }
    const expanded = expandEnv(
      cmd,
      raw.slice(colon + 1).trim(),
      env,
      `--header ${name}`,
    );
    if (!expanded.ok) return expanded;
    if (!expanded.value) return fail(`--header ${name} has an empty value.`);
    if (/[\r\n]/.test(expanded.value))
      return fail(`--header ${name} contains a line break.`);
    headers[name] = expanded.value;
  }
  return {
    ok: true,
    target: { remote: { url: url.href, transport, headers } },
  };
}

/**
 * Every secret a remote upstream carries (the full URL, its query string and
 * each header value), so diagnostics can be scrubbed before they reach stderr.
 */
export function secretsOf(target: UpstreamTarget): string[] {
  if (!("remote" in target)) return [];
  const { url, headers } = target.remote;
  const out = new Set<string>([url]);
  const parsed = new URL(url);
  if (parsed.search) out.add(parsed.search.slice(1));
  for (const v of parsed.searchParams.values()) if (v.length >= 4) out.add(v);
  // Each query value also as typed (`AbC+dEf/gh12==` keeps its "+", which
  // searchParams turns into a space), percent-decoded, and with "+" read as
  // a space: an upstream error can echo any of these forms.
  for (const pair of parsed.search.slice(1).split("&")) {
    const raw = pair.slice(pair.indexOf("=") + 1);
    if (pair.indexOf("=") < 0 || raw.length < 4) continue;
    const forms = [raw, raw.replace(/\+/g, " ")];
    for (const form of [...forms]) {
      try {
        forms.push(decodeURIComponent(form));
      } catch {
        // not valid percent-encoding: the raw form is enough
      }
    }
    for (const form of forms) if (form.length >= 4) out.add(form);
  }
  // Path segments that look like identifiers (Composio-style
  // /v3/mcp/<server-id>/mcp URLs carry the server id in the path).
  for (const segment of parsed.pathname.split("/")) {
    if (segment.length >= 16 || (segment.length >= 8 && /\d/.test(segment))) {
      out.add(segment);
      out.add(decodeURIComponent(segment));
    }
  }
  for (const value of Object.values(headers)) {
    out.add(value);
    // "Bearer <token>": also scrub the bare token.
    const parts = value.split(/\s+/);
    for (const part of parts) if (part.length >= 8) out.add(part);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replace every secret in `text` with [redacted]. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** A safe, printable description of where the upstream is: origin only. */
export function describeTarget(target: UpstreamTarget): string {
  if ("remote" in target) {
    return `${new URL(target.remote.url).origin} (${target.remote.transport})`;
  }
  return [target.command, ...target.args].join(" ");
}
