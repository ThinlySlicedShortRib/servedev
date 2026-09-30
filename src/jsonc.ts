import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type FormattingOptions, type ParseError } from "jsonc-parser";

/**
 * Config files are JSONC (JSON with comments and trailing commas). Edits go through
 * jsonc-parser's `modify`, one small change at a time, so comments, key order and formatting
 * elsewhere in the file survive a write from the dashboard.
 */

export interface ParseIssue {
  line: number;
  column: number;
  message: string;
}

/** 1-based line and column of an offset. */
function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

/** Parse JSONC; the first syntax error (with its line) when it isn't valid. */
export function parseJsonc(text: string): { data: unknown; error?: ParseIssue } {
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true });
  if (errors.length) {
    const e = errors[0];
    return { data: undefined, error: { ...position(text, e.offset), message: printParseErrorCode(e.error).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() } };
  }
  return { data: data ?? {} };
}

export const hashText = (text: string) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The indentation a file already uses ("  " when it has none yet). */
function formatting(text: string): FormattingOptions {
  const indent = text.match(/^([ \t]+)(?=["}\]])/m)?.[1] ?? "  ";
  return { insertSpaces: !indent.includes("\t"), tabSize: indent.includes("\t") ? 1 : indent.length, eol: "\n" };
}

/**
 * Rewrite `text` so it parses to `after`, touching only what changed from `before`: objects are
 * compared key by key, anything else (arrays included) is replaced where it differs.
 */
export function applyChanges(text: string, before: unknown, after: unknown): string {
  const options = formatting(text);
  if (!text.trim() || !isPlainObject(before)) {
    return JSON.stringify(after, null, options.insertSpaces ? " ".repeat(options.tabSize ?? 2) : "\t") + "\n";
  }
  let out = text;
  const walk = (at: (string | number)[], b: unknown, a: unknown) => {
    if (deepEqual(b, a)) return;
    if (isPlainObject(b) && isPlainObject(a)) {
      for (const key of Object.keys(b)) if (!(key in a) || a[key] === undefined) out = applyEdits(out, modify(out, [...at, key], undefined, { formattingOptions: options }));
      for (const [key, value] of Object.entries(a)) if (value !== undefined) walk([...at, key], b[key], value);
      return;
    }
    out = applyEdits(out, modify(out, at, a, { formattingOptions: options }));
  };
  walk([], before, after);
  return out.endsWith("\n") ? out : out + "\n";
}

/** Write via a temp file and rename, so readers (and editors) never see half a file. */
export function writeAtomic(file: string, text: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let keep = mode;
  try {
    keep ??= fs.statSync(file).mode & 0o777;
  } catch {}
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.servedev-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, { mode: keep ?? 0o644 });
  if (keep !== undefined) fs.chmodSync(tmp, keep);
  fs.renameSync(tmp, file);
}
