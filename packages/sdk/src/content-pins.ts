// Generated file — do not edit.
import { createHash } from "node:crypto";
import {
  close as fsClose,
  constants as fsConstants,
  fstat as fsFstat,
  open as fsOpen,
  read as fsRead,
  readlink as fsReadlink,
  realpath as fsRealpath,
  stat as fsStat,
  write as fsWrite,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  CONTENT_PIN_MODES,
  CONTENT_PINS_ARGUMENT,
  CONTENT_PINS_MAX,
  isContentPinRecord,
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

/** The reserved argument key that carries the pins (shared with contracts). */
export const CONTENT_PIN_KEY = CONTENT_PINS_ARGUMENT;

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
 * The object form of one file argument: a mode (default `bytes`) and,
 * opt-in, a preview for the approver (`preview: true`). See
 * `ContentPinPreview` for what a preview holds and sends.
 */
export type FileArgOptions = Readonly<{
  mode?: FileArgMode;
  preview?: boolean;
  /**
   * Only with `preview: true`: absolute folders a previewed file must be in
   * (after symbolic links are resolved). A file outside every folder gets a
   * `withheld` preview: no content, only its size. Without this, a preview
   * is made for any file the agent names in that argument and the process
   * can read.
   */
  previewRoots?: readonly string[];
}>;

/**
 * What a developer may write for one tool's file arguments:
 * - the full form, `{ attachmentPath: "copy" }` (a mode per argument);
 * - `true` in place of a mode, `{ attachmentPath: true }`, meaning `bytes`;
 * - a list of argument names, `["attachmentPath"]`, each meaning `bytes`;
 * - the object form, `{ attachmentPath: { mode: "bytes", preview: true } }`,
 *   the only form that turns on a preview (the others never do).
 * The forms are normalized to `FileArgsSpec` at wrap time; anything else
 * (an unknown mode, `false`, an empty or repeated name, a preview that is
 * not a boolean, an unknown key) is refused there.
 */
export type FileArgsDeclaration =
  | FileArgsSpec
  | readonly string[]
  | Readonly<Record<string, FileArgMode | true | FileArgOptions>>;

/**
 * A preview of a pinned file for the person who approves, computed on the
 * agent's machine from the same bytes that are hashed. Display data only:
 * nothing in Guardian's decision path reads it, and the re-check before
 * the tool runs compares the hash, not the preview.
 *
 * - `text`: the file is valid UTF-8 with no NUL byte and its extension is
 *   not a known binary type. `text` holds its first 20 lines, at most
 *   2,048 UTF-8 bytes, cut on a character boundary; `truncated` says
 *   whether anything was left out. Control characters other than tab and
 *   newline, direction-changing (bidi) characters and zero-width
 *   characters are replaced with U+FFFD; CRLF line ends become LF and a
 *   leading byte-order mark is dropped.
 * - `binary`: anything else (pdf, images, archives, office files, other
 *   encodings). No content, only the media type and the size.
 * - `withheld`: the argument names `previewRoots` and the file is not in
 *   any of them. No content and no media type, only the size.
 */
export type ContentPinPreview =
  | Readonly<{
      kind: "text";
      mediaType: string;
      size: number;
      text: string;
      truncated: boolean;
    }>
  | Readonly<{ kind: "binary"; mediaType: string; size: number }>
  | Readonly<{ kind: "withheld"; size: number }>;

/** One pin, as it appears in the proposed arguments. */
export type ContentPin = Readonly<{
  arg: string;
  index: number;
  mode: FileArgMode;
  name: string;
  size: number;
  sha256: string;
  /** Only for an argument declared with `preview: true`. */
  preview?: ContentPinPreview;
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
export const MAX_CONTENT_PINS = CONTENT_PINS_MAX;
/** Default cap per pinned file (25 MiB). */
export const DEFAULT_MAX_PIN_BYTES = 25 * 1024 * 1024;
/** Default cap for all pinned files of one call (64 MiB). */
export const DEFAULT_MAX_PIN_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_NAME_LENGTH = 128;
/** A text preview holds at most this many lines. */
export const PREVIEW_MAX_LINES = 20;
/** A text preview holds at most this many UTF-8 bytes. */
export const PREVIEW_MAX_BYTES = 2048;
/** At most this many `previewRoots` per file argument. */
export const PREVIEW_MAX_ROOTS = 16;

const VALID_MODES: ReadonlySet<string> = CONTENT_PIN_MODES;

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
  /**
   * The resolved path of the open file (only asked for when the argument
   * names `previewRoots`). Missing or failing means "not known", and the
   * preview is withheld.
   */
  resolvedPath?(fd: number, path: string): Promise<string>;
  /** The resolved path of a `previewRoots` folder (same rule). */
  realpath?(path: string): Promise<string>;
}>;

/**
 * Resolve `path` again and return it only if it names the same file as the
 * open descriptor `fd` (same device and inode). Used where the OS cannot
 * name a descriptor directly. Exported for tests.
 */
export function resolvePathOfOpenFile(
  fd: number,
  path: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    fsRealpath.native(path, (err, target) => {
      if (err) return reject(err);
      fsStat(target, { bigint: true }, (statErr, byPath) => {
        if (statErr) return reject(statErr);
        fsFstat(fd, { bigint: true }, (fstatErr, byFd) => {
          if (fstatErr) return reject(fstatErr);
          if (byPath.dev !== byFd.dev || byPath.ino !== byFd.ino) {
            return reject(new Error("resolved path is not the file read"));
          }
          resolve(target);
        });
      });
    });
  });
}

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
  // On Linux, the kernel's own name for the descriptor that was read: the
  // file the bytes came from, whatever happened to the path since.
  // Elsewhere there is no such name, so the path is resolved again and the
  // result is only trusted when it is the very file that was read (same
  // device and inode as the open descriptor). A link swapped between the
  // read and the check therefore fails, and the preview is withheld.
  resolvedPath: (fd, path) =>
    new Promise((resolve, reject) => {
      if (process.platform === "linux") {
        fsReadlink(`/proc/self/fd/${fd}`, (err, target) =>
          err ? reject(err) : resolve(target),
        );
        return;
      }
      resolvePathOfOpenFile(fd, path).then(resolve, reject);
    }),
  realpath: (path) =>
    new Promise((resolve, reject) =>
      fsRealpath.native(path, (err, target) =>
        err ? reject(err) : resolve(target),
      ),
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
  /** Also return the resolved path of the file that was read. */
  resolve?: boolean;
}>;

type ReadResult = Readonly<{
  bytes: Uint8Array;
  size: number;
  sha256: string;
  /** Only when asked for (`resolve`) and known. */
  resolvedPath?: string;
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
    let resolvedPath: string | undefined;
    if (limits.resolve === true && fs.resolvedPath !== undefined) {
      try {
        resolvedPath = await fs.resolvedPath(fd, path);
      } catch {
        resolvedPath = undefined;
      }
    }
    return {
      bytes,
      size,
      sha256: `sha256:${hash.digest("hex")}`,
      ...(resolvedPath === undefined ? {} : { resolvedPath }),
    };
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
// Preview (display data for the approver, opt-in per argument)
// ---------------------------------------------------------------------------

/** Extensions whose files are previewed as text when their bytes allow. */
const TEXT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/jsonl",
  ndjson: "application/x-ndjson",
  md: "text/markdown",
  markdown: "text/markdown",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  env: "text/plain",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  svg: "image/svg+xml",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  py: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  kt: "text/x-kotlin",
  swift: "text/x-swift",
  c: "text/x-c",
  h: "text/x-c",
  cc: "text/x-c++",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  cs: "text/x-csharp",
  php: "text/x-php",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  sql: "application/sql",
};

/** Extensions that are never previewed as text, whatever their bytes. */
const BINARY_MEDIA_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/vnd.microsoft.icon",
  heic: "image/heic",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  bz2: "application/x-bzip2",
  xz: "application/x-xz",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  wasm: "application/wasm",
  exe: "application/vnd.microsoft.portable-executable",
  bin: "application/octet-stream",
};

const OCTET_STREAM = "application/octet-stream";

/** The lower-case extension of a file name ("" when it has none). */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Characters a preview never shows as themselves: C0 controls other than
 * tab and newline, DEL, C1, the bidi marks, embeddings, overrides and
 * isolates, zero-width and invisible format characters, the line and
 * paragraph separators and the byte-order mark.
 */
function isPreviewHidden(cp: number): boolean {
  return (
    (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x061c ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

function utf8Length(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The preview of a file's bytes (the same bytes that were hashed; nothing
 * is read again). `name` is the file's display name, used only for its
 * extension. Deterministic: the Python SDK computes the same preview.
 */
export function contentPreview(
  name: string,
  bytes: Uint8Array,
): ContentPinPreview {
  const size = bytes.length;
  const ext = extensionOf(name);
  const binary = (mediaType: string): ContentPinPreview =>
    Object.freeze({ kind: "binary", mediaType, size });
  if (Object.hasOwn(BINARY_MEDIA_TYPES, ext)) {
    return binary(BINARY_MEDIA_TYPES[ext]!);
  }
  if (bytes.includes(0)) return binary(OCTET_STREAM);
  let decoded: string;
  try {
    decoded = STRICT_UTF8.decode(bytes);
  } catch {
    return binary(OCTET_STREAM);
  }
  const mediaType = Object.hasOwn(TEXT_MEDIA_TYPES, ext)
    ? TEXT_MEDIA_TYPES[ext]!
    : "text/plain";
  // Walk the decoded string by code point and stop at the caps, so a large
  // file never costs more than the preview it produces.
  const str = decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;
  let text = "";
  let used = 0;
  let lines = 0;
  let truncated = false;
  let idx = 0;
  while (idx < str.length) {
    const cp = str.codePointAt(idx)!;
    const width = cp > 0xffff ? 2 : 1;
    // CRLF counts as one line end.
    if (cp === 0x0d && str.charCodeAt(idx + 1) === 0x0a) {
      idx += 1;
      continue;
    }
    const shown = isPreviewHidden(cp) ? 0xfffd : cp;
    const length = utf8Length(shown);
    if (used + length > PREVIEW_MAX_BYTES) {
      truncated = true;
      break;
    }
    text += String.fromCodePoint(shown);
    used += length;
    idx += width;
    if (cp === 0x0a) {
      lines += 1;
      if (lines === PREVIEW_MAX_LINES) {
        truncated = idx < str.length;
        break;
      }
    }
  }
  return Object.freeze({
    kind: "text",
    mediaType,
    size,
    text,
    truncated,
  });
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
      `"copy" or "recheck", or with { mode, preview: true } for a preview.`,
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

type ParsedDeclaration = Readonly<{
  spec: FileArgsSpec;
  /** The arguments declared with `preview: true`, sorted. */
  preview: readonly string[];
  /** The `previewRoots` of the arguments that name them (normalized). */
  previewRoots: Readonly<Record<string, readonly string[]>>;
}>;

/**
 * One `previewRoots` entry in its normal form: absolute, no `.` or `..`
 * segment, no NUL, repeated slashes collapsed and no trailing slash (except
 * for `/` itself). Returns undefined for anything else.
 */
function normalizePreviewRoot(root: unknown): string | undefined {
  if (typeof root !== "string" || !root.startsWith("/")) return undefined;
  if (root.includes("\0") || root.length > 4096) return undefined;
  const segments = root.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  return `/${segments.join("/")}`;
}

function parsePreviewRoots(
  toolName: string,
  arg: string,
  roots: unknown,
): readonly string[] {
  if (
    !Array.isArray(roots) ||
    roots.length === 0 ||
    roots.length > PREVIEW_MAX_ROOTS
  ) {
    invalidEntry(
      toolName,
      arg,
      `previewRoots must be a list of 1 to ${PREVIEW_MAX_ROOTS} absolute folder paths`,
    );
  }
  const out = new Set<string>();
  for (const root of roots as unknown[]) {
    const normal = normalizePreviewRoot(root);
    if (normal === undefined) {
      invalidEntry(
        toolName,
        arg,
        "previewRoots must hold absolute folder paths (no . or .. segments)",
      );
    }
    out.add(normal);
  }
  return Object.freeze([...out].sort());
}

function invalidEntry(toolName: string, arg: string, detail: string): never {
  throw new ContentPinError(
    CONTENT_PIN_INVALID_ARGUMENT,
    `fileArgs for "${toolName}.${arg}" ${detail}`,
  );
}

function parseDeclaration(
  toolName: string,
  declaration: unknown,
): ParsedDeclaration | undefined {
  if (declaration === undefined) return undefined;
  if (declaration === null || typeof declaration !== "object") {
    invalidDeclaration(
      toolName,
      "must be a list of argument names or map argument names to modes",
    );
  }
  const spec: Record<string, FileArgMode> = {};
  const preview: string[] = [];
  const previewRoots: Record<string, readonly string[]> = {};
  if (Array.isArray(declaration)) {
    for (const item of declaration as unknown[]) {
      const arg = assertArgName(toolName, item);
      if (Object.hasOwn(spec, arg)) {
        invalidDeclaration(toolName, `lists "${arg}" twice`);
      }
      spec[arg] = DEFAULT_FILE_ARG_MODE;
    }
    return {
      spec: Object.freeze(spec),
      preview: Object.freeze(preview),
      previewRoots: Object.freeze(previewRoots),
    };
  }
  for (const [rawArg, mode] of Object.entries(declaration)) {
    const arg = assertArgName(toolName, rawArg);
    if (mode === true) {
      spec[arg] = DEFAULT_FILE_ARG_MODE;
    } else if (typeof mode === "string" && VALID_MODES.has(mode)) {
      spec[arg] = mode as FileArgMode;
    } else if (isPlainRecord(mode)) {
      const unknownKey = Object.keys(mode).find(
        (key) => key !== "mode" && key !== "preview" && key !== "previewRoots",
      );
      if (unknownKey !== undefined) {
        invalidEntry(
          toolName,
          arg,
          `has an unknown key "${unknownKey}" (only "mode", "preview" and "previewRoots")`,
        );
      }
      const named = mode.mode;
      if (
        named !== undefined &&
        !(typeof named === "string" && VALID_MODES.has(named))
      ) {
        invalidEntry(
          toolName,
          arg,
          `mode must be "bytes", "copy" or "recheck"`,
        );
      }
      if (mode.preview !== undefined && typeof mode.preview !== "boolean") {
        invalidEntry(toolName, arg, "preview must be true or false");
      }
      if (mode.previewRoots !== undefined) {
        if (mode.preview !== true) {
          invalidEntry(toolName, arg, "previewRoots needs preview: true");
        }
        previewRoots[arg] = parsePreviewRoots(toolName, arg, mode.previewRoots);
      }
      spec[arg] = (named as FileArgMode | undefined) ?? DEFAULT_FILE_ARG_MODE;
      if (mode.preview === true) preview.push(arg);
    } else {
      invalidEntry(
        toolName,
        arg,
        `must be "bytes", "copy" or "recheck" (or true, which means ` +
          `"bytes", or { mode, preview })`,
      );
    }
  }
  return {
    spec: Object.freeze(spec),
    preview: Object.freeze(preview.sort()),
    previewRoots: Object.freeze(previewRoots),
  };
}

/**
 * One tool's declaration in the full form (wrap time). The short forms
 * (`true` for a mode, or a list of names) mean `bytes`; explicit modes are
 * kept as written; the object form gives its mode (default `bytes`).
 * Throws CONTENT_PIN_INVALID_ARGUMENT for anything else. Returns
 * `undefined` for an absent declaration. A preview is not part of the
 * full form: see `normalizeFileArgPreviews`.
 */
export function normalizeFileArgsSpec(
  toolName: string,
  declaration: unknown,
): FileArgsSpec | undefined {
  return parseDeclaration(toolName, declaration)?.spec;
}

/**
 * The arguments of one tool's declaration that ask for a preview (only
 * the object form with `preview: true`), sorted. Throws like
 * `normalizeFileArgsSpec` for an invalid declaration.
 */
export function normalizeFileArgPreviews(
  toolName: string,
  declaration: unknown,
): readonly string[] {
  return parseDeclaration(toolName, declaration)?.preview ?? [];
}

/**
 * The `previewRoots` of one tool's declaration, per argument (absolute,
 * normalized, sorted; only arguments that name them). Throws like
 * `normalizeFileArgsSpec` for an invalid declaration.
 */
export function normalizeFileArgPreviewRoots(
  toolName: string,
  declaration: unknown,
): Readonly<Record<string, readonly string[]>> {
  return parseDeclaration(toolName, declaration)?.previewRoots ?? {};
}

/**
 * One tool's declaration in a canonical form that keeps the preview: the
 * full form, with `{ mode, preview: true }` (and its `previewRoots`, if
 * any) for an argument that asks for a preview. `normalizeFileArgsSpec`
 * reads it back unchanged.
 */
export function canonicalFileArgsDeclaration(
  toolName: string,
  declaration: unknown,
): FileArgsDeclaration | undefined {
  const parsed = parseDeclaration(toolName, declaration);
  if (parsed === undefined) return undefined;
  if (parsed.preview.length === 0) return parsed.spec;
  const out: Record<string, FileArgMode | FileArgOptions> = {};
  for (const [arg, mode] of Object.entries(parsed.spec)) {
    const roots = parsed.previewRoots[arg];
    out[arg] = parsed.preview.includes(arg)
      ? Object.freeze(
          roots === undefined
            ? { mode, preview: true }
            : { mode, preview: true, previewRoots: roots },
        )
      : mode;
  }
  return Object.freeze(out);
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
 * True when `resolvedPath` is one of `roots` or inside one of them (both
 * already resolved; plain string comparison on whole path segments).
 */
export function isUnderPreviewRoots(
  resolvedPath: string,
  roots: readonly string[],
): boolean {
  return roots.some(
    (root) =>
      root === "/" ||
      resolvedPath === root ||
      resolvedPath.startsWith(`${root}/`),
  );
}

/** The roots with their symbolic links resolved; a root that fails is dropped. */
async function resolveRoots(
  roots: readonly string[],
): Promise<readonly string[]> {
  const fs = activeFs;
  const out: string[] = [];
  for (const root of roots) {
    if (fs.realpath === undefined) continue;
    try {
      out.push(await fs.realpath(root));
    } catch {
      // A folder that cannot be resolved holds no previewed file.
    }
  }
  return out;
}

/**
 * Pin every declared, present file argument of a call: read, hash and drop
 * the bytes. Returns the proposed arguments with the pins added (sorted by
 * arg, then index), or the input itself when nothing is declared. An
 * argument in `preview` also gets a `preview` in its pin, computed from
 * the same bytes that were hashed; when it also has `previewRoots`, a file
 * that is not in one of them (symbolic links resolved) gets a `withheld`
 * preview with its size only.
 */
export async function pinArguments(
  spec: FileArgsSpec,
  input: unknown,
  limits: PinLimits = {},
  preview: readonly string[] = [],
  previewRoots: Readonly<Record<string, readonly string[]>> = {},
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
  const resolvedRoots = new Map<string, readonly string[]>();
  for (const [arg, paths] of present) {
    const roots = preview.includes(arg)
      ? Object.hasOwn(previewRoots, arg)
        ? previewRoots[arg]
        : undefined
      : undefined;
    if (roots !== undefined && !resolvedRoots.has(arg)) {
      resolvedRoots.set(arg, await resolveRoots(roots));
    }
    for (const [index, path] of paths.entries()) {
      const read = await readForPin(path, {
        maxBytes,
        budget,
        resolve: roots !== undefined,
      });
      const name = pinDisplayName(path);
      pins.push(
        Object.freeze({
          arg,
          index,
          mode: spec[arg] as FileArgMode,
          name,
          size: read.size,
          sha256: read.sha256,
          ...(preview.includes(arg)
            ? {
                preview:
                  roots === undefined ||
                  (read.resolvedPath !== undefined &&
                    isUnderPreviewRoots(
                      read.resolvedPath,
                      resolvedRoots.get(arg) ?? [],
                    ))
                    ? contentPreview(name, read.bytes)
                    : Object.freeze({
                        kind: "withheld" as const,
                        size: read.size,
                      }),
              }
            : {}),
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
      pins.some((pin) => pin.preview !== undefined)
        ? "The arguments with their content pins and previews exceed the tool arguments limit; preview fewer files"
        : "The arguments with their content pins exceed the tool arguments limit",
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

/** The one pin validator, shared with Guardian (contracts/tools.ts). */
function isPinRecord(value: unknown): value is ContentPin {
  return isContentPinRecord(value);
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
