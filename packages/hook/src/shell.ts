/**
 * A small POSIX-shell reader for routing commands. It is not an
 * interpreter: it splits a command line into simple commands (on `;`, `&`,
 * `&&`, `||`, `|`, newlines and subshells), removes quoting and escapes,
 * collects `$( )`, backtick and `<( )` substitutions, output redirections and
 * here-documents, and reports when it cannot follow the text (an unterminated
 * quote or substitution). Routing then looks at every simple command.
 */

export type Word = {
  /** The word with quotes and escapes removed; expansions are left as text. */
  value: string;
  /** Contains a `$` or backtick expansion that is not single-quoted. */
  dynamic: boolean;
  /** Commands inside `$( )`, backticks, `<( )` and `>( )` in this word. */
  subs: Parsed[];
};

export type SimpleCommand = {
  words: Word[];
  /** Targets of `>`, `>>`, `>|`, `&>`, `<>` (not fd duplications). */
  writes: Word[];
  /** Commands joined by `|` share a pipeline; `stage` is their position. */
  pipeline: number;
  stage: number;
  /** Substitutions in here-strings and unquoted here-document bodies. */
  subs: Parsed[];
};

export type Parsed = {
  commands: SimpleCommand[];
  /** The parser could not follow the text; the caller must fail closed. */
  ambiguous: boolean;
};

const MAX_NESTING = 16;

type State = {
  src: string;
  pos: number;
  ambiguous: boolean;
  nesting: number;
  /** Here-documents waiting for the next newline. */
  heredocs: { delimiter: string; stripTabs: boolean; quoted: boolean }[];
  /** Commands found in unquoted here-document bodies. */
  bodySubs: Parsed[];
};

const isBlank = (c: string) => c === " " || c === "\t";
const OPERATOR_START = new Set([";", "&", "|", "\n", "(", ")", "<", ">"]);

export function parseShell(src: string): Parsed {
  const st: State = {
    src,
    pos: 0,
    ambiguous: false,
    nesting: 0,
    heredocs: [],
    bodySubs: [],
  };
  const parsed = parseList(st, false);
  if (st.pos < src.length) st.ambiguous = true;
  if (st.bodySubs.length > 0) {
    parsed.commands.push(bodyCommand(st.bodySubs));
  }
  return {
    commands: parsed.commands,
    ambiguous: st.ambiguous || parsed.ambiguous,
  };
}

function bodyCommand(subs: Parsed[]): SimpleCommand {
  return { words: [], writes: [], pipeline: -1, stage: 0, subs };
}

/** Parse until end of input, or (when `inSub`) the `)` that closes `$(`. */
function parseList(st: State, inSub: boolean): Parsed {
  const commands: SimpleCommand[] = [];
  let pipeline = 0;
  let stage = 0;
  let words: Word[] = [];
  let writes: Word[] = [];
  let depth = 0;
  let pendingWrite = false;
  let pendingHeredoc: { stripTabs: boolean } | null = null;
  let pendingHereString = false;

  const endCommand = (nextIsPipe: boolean) => {
    if (words.length > 0 || writes.length > 0) {
      commands.push({ words, writes, pipeline, stage, subs: [] });
    }
    words = [];
    writes = [];
    if (nextIsPipe) stage++;
    else {
      pipeline++;
      stage = 0;
    }
  };

  const { src } = st;
  while (st.pos < src.length) {
    const c = src[st.pos]!;
    if (isBlank(c)) {
      st.pos++;
      continue;
    }
    if (c === "\\" && src[st.pos + 1] === "\n") {
      st.pos += 2;
      continue;
    }
    if (c === "#") {
      while (st.pos < src.length && src[st.pos] !== "\n") st.pos++;
      continue;
    }
    if (c === "\n") {
      st.pos++;
      endCommand(false);
      readHeredocBodies(st);
      continue;
    }
    if (c === ";" || c === "&" || c === "|") {
      const two = src.slice(st.pos, st.pos + 2);
      if (c === "&" && (src[st.pos + 1] === ">")) {
        // `&>file` / `&>>file`
        st.pos += src[st.pos + 2] === ">" ? 3 : 2;
        pendingWrite = true;
        continue;
      }
      if (two === "&&" || two === "||" || two === ";;" || two === "|&") {
        st.pos += 2;
        endCommand(two === "|&");
        continue;
      }
      st.pos++;
      endCommand(c === "|");
      continue;
    }
    if (c === "(") {
      st.pos++;
      depth++;
      endCommand(false);
      continue;
    }
    if (c === ")") {
      if (depth > 0) {
        st.pos++;
        depth--;
        endCommand(false);
        continue;
      }
      if (inSub) {
        endCommand(false);
        return { commands, ambiguous: false };
      }
      st.pos++;
      st.ambiguous = true;
      endCommand(false);
      continue;
    }
    if (c === "<" || c === ">") {
      // Process substitution is a word.
      if (src[st.pos + 1] === "(") {
        const w = readWord(st);
        if (w) addWord(w);
        continue;
      }
      const op = /^(<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/.exec(src.slice(st.pos))![0];
      st.pos += op.length;
      if (op === "<<" || op === "<<-") pendingHeredoc = { stripTabs: op === "<<-" };
      else if (op === "<<<") pendingHereString = true;
      else if (op === ">&" || op === "<&") {
        // `2>&1` duplicates a descriptor; `>& file` writes to a file.
        const m = /^[ \t]*([0-9]+|-)(?=[\s;&|)<>]|$)/.exec(src.slice(st.pos));
        if (m) st.pos += m[0].length;
        else if (op === ">&") pendingWrite = true;
      } else if (op !== "<") pendingWrite = true;
      continue;
    }
    const w = readWord(st);
    if (!w) continue;
    addWord(w);
  }
  if (inSub) st.ambiguous = true; // `$(` never closed
  if (depth > 0) st.ambiguous = true;
  endCommand(false);
  return { commands, ambiguous: false };

  function addWord(w: Word & { quoted: boolean }) {
    if (pendingHeredoc) {
      st.heredocs.push({
        delimiter: w.value,
        stripTabs: pendingHeredoc.stripTabs,
        quoted: w.quoted,
      });
      pendingHeredoc = null;
      return;
    }
    if (pendingHereString) {
      pendingHereString = false;
      collectSubs(w);
      return;
    }
    if (pendingWrite) {
      pendingWrite = false;
      // A file descriptor number written just before `>` (`2>`) is not a word.
      writes.push(w);
      return;
    }
    // `2>file`: the digits before the operator are a descriptor, not a word.
    const next = src[st.pos];
    if (/^[0-9]+$/.test(w.value) && !w.quoted && (next === ">" || next === "<")) {
      return;
    }
    words.push(w);
  }

  function collectSubs(w: Word) {
    if (w.subs.length > 0) {
      commands.push({ words: [], writes: [], pipeline: -1, stage: 0, subs: w.subs });
    }
  }
}

/** After a newline: skip the bodies of here-documents opened on that line. */
function readHeredocBodies(st: State) {
  while (st.heredocs.length > 0) {
    const doc = st.heredocs.shift()!;
    const lines: string[] = [];
    let found = false;
    while (st.pos < st.src.length) {
      let end = st.src.indexOf("\n", st.pos);
      if (end < 0) end = st.src.length;
      const raw = st.src.slice(st.pos, end);
      st.pos = Math.min(end + 1, st.src.length);
      const line = doc.stripTabs ? raw.replace(/^\t+/, "") : raw;
      if (line === doc.delimiter) {
        found = true;
        break;
      }
      lines.push(raw);
    }
    void found; // bash runs an unterminated here-document to end of input
    if (!doc.quoted) {
      // Unquoted bodies expand `$( )` and backticks.
      const body = lines.join("\n");
      if (/\$\(|`/.test(body)) {
        const inner: State = { ...st, src: body, pos: 0, heredocs: [], bodySubs: [] };
        const w = readDoubleQuotedBody(inner);
        st.ambiguous ||= inner.ambiguous;
        if (w.subs.length > 0) st.bodySubs.push(...w.subs);
      }
    }
  }
}

/** Expand a here-document body like the inside of double quotes. */
function readDoubleQuotedBody(st: State): Word {
  const word: Word = { value: "", dynamic: false, subs: [] };
  while (st.pos < st.src.length) {
    const c = st.src[st.pos]!;
    if (c === "\\") {
      st.pos += 2;
      continue;
    }
    if (c === "$" || c === "`") {
      readExpansion(st, word);
      continue;
    }
    st.pos++;
  }
  return word;
}

/** Reads one word at `st.pos`. Returns null if nothing was read. */
function readWord(st: State): (Word & { quoted: boolean }) | null {
  const { src } = st;
  const word: Word & { quoted: boolean } = {
    value: "",
    dynamic: false,
    subs: [],
    quoted: false,
  };
  const start = st.pos;
  while (st.pos < src.length) {
    const c = src[st.pos]!;
    if (isBlank(c) || c === "\n") break;
    if ((c === "<" || c === ">") && src[st.pos + 1] === "(") {
      // Process substitution `<( … )`: its output is a file path.
      st.pos += 2;
      word.dynamic = true;
      word.subs.push(parseNested(st));
      continue;
    }
    if (OPERATOR_START.has(c)) break;
    if (c === "\\") {
      if (st.pos + 1 < src.length) {
        if (src[st.pos + 1] !== "\n") word.value += src[st.pos + 1];
        st.pos += 2;
      } else {
        st.pos++;
      }
      word.quoted = true;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", st.pos + 1);
      if (end < 0) {
        st.ambiguous = true;
        word.value += src.slice(st.pos + 1);
        st.pos = src.length;
        break;
      }
      word.value += src.slice(st.pos + 1, end);
      st.pos = end + 1;
      word.quoted = true;
      continue;
    }
    if (c === '"') {
      st.pos++;
      word.quoted = true;
      let closed = false;
      while (st.pos < src.length) {
        const d = src[st.pos]!;
        if (d === '"') {
          st.pos++;
          closed = true;
          break;
        }
        if (d === "\\") {
          const n = src[st.pos + 1];
          if (n === undefined) {
            st.pos++;
            continue;
          }
          if ("$`\"\\\n".includes(n)) {
            if (n !== "\n") word.value += n;
          } else {
            word.value += d + n;
          }
          st.pos += 2;
          continue;
        }
        if (d === "$" || d === "`") {
          readExpansion(st, word);
          continue;
        }
        word.value += d;
        st.pos++;
      }
      if (!closed) st.ambiguous = true;
      continue;
    }
    if (c === "$" && src[st.pos + 1] === "'") {
      // ANSI-C quoting `$'…'`: decode the common escapes.
      let i = st.pos + 2;
      let out = "";
      let closed = false;
      while (i < src.length) {
        const d = src[i]!;
        if (d === "'") {
          closed = true;
          i++;
          break;
        }
        if (d === "\\" && i + 1 < src.length) {
          const n = src[i + 1]!;
          const simple: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", "'": "'", '"': '"' };
          if (simple[n] !== undefined) {
            out += simple[n];
            i += 2;
            continue;
          }
          const hex = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(i + 1));
          if (hex) {
            out += String.fromCharCode(parseInt(hex[1]!, 16));
            i += 1 + hex[0].length;
            continue;
          }
          const oct = /^([0-7]{1,3})/.exec(src.slice(i + 1));
          if (oct) {
            out += String.fromCharCode(parseInt(oct[1]!, 8));
            i += 1 + oct[0].length;
            continue;
          }
          // Other escapes (\u, \c…) are not decoded here: fail closed.
          st.ambiguous = true;
          out += n;
          i += 2;
          continue;
        }
        out += d;
        i++;
      }
      if (!closed) st.ambiguous = true;
      word.value += out;
      word.quoted = true;
      st.pos = i;
      continue;
    }
    if (c === "$" || c === "`") {
      readExpansion(st, word);
      continue;
    }
    word.value += c;
    st.pos++;
  }
  return st.pos > start ? word : null;
}

/** `$( … )`, `$(( … ))`, `${ … }`, `$name`, backticks. Appends to `word`. */
function readExpansion(st: State, word: Word) {
  const { src } = st;
  const c = src[st.pos]!;
  if (c === "`") {
    // Backticks: find the closing one (backslash escapes it).
    let i = st.pos + 1;
    let inner = "";
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\" && i + 1 < src.length) {
        inner += src[i + 1];
        i += 2;
        continue;
      }
      inner += src[i];
      i++;
    }
    if (i >= src.length) st.ambiguous = true;
    word.value += "`" + inner + "`";
    word.dynamic = true;
    word.subs.push(parseString(st, inner));
    st.pos = Math.min(i + 1, src.length);
    return;
  }
  const n = src[st.pos + 1];
  if (n === "(" && src[st.pos + 2] === "(") {
    // Arithmetic: skip to the matching `))`.
    let i = st.pos + 3;
    let level = 2;
    while (i < src.length && level > 0) {
      if (src[i] === "(") level++;
      else if (src[i] === ")") level--;
      i++;
    }
    if (level > 0) st.ambiguous = true;
    word.value += src.slice(st.pos, i);
    word.dynamic = true;
    st.pos = i;
    return;
  }
  if (n === "(") {
    const start = st.pos;
    st.pos += 2;
    word.subs.push(parseNested(st));
    word.value += src.slice(start, st.pos);
    word.dynamic = true;
    return;
  }
  if (n === "{") {
    let i = st.pos + 2;
    let level = 1;
    while (i < src.length && level > 0) {
      if (src[i] === "{") level++;
      else if (src[i] === "}") level--;
      i++;
    }
    if (level > 0) st.ambiguous = true;
    const text = src.slice(st.pos, i);
    word.value += text;
    word.dynamic = true;
    // `${x:-$(cmd)}` runs cmd.
    if (/\$\(|`/.test(text)) {
      word.subs.push(parseString(st, text.slice(2, -1)));
    }
    st.pos = i;
    return;
  }
  const name = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(st.pos));
  if (name) {
    word.value += name[0];
    word.dynamic = true;
    st.pos += name[0].length;
    return;
  }
  word.value += "$";
  st.pos++;
}

/** Parses from `st.pos` to the `)` that closes a `$(` or `<(`. */
function parseNested(st: State): Parsed {
  if (st.nesting >= MAX_NESTING) {
    st.ambiguous = true;
    st.pos = st.src.length;
    return { commands: [], ambiguous: true };
  }
  st.nesting++;
  const savedHeredocs = st.heredocs;
  st.heredocs = [];
  const inner = parseList(st, true);
  st.heredocs = savedHeredocs;
  st.nesting--;
  if (st.src[st.pos] === ")") st.pos++;
  else st.ambiguous = true;
  return inner;
}

function parseString(st: State, text: string): Parsed {
  if (st.nesting >= MAX_NESTING) {
    st.ambiguous = true;
    return { commands: [], ambiguous: true };
  }
  const inner: State = {
    src: text,
    pos: 0,
    ambiguous: false,
    nesting: st.nesting + 1,
    heredocs: [],
    bodySubs: [],
  };
  const parsed = parseList(inner, false);
  if (inner.bodySubs.length) parsed.commands.push(bodyCommand(inner.bodySubs));
  st.ambiguous ||= inner.ambiguous;
  return { commands: parsed.commands, ambiguous: inner.ambiguous };
}
