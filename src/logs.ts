import fs from "node:fs";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;

/** Strip escape codes and collapse carriage-return progress output to its final state. */
export function clean(text: string): string {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      const parts = line.replace(/\r$/, "").split("\r");
      return parts[parts.length - 1];
    })
    .join("\n");
}

export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Read bytes [from, size) of a file, capped to the last `maxBytes`. */
export function readFrom(file: string, from = 0, maxBytes = 4 * 1024 * 1024): string {
  const size = fileSize(file);
  const start = Math.max(from, size - maxBytes, 0);
  if (start >= size) return "";
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    // drop a partial first line when we started mid-file
    if (start > from && start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

export interface LogQuery {
  tail?: number;
  grep?: string;
  maxChars?: number;
}

export function queryLines(raw: string, q: LogQuery): { lines: string[]; total: number; truncated: boolean } {
  let lines = clean(raw).split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (q.grep) {
    let re: RegExp;
    try {
      re = new RegExp(q.grep, "i");
    } catch {
      re = new RegExp(q.grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    lines = lines.filter((l) => re.test(l));
  }
  const total = lines.length;
  lines = lines.slice(-(q.tail ?? 50)).map((l) => (l.length > 1000 ? l.slice(0, 1000) + " …[line truncated]" : l));
  let truncated = false;
  const maxChars = q.maxChars ?? 20_000;
  let chars = lines.reduce((n, l) => n + l.length + 1, 0);
  while (chars > maxChars && lines.length > 1) {
    chars -= lines.shift()!.length + 1;
    truncated = true;
  }
  return { lines, total, truncated };
}

/** Parse "90", "30s", "5m", "2h" into milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration "${s}" (use e.g. 30s, 5m, 1h)`);
  const n = Number(m[1]);
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "s") as "ms" | "s" | "m" | "h"];
}

/** Anything with a `test(line)` method: a RegExp, or a preset with exclusions. */
export interface LineMatcher {
  test(line: string): boolean;
}

/** Matches `include` unless the line also matches `exclude`. */
function preset(include: RegExp, exclude?: RegExp): LineMatcher & { source: string } {
  return { source: include.source, test: (line) => include.test(line) && !exclude?.test(line) };
}

/** Case-sensitive on purpose: `E[A-Z]{3,}:` should match EADDRINUSE:, not "Email:". */
export const PRESETS = {
  errors: preset(
    new RegExp(
      [
        // TypeError, ReferenceError, SomethingException: no word boundary before "Error".
        "\\b(\\w*Error|\\w*Exception|error|ERROR|exception|[Ff]atal|FATAL|[Pp]anic|PANIC|[Uu]nhandled|[Uu]ncaught|[Ff]ailed|FAILED|[Ff]ailure)\\b",
        "\\bERR_[A-Z_]+",
        "\\bE[A-Z]{3,}\\b:",
        "Cannot find module",
        "Traceback \\(most recent",
        "Segmentation fault",
        "[Ee]xit(ed)? (with )?(code|status) [1-9]",
      ].join("|"),
    ),
    // Node prints deprecation notices on stderr, and pnpm labels stderr lines "ERROR".
    /\b(Deprecation|Experimental)Warning\b|\(Use `node --trace-/,
  ),
  warnings: preset(/\b([Ww]arn(ing)?|WARN(ING)?|[Dd]eprecat(ed|ion)|DEPRECAT(ED|ION))\b|\w+Warning\b/),
} as const;

export type Preset = keyof typeof PRESETS;

export interface SearchBlock {
  /** Lines in this block: 1-based line number, text, and whether it matched. */
  lines: { n: number; text: string; match: boolean }[];
}

/** Build a case-insensitive regex; invalid patterns are searched literally. */
export function toRegex(query: string): RegExp {
  try {
    return new RegExp(query, "i");
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

/**
 * grep -C for log text: the last `limit` matches, each with `context` lines around it,
 * overlapping ranges merged. Lines before `fromLine` (1-based) are not searched; used for --since.
 */
export function searchLines(
  raw: string,
  re: LineMatcher,
  opts: { context?: number; limit?: number; fromLine?: number; maxLineLength?: number } = {},
): { blocks: SearchBlock[]; total: number } {
  const context = opts.context ?? 2;
  const limit = opts.limit ?? 20;
  const maxLen = opts.maxLineLength ?? 400;
  const lines = clean(raw).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const matches: number[] = [];
  for (let i = Math.max(0, (opts.fromLine ?? 1) - 1); i < lines.length; i++) if (re.test(lines[i])) matches.push(i);
  const shown = matches.slice(-limit);
  const hit = new Set(shown);
  const blocks: SearchBlock[] = [];
  let cur: SearchBlock | undefined;
  let end = -1;
  for (const i of shown) {
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length - 1, i + context);
    if (!cur || from > end + 1) {
      cur = { lines: [] };
      blocks.push(cur);
      end = from - 1;
    }
    for (let j = end + 1; j <= to; j++) {
      const t = lines[j];
      cur.lines.push({ n: j + 1, text: t.length > maxLen ? t.slice(0, maxLen) + " …" : t, match: hit.has(j) });
    }
    end = Math.max(end, to);
  }
  return { blocks, total: matches.length };
}

/** Line number (1-based) containing byte `offset` of `raw`. */
export function lineAtOffset(raw: string, offset: number): number {
  if (offset <= 0) return 1;
  return Buffer.from(raw).subarray(0, offset).toString("utf8").split("\n").length;
}
