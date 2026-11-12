// Generated file — do not edit.
import { createHash } from "node:crypto";
import {
  close as fsClose,
  constants as fsConstants,
  fstat as fsFstat,
  open as fsOpen,
  read as fsRead,
  write as fsWrite,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  TOOL_ARGUMENTS_MAX_BYTES,
} from "./contracts/index.js";

/**
 * Content pins: the bytes behind a file-path argument, bound into the
 * approval.
 *
 * Approval binds the exact arguments. A file path is an argument; the
 * file's contents are not, unless the argument is declared in `fileArgs`.
 * For a declared argument the SDK on the agent's machine reads the file,
 * puts its SHA-256 in the proposed arguments (under `guardianContentPins`)
 * and checks it again just before the tool runs. Guardian's servers never
 * see the file. POSIX only: on Windows every pin attempt is refused.
 */

/** The reserved argument key that carries the pins. */
export const CONTENT_PIN_KEY = "guardianContentPins";

export const CONTENT_CHANGED_SINCE_APPROVAL = "CONTENT_CHANGED_SINCE_APPROVAL";
export const CONTENT_PIN_MISSING = "CONTENT_PIN_MISSING";
export const CONTENT_PIN_UNREADABLE = "CONTENT_PIN_UNREADABLE";
export const CONTENT_PIN_NOT_REGULAR_FILE = "CONTENT_PIN_NOT_REGULAR_FILE";
export const CONTENT_PIN_TOO_LARGE = "CONTENT_PIN_TOO_LARGE";
export const CONTENT_PIN_TOO_MANY = "CONTENT_PIN_TOO_MANY";
export const CONTENT_PIN_UNSTABLE = "CONTENT_PIN_UNSTABLE";
export const CONTENT_PIN_INVALID_ARGUMENT = "CONTENT_PIN_INVALID_ARGUMENT";
export const CONTENT_PIN_KEY_RESERVED = "CONTENT_PIN_KEY_RESERVED";
export const CONTENT_PIN_REMOTE_MODE = "CONTENT_PIN_REMOTE_MODE";
export const CONTENT_PIN_REMOTE_UPSTREAM = "CONTENT_PIN_REMOTE_UPSTREAM";
export const CONTENT_PIN_UNSUPPORTED_PLATFORM =
  "CONTENT_PIN_UNSUPPORTED_PLATFORM";

export type ContentPinReasonCode =
  | typeof CONTENT_CHANGED_SINCE_APPROVAL
  | typeof CONTENT_PIN_MISSING
  | typeof CONTENT_PIN_UNREADABLE
  | typeof CONTENT_PIN_NOT_REGULAR_FILE
  | typeof CONTENT_PIN_TOO_LARGE
  | typeof CONTENT_PIN_TOO_MANY
  | typeof CONTENT_PIN_UNSTABLE
  | typeof CONTENT_PIN_INVALID_ARGUMENT
  | typeof CONTENT_PIN_KEY_RESERVED
  | typeof CONTENT_PIN_REMOTE_MODE
  | typeof CONTENT_PIN_REMOTE_UPSTREAM
  | typeof CONTENT_PIN_UNSUPPORTED_PLATFORM;

/**
 * How a declared file argument reaches the tool, strongest first:
 * - `bytes`: the tool receives a `PinnedFile` (the verified bytes) instead
 *   of the path. Nothing reopens the path.
 * - `copy`: the tool receives the path of a private copy of the verified
 *   bytes. Another process running as the same user could still change
 *   it, and the copy is deleted when the tool returns, so a tool that keeps
 *   using the path afterwards (a background upload) must use `bytes`.
 * - `recheck`: the file is checked again and the tool opens the path
 *   itself, so a short window remains between the check and the open.
 */
export type FileArgMode = "bytes" | "copy" | "recheck";

/** Per tool: top-level argument name → mode (the full form). */
export type FileArgsSpec = Readonly<Record<string, FileArgMode>>;

/**
 * The mode a declared file argument gets when no mode is named: `bytes`,
 * because the tool then receives the verified bytes themselves and there
 * is no gap between the check and the read.
 */
export const DEFAULT_FILE_ARG_MODE = "bytes" satisfies FileArgMode;

/**
 * What a developer may write for one tool's file arguments:
 * - the full form, `{ attachmentPath: "copy" }` (a mode per argument);
 * - `true` in place of a mode, `{ attachmentPath: true }`, meaning `bytes`;
 * - a list of argument names, `["attachmentPath"]`, each meaning `bytes`.
 * The forms are normalized to `FileArgsSpec` at wrap time; anything else
 * (an unknown mode, `false`, an empty or repeated name) is refused there.
 */
export type FileArgsDeclaration =
  | FileArgsSpec
  | readonly string[]
  | Readonly<Record<string, FileArgMode | true>>;

/** One pin, as it appears in the proposed arguments. */
export type ContentPin = Readonly<{
  arg: string;
  index: number;
  mode: FileArgMode;
  name: string;
  size: number;
  sha256: string;
}>;

/** The digest of one file, or (only where asked for) a file that is absent. */
export type FileDigest =
  | Readonly<{ name: string; size: number; sha256: string }>
  | Readonly<{ absent: true }>;

/**
 * The verified bytes of a pinned file. `toString()` is a label, never the
 * path, so `String(file)` or a template string cannot be reopened by
 * accident.
 */
export type PinnedFile = Readonly<{
  path: string;
  name: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
  toString(): string;
}>;

/** At most this many pins per call. */
export const MAX_CONTENT_PINS = 16;
/** Default cap per pinned file (25 MiB). */
export const DEFAULT_MAX_PIN_BYTES = 25 * 1024 * 1024;
/** Default cap for all pinned files of one call (64 MiB). */
export const DEFAULT_MAX_PIN_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_NAME_LENGTH = 128;

const VALID_MODES: ReadonlySet<string> = new Set(["bytes", "copy", "recheck"]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Error thrown by every content-pin check; `reasonCode` says which. */
export class ContentPinError extends Error {
  readonly reasonCode: ContentPinReasonCode;

  constructor(reasonCode: ContentPinReasonCode, message: string) {
    super(message);
    this.name = "ContentPinError";
    this.reasonCode = reasonCode;
  }
}

// ---------------------------------------------------------------------------
// File-system seam (internal: tests only; not exported from the package)
// ---------------------------------------------------------------------------

type FileStat = Readonly<{
  isFile(): boolean;
  size: number;
  mtimeMs: number;
}>;

/** The calls a pin makes, so a test can replace them. Not public API. */
export type ContentPinFs = Readonly<{
  constants: Readonly<Record<string, number | undefined>>;
  open(path: string, flags: number, mode?: number): Promise<number>;
  fstat(fd: number): Promise<FileStat>;
  read(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<number>;
  close(fd: number): Promise<void>;
}>;

const nodeFs: ContentPinFs = {
  constants: fsConstants as unknown as Record<string, number | undefined>,
  open: (path, flags, mode) =>
    new Promise((resolve, reject) =>
      fsOpen(path, flags, mode, (err, fd) => (err ? reject(err) : resolve(fd))),
    ),
  fstat: (fd) =>
    new Promise((resolve, reject) =>
      fsFstat(fd, (err, stat) => (err ? reject(err) : resolve(stat))),
    ),
  read: (fd, buffer, offset, length, position) =>
    new Promise((resolve, reject) =>
      fsRead(fd, buffer, offset, length, position, (err, n) =>
        err ? reject(err) : resolve(n),
      ),
    ),
  close: (fd) =>
    new Promise((resolve, reject) =>
      fsClose(fd, (err) => (err ? reject(err) : resolve())),
    ),
};

let activeFs: ContentPinFs = nodeFs;

/**
 * Tests only: replace the file-system calls (undefined restores them).
 * Not exported from the package entry point.
 */
export function setContentPinFsForTests(fs: ContentPinFs | undefined): void {
  activeFs = fs ?? nodeFs;
}

// ---------------------------------------------------------------------------
// Reading and hashing
// ---------------------------------------------------------------------------

/** Strip control and bidi characters from the basename and cap its length. */
export function pinDisplayName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const cleaned = Array.from(base)
    .filter((char) => !isHiddenControl(char.codePointAt(0)!))
    .join("");
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join("");
}

/** C0, DEL, C1 and the Unicode bidi controls. */
function isHiddenControl(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

function shortDigest(sha256: string): string {
  return `sha256:${sha256.slice(7, 19)}`;
}

function assertPlatform(fs: ContentPinFs): number {
  if (process.platform === "win32") {
    throw new ContentPinError(
      CONTENT_PIN_UNSUPPORTED_PLATFORM,
      "Content pinning is not supported on Windows; the file argument was refused",
    );
  }
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (
    typeof O_RDONLY !== "number" ||
    typeof O_NOFOLLOW !== "number" ||
    typeof O_NONBLOCK !== "number"
  ) {
    throw new ContentPinError(
      CONTENT_PIN_UNSUPPORTED_PLATFORM,
      "This platform does not provide O_NOFOLLOW; the file argument was refused",
    );
  }
  // libuv opens every descriptor close-on-exec (O_CLOEXEC), which Node does
  // not expose in fs.constants; the flag is never dropped silently.
  return O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
}

function assertAbsolute(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new ContentPinError(
      CONTENT_PIN_INVALID_ARGUMENT,
      "A pinned file path must be an absolute path (the SDK does not resolve relative paths or ~)",
    );
  }
}

type ReadLimits = Readonly<{
  /** Per-file cap. */
  maxBytes: number;
  /** What is left of the per-call cap. */
  budget?: { remaining: number };
  /** At a re-check: a size that differs is a changed file, read nothing. */
  expectedSize?: number;
}>;

type ReadResult = Readonly<{
  bytes: Uint8Array;
  size: number;
  sha256: string;
}>;

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Open (never following a final symlink, never blocking on a FIFO), require
 * a regular file, read it whole while hashing, and require the size to be
 * stable. Any other failure is CONTENT_PIN_UNREADABLE: no path from an
 * exception leads to running unpinned.
 */
async function readForPin(
  path: string,
  limits: ReadLimits,
): Promise<ReadResult> {
  const fs = activeFs;
  const flags = assertPlatform(fs);
  assertAbsolute(path);
  if (
    process.platform === "linux" &&
    (path === "/proc" ||
      path.startsWith("/proc/") ||
      path === "/sys" ||
      path.startsWith("/sys/"))
  ) {
    throw new ContentPinError(
      CONTENT_PIN_NOT_REGULAR_FILE,
      "A file under /proc or /sys cannot be pinned",
    );
  }
  let fd: number;
  try {
    fd = await fs.open(path, flags);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ELOOP" || code === "EMLINK") {
      throw new ContentPinError(
        CONTENT_PIN_NOT_REGULAR_FILE,
        "A pinned file must not be a symbolic link",
      );
    }
    throw new ContentPinError(
      CONTENT_PIN_UNREADABLE,
      `The pinned file could not be opened (${code ?? "error"})`,
    );
  }
  try {
    let first: FileStat;
    try {
      first = await fs.fstat(fd);
    } catch {
      throw new ContentPinError(
        CONTENT_PIN_UNREADABLE,
        "The pinned file could not be read",
      );
    }
    if (!first.isFile()) {
      throw new ContentPinError(
        CONTENT_PIN_NOT_REGULAR_FILE,
        "A pinned file must be a regular file (not a directory, FIFO, socket or device)",
      );
    }
    const size = first.size;
    if (limits.expectedSize !== undefined && size !== limits.expectedSize) {
      throw new ContentPinError(
        CONTENT_CHANGED_SINCE_APPROVAL,
        `The file changed since approval (size ${limits.expectedSize} → ${size})`,
      );
    }
    if (size > limits.maxBytes) {
      throw new ContentPinError(
        CONTENT_PIN_TOO_LARGE,
        `The pinned file is larger than the ${limits.maxBytes}-byte cap`,
      );
    }
    if (limits.budget !== undefined) {
      if (size > limits.budget.remaining) {
        throw new ContentPinError(
          CONTENT_PIN_TOO_LARGE,
          "The pinned files of this call are larger than the per-call cap",
        );
      }
      limits.budget.remaining -= size;
    }
    const bytes = new Uint8Array(size);
    const hash = createHash("sha256");
    let filled = 0;
    let extra = 0;
    try {
      while (filled < size) {
        const n = await fs.read(fd, bytes, filled, size - filled, filled);
        if (n <= 0) break;
        hash.update(bytes.subarray(filled, filled + n));
        filled += n;
      }
      // One more byte: a file that grew while it was read is unstable.
      extra = await fs.read(fd, new Uint8Array(1), 0, 1, size);
    } catch {
      throw new ContentPinError(
        CONTENT_PIN_UNREADABLE,
        "The pinned file could not be read",
      );
    }
    if (filled !== size || extra !== 0) {
      throw new ContentPinError(
        CONTENT_PIN_UNSTABLE,
        "The pinned file changed size while it was read",
      );
    }
    let second: FileStat;
    try {
      second = await fs.fstat(fd);
    } catch {
      throw new ContentPinError(
        CONTENT_PIN_UNREADABLE,
        "The pinned file could not be read",
      );
    }
    if (second.size !== first.size || second.mtimeMs !== first.mtimeMs) {
      throw new ContentPinError(
        CONTENT_PIN_UNSTABLE,
        "The pinned file was modified while it was read",
      );
    }
    return { bytes, size, sha256: `sha256:${hash.digest("hex")}` };
  } catch (err) {
    if (err instanceof ContentPinError) throw err;
    throw new ContentPinError(
      CONTENT_PIN_UNREADABLE,
      "The pinned file could not be read",
    );
  } finally {
    try {
      await fs.close(fd);
    } catch {
      // Closing a read-only descriptor changes nothing that was checked.
    }
  }
}

function makePinnedFile(path: string, read: ReadResult): PinnedFile {
  const name = pinDisplayName(path);
  const label = `[PinnedFile ${name} ${shortDigest(read.sha256)}…]`;
  return Object.freeze({
    path,
    name,
    bytes: read.bytes,
    size: read.size,
    sha256: read.sha256,
    toString: () => label,
    toJSON: () => ({ name, size: read.size, sha256: read.sha256 }),
  });
}

export type PinFileOptions = Readonly<{
  /** Per-file cap in bytes (default 25 MiB). */
  maxBytes?: number;
  /** A missing file yields `{ absent: true }` instead of a refusal. */
  allowAbsent?: boolean;
}>;

/**
 * Read and hash one file for a pin. The path must be absolute; a symlink,
 * directory, FIFO, socket, device, unreadable, unstable or oversized file
 * is refused (`ContentPinError` with its `reasonCode`). The bytes are not
 * kept.
 */
export async function pinFile(
  path: string,
  options: PinFileOptions = {},
): Promise<FileDigest> {
  try {
    const read = await readForPin(path, {
      maxBytes: options.maxBytes ?? DEFAULT_MAX_PIN_BYTES,
    });
    return { name: pinDisplayName(path), size: read.size, sha256: read.sha256 };
  } catch (err) {
    if (
      options.allowAbsent === true &&
      err instanceof ContentPinError &&
      err.reasonCode === CONTENT_PIN_UNREADABLE &&
      (await isAbsent(path))
    ) {
      return { absent: true };
    }
    throw err;
  }
}

async function isAbsent(path: string): Promise<boolean> {
  const fs = activeFs;
  try {
    const fd = await fs.open(path, assertPlatform(fs));
    await fs.close(fd).catch(() => undefined);
    return false;
  } catch (err) {
    return errorCode(err) === "ENOENT";
  }
}

/**
 * Check a file against its pin, just before it is used. Returns the
 * verified bytes (undefined when the pin says absent and the file is still
 * absent). A difference in size or digest, or a file that appeared or
 * disappeared, throws CONTENT_CHANGED_SINCE_APPROVAL.
 */
export async function verifyPin(
  path: string,
  pin: FileDigest,
  options: Readonly<{ maxBytes?: number }> = {},
): Promise<PinnedFile | undefined> {
  if ("absent" in pin) {
    assertPlatform(activeFs);
    assertAbsolute(path);
    if (await isAbsent(path)) return undefined;
    throw new ContentPinError(
      CONTENT_CHANGED_SINCE_APPROVAL,
      "The file changed since approval (it did not exist then and exists now)",
    );
  }
  return verifyAgainst(path, pin, {
    maxBytes: Math.max(options.maxBytes ?? DEFAULT_MAX_PIN_BYTES, pin.size),
  });
}

async function verifyAgainst(
  path: string,
  pin: Readonly<{ size: number; sha256: string }>,
  limits: ReadLimits,
): Promise<PinnedFile> {
  let read: ReadResult;
  try {
    read = await readForPin(path, { ...limits, expectedSize: pin.size });
  } catch (err) {
    if (
      err instanceof ContentPinError &&
      err.reasonCode === CONTENT_PIN_UNREADABLE &&
      (await isAbsent(path).catch(() => false))
    ) {
      throw new ContentPinError(
        CONTENT_CHANGED_SINCE_APPROVAL,
        "The file changed since approval (it no longer exists)",
      );
    }
    throw err;
  }
  if (read.size !== pin.size || read.sha256 !== pin.sha256) {
    throw new ContentPinError(
      CONTENT_CHANGED_SINCE_APPROVAL,
      `The file changed since approval (approved ${shortDigest(pin.sha256)}…, now ${shortDigest(read.sha256)}…)`,
    );
  }
  return makePinnedFile(path, read);
}

// ---------------------------------------------------------------------------
// Declarations, proposal and re-check (used by guard.ts)
// ---------------------------------------------------------------------------

export type PinLimits = Readonly<{
  maxPinBytes?: number;
  maxPinTotalBytes?: number;
}>;

function invalidDeclaration(toolName: string, detail: string): never {
  throw new ContentPinError(
    CONTENT_PIN_INVALID_ARGUMENT,
    `fileArgs for "${toolName}" ${detail}. Name each file argument with ` +
      `"bytes" (the default, also written as true or as a list of names), ` +
      `"copy" or "recheck".`,
  );
}

function assertArgName(toolName: string, arg: unknown): string {
  if (typeof arg !== "string") {
    invalidDeclaration(toolName, "lists a name that is not a string");
  }
  // "__proto__" cannot be stored as a plain own key: it would be dropped
  // and the argument would run unpinned, so it is refused like any bad name.
  if (
    arg.length === 0 ||
    arg.includes(".") ||
    arg === CONTENT_PIN_KEY ||
    arg === "__proto__"
  ) {
    throw new ContentPinError(
      CONTENT_PIN_INVALID_ARGUMENT,
      `fileArgs for "${toolName}" names "${arg}": only top-level argument names are supported`,
    );
  }
  return arg;
}

/**
 * One tool's declaration in the full form (wrap time). The short forms
 * (`true` for a mode, or a list of names) mean `bytes`; explicit modes are
 * kept as written. Throws CONTENT_PIN_INVALID_ARGUMENT for anything else.
 * Returns `undefined` for an absent declaration.
 */
export function normalizeFileArgsSpec(
  toolName: string,
  declaration: unknown,
): FileArgsSpec | undefined {
  if (declaration === undefined) return undefined;
  if (declaration === null || typeof declaration !== "object") {
    invalidDeclaration(
      toolName,
      "must be a list of argument names or map argument names to modes",
    );
  }
  const spec: Record<string, FileArgMode> = {};
  if (Array.isArray(declaration)) {
    for (const item of declaration as unknown[]) {
      const arg = assertArgName(toolName, item);
      if (Object.hasOwn(spec, arg)) {
        invalidDeclaration(toolName, `lists "${arg}" twice`);
      }
      spec[arg] = DEFAULT_FILE_ARG_MODE;
    }
    return Object.freeze(spec);
  }
  for (const [rawArg, mode] of Object.entries(declaration)) {
    const arg = assertArgName(toolName, rawArg);
    if (mode === true) {
      spec[arg] = DEFAULT_FILE_ARG_MODE;
    } else if (typeof mode === "string" && VALID_MODES.has(mode)) {
      spec[arg] = mode as FileArgMode;
    } else {
      throw new ContentPinError(
        CONTENT_PIN_INVALID_ARGUMENT,
        `fileArgs for "${toolName}.${arg}" must be "bytes", "copy" or "recheck" ` +
          `(or true, which means "bytes")`,
      );
    }
  }
  return Object.freeze(spec);
}

/** Configuration check for one tool's declaration (wrap time). */
export function assertFileArgsSpec(toolName: string, spec: unknown): void {
  normalizeFileArgsSpec(toolName, spec);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when the call's own arguments carry the reserved key. */
export function carriesReservedKey(input: unknown): boolean {
  return isPlainRecord(input) && Object.hasOwn(input, CONTENT_PIN_KEY);
}

/** The declared, present arguments of a call: arg → its paths. */
function declaredPaths(
  spec: FileArgsSpec,
  input: unknown,
): Map<string, readonly string[]> {
  const present = new Map<string, readonly string[]>();
  if (input === undefined) return present;
  if (!isPlainRecord(input)) {
    throw new ContentPinError(
      CONTENT_PIN_INVALID_ARGUMENT,
      "A tool with fileArgs must take an object of named arguments",
    );
  }
  for (const arg of Object.keys(spec).sort()) {
    if (!Object.hasOwn(input, arg) || input[arg] === undefined) continue;
    const value = input[arg];
    if (typeof value === "string") {
      present.set(arg, [value]);
    } else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      present.set(arg, value as string[]);
    } else {
      throw new ContentPinError(
        CONTENT_PIN_INVALID_ARGUMENT,
        `The file argument "${arg}" must be a path string or an array of path strings`,
      );
    }
  }
  return present;
}

/**
 * Pin every declared, present file argument of a call: read, hash and drop
 * the bytes. Returns the proposed arguments with the pins added (sorted by
 * arg, then index), or the input itself when nothing is declared.
 */
export async function pinArguments(
  spec: FileArgsSpec,
  input: unknown,
  limits: PinLimits = {},
): Promise<unknown> {
  const present = declaredPaths(spec, input);
  let count = 0;
  for (const paths of present.values()) {
    count += paths.length;
  }
  if (count > MAX_CONTENT_PINS) {
    throw new ContentPinError(
      CONTENT_PIN_TOO_MANY,
      `A call can pin at most ${MAX_CONTENT_PINS} files`,
    );
  }
  for (const paths of present.values()) {
    for (const path of paths) assertAbsolute(path);
  }
  if (present.size === 0) {
    return input;
  }
  const budget = {
    remaining: limits.maxPinTotalBytes ?? DEFAULT_MAX_PIN_TOTAL_BYTES,
  };
  const maxBytes = limits.maxPinBytes ?? DEFAULT_MAX_PIN_BYTES;
  const pins: ContentPin[] = [];
  for (const [arg, paths] of present) {
    for (const [index, path] of paths.entries()) {
      const read = await readForPin(path, { maxBytes, budget });
      pins.push(
        Object.freeze({
          arg,
          index,
          mode: spec[arg] as FileArgMode,
          name: pinDisplayName(path),
          size: read.size,
          sha256: read.sha256,
        }),
      );
    }
  }
  const proposed = {
    ...(input as Record<string, unknown>),
    [CONTENT_PIN_KEY]: Object.freeze(pins),
  };
  let measured: number;
  try {
    measured = canonicalJson(proposed).length;
  } catch {
    throw new ContentPinError(
      CONTENT_PIN_INVALID_ARGUMENT,
      "The arguments are not canonical JSON",
    );
  }
  if (measured > TOOL_ARGUMENTS_MAX_BYTES) {
    throw new ContentPinError(
      CONTENT_PIN_TOO_MANY,
      "The arguments with their content pins exceed the tool arguments limit",
    );
  }
  return Object.freeze(proposed);
}

/** The input without the reserved key (what the caller passed). */
export function withoutPins(input: unknown): unknown {
  if (!carriesReservedKey(input)) return input;
  const rest: Record<string, unknown> = {
    ...(input as Record<string, unknown>),
  };
  delete rest[CONTENT_PIN_KEY];
  return Object.freeze(rest);
}

function isPinRecord(value: unknown): value is ContentPin {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.arg === "string" &&
    typeof value.index === "number" &&
    Number.isInteger(value.index) &&
    value.index >= 0 &&
    typeof value.mode === "string" &&
    VALID_MODES.has(value.mode) &&
    typeof value.size === "number" &&
    Number.isInteger(value.size) &&
    value.size >= 0 &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256)
  );
}

export type VerifiedArguments = Readonly<{
  /** The tool's input: pins removed, declared arguments substituted. */
  toolInput: unknown;
  /** Deletes any private copy; call when the tool settles. */
  cleanup(): Promise<void>;
}>;

/**
 * The execute-time re-check, driven by the declaration (not by what the
 * input happens to carry). Every declared, present argument needs exactly
 * one matching pin per path, and nothing else may be pinned; otherwise
 * CONTENT_PIN_MISSING. Each pinned file is read again and compared;
 * a difference is CONTENT_CHANGED_SINCE_APPROVAL. Then the tool's input is
 * built: a structured clone first, then the pins removed and each declared
 * argument replaced by its `PinnedFile` (bytes) or private copy path (copy).
 */
export async function verifyArguments(
  spec: FileArgsSpec,
  input: unknown,
  limits: PinLimits = {},
): Promise<VerifiedArguments> {
  const present = declaredPaths(spec, input);
  const supplied: unknown =
    input === undefined
      ? undefined
      : (input as Record<string, unknown>)[CONTENT_PIN_KEY];
  const pins: unknown[] =
    supplied === undefined ? [] : Array.isArray(supplied) ? supplied : [null];
  const missing = (detail: string) =>
    new ContentPinError(
      CONTENT_PIN_MISSING,
      `A declared file argument has no matching content pin (${detail}); nothing ran`,
    );
  const expected = new Map<string, { arg: string; index: number }>();
  for (const [arg, paths] of present) {
    paths.forEach((_path, index) =>
      expected.set(`${arg}\u0000${index}`, { arg, index }),
    );
  }
  const matched = new Map<string, ContentPin>();
  for (const pin of pins) {
    if (!isPinRecord(pin)) throw missing("malformed pin");
    const key = `${pin.arg}\u0000${pin.index}`;
    if (!expected.has(key)) throw missing(`unexpected pin for "${pin.arg}"`);
    if (matched.has(key)) throw missing(`duplicate pin for "${pin.arg}"`);
    if (spec[pin.arg] !== pin.mode)
      throw missing(`mode of "${pin.arg}" differs`);
    matched.set(key, pin);
  }
  if (matched.size !== expected.size) {
    const absent = [...expected.keys()].find((key) => !matched.has(key));
    throw missing(`no pin for "${absent?.split("\u0000")[0] ?? "?"}"`);
  }
  const budget = {
    remaining: Math.max(
      limits.maxPinTotalBytes ?? DEFAULT_MAX_PIN_TOTAL_BYTES,
      [...matched.values()].reduce((sum, pin) => sum + pin.size, 0),
    ),
  };
  const verified = new Map<string, PinnedFile>();
  for (const [key, pin] of matched) {
    const path = present.get(pin.arg)![pin.index]!;
    verified.set(
      key,
      await verifyAgainst(path, pin, {
        maxBytes: Math.max(
          limits.maxPinBytes ?? DEFAULT_MAX_PIN_BYTES,
          pin.size,
        ),
        budget,
      }),
    );
  }
  // structuredClone first (a PinnedFile has methods and cannot be cloned),
  // then substitute.
  const toolInput: unknown = structuredClone(input);
  if (toolInput !== undefined) {
    delete (toolInput as Record<string, unknown>)[CONTENT_PIN_KEY];
  }
  const copyDirs: string[] = [];
  const cleanup = async () => {
    for (const dir of copyDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  };
  try {
    for (const [key, pin] of matched) {
      const file = verified.get(key)!;
      let value: unknown;
      if (pin.mode === "bytes") {
        value = file;
      } else if (pin.mode === "copy") {
        value = await privateCopy(file, copyDirs);
      } else {
        continue;
      }
      const record = toolInput as Record<string, unknown>;
      const original = record[pin.arg];
      if (Array.isArray(original)) {
        original[pin.index] = value;
      } else {
        record[pin.arg] = value;
      }
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { toolInput, cleanup };
}

/**
 * Write the verified bytes to a private copy (a 0700 directory, a 0600 file
 * created exclusively), check the copy's digest, and return its path.
 */
async function privateCopy(
  file: PinnedFile,
  copyDirs: string[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "guardian-pin-"));
  copyDirs.push(dir);
  const name =
    file.name.length > 0 && file.name !== "." && file.name !== ".."
      ? file.name
      : "file";
  const path = join(dir, name);
  const { O_CREAT, O_EXCL, O_WRONLY, O_NOFOLLOW } = fsConstants;
  const fd = await nodeFs.open(
    path,
    O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW,
    0o600,
  );
  try {
    let written = 0;
    while (written < file.bytes.length) {
      written += await new Promise<number>((resolve, reject) =>
        writeChunk(fd, file.bytes, written, resolve, reject),
      );
    }
  } finally {
    await nodeFs.close(fd);
  }
  await verifyAgainst(path, file, {
    maxBytes: Math.max(file.size, 1),
  });
  return path;
}

function writeChunk(
  fd: number,
  bytes: Uint8Array,
  offset: number,
  resolve: (n: number) => void,
  reject: (err: unknown) => void,
): void {
  fsWrite(fd, bytes, offset, bytes.length - offset, offset, (err, n) =>
    err ? reject(err) : resolve(n),
  );
}
