import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, printParseErrorCode, type Node, type ParseError } from "jsonc-parser";

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

/** The indentation unit a file already uses ("  " when it has none yet). */
function indentUnit(text: string): string {
  const lines = text.split("\n").map((l) => l.match(/^([ \t]+)\S/)?.[1]).filter((x): x is string => !!x);
  if (!lines.length) return "  ";
  if (lines.some((l) => l.includes("\t"))) return "\t";
  return " ".repeat(Math.min(...lines.map((l) => l.length)));
}

/** Leading whitespace of the line `offset` is on. */
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return text.slice(start).match(/^[ \t]*/)![0];
}

/**
 * JSON for `value`, formatted with `unit` and indented to continue a line indented by `indent`.
 * Short lists of plain values stay on one line (["api", "web"]), as people write them.
 */
function render(value: unknown, unit: string, indent: string): string {
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (value.every((v) => v === null || typeof v !== "object")) {
      const inline = `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
      if (inline.length <= 80) return inline;
    }
    return `[\n${value.map((v) => indent + unit + render(v, unit, indent + unit)).join(",\n")}\n${indent}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([k, v]) => `${indent}${unit}${JSON.stringify(k)}: ${render(v, unit, indent + unit)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

type Path = (string | number)[];

/**
 * Minimal edits: replace a value in place, or insert a property after the last one (after its
 * trailing comment, if any). Nothing else in the file is reformatted. Removals use jsonc-parser.
 */
function setValue(text: string, at: Path, value: unknown, unit: string): string {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  if (!tree) return JSON.stringify(value, null, unit) + "\n";
  const node = findNodeAtLocation(tree, at);
  if (node) {
    const indent = lineIndent(text, node.parent?.type === "property" ? node.parent.offset : node.offset);
    return text.slice(0, node.offset) + render(value, unit, indent) + text.slice(node.offset + node.length);
  }
  // A new property: make sure the parent object exists, then append to it.
  const parentPath = at.slice(0, -1);
  const key = at[at.length - 1];
  const parent = parentPath.length ? findNodeAtLocation(tree, parentPath) : tree;
  if (!parent || parent.type !== "object" || typeof key !== "string") {
    return applyEdits(text, modify(text, at, value, { formattingOptions: { insertSpaces: unit !== "\t", tabSize: unit === "\t" ? 1 : unit.length } }));
  }
  const props = parent.children ?? [];
  const objIndent = lineIndent(text, parent.parent?.type === "property" ? parent.parent.offset : parent.offset);
  const propIndent = props.length ? lineIndent(text, props[0].offset) : objIndent + unit;
  const entry = `${JSON.stringify(key)}: ${render(value, unit, propIndent)}`;
  if (!props.length) {
    const open = parent.offset + 1;
    const close = parent.offset + parent.length - 1;
    return `${text.slice(0, open)}\n${propIndent}${entry}\n${objIndent}${text.slice(close)}`;
  }
  const last: Node = props[props.length - 1];
  const end = last.offset + last.length;
  const rest = text.slice(end);
  const comma = /^\s*,/.test(rest.replace(/^[ \t]*\/\*.*?\*\//, "")) ? "" : ",";
  // Insert after the rest of the last property's line (keeps a trailing "// comment" with it),
  // unless the object closes on that same line.
  const lineEnd = text.indexOf("\n", end);
  const sameLineClose = text.slice(end, lineEnd < 0 ? undefined : lineEnd).includes("}");
  if (sameLineClose || lineEnd < 0) return `${text.slice(0, end)}${comma} ${entry}${rest}`;
  const trailing = text.slice(end, lineEnd);
  const trailingComma = /,/.test(trailing.replace(/\/\/.*$|\/\*.*?\*\//g, ""));
  const head = trailingComma ? text.slice(0, lineEnd) : text.slice(0, end) + comma + trailing;
  return `${head}\n${propIndent}${entry}${text.slice(lineEnd)}`;
}

function removeValue(text: string, at: Path): string {
  return applyEdits(text, modify(text, at, undefined, {}));
}

/**
 * Rewrite `text` so it parses to `after`, touching only what changed from `before`: objects are
 * compared key by key, anything else (arrays included) is replaced where it differs.
 */
export function applyChanges(text: string, before: unknown, after: unknown): string {
  const unit = indentUnit(text);
  if (!text.trim() || !isPlainObject(before)) return render(after, unit, "") + "\n";
  let out = text;
  const walk = (at: Path, b: unknown, a: unknown) => {
    if (deepEqual(b, a)) return;
    if (isPlainObject(b) && isPlainObject(a)) {
      for (const key of Object.keys(b)) if (!(key in a) || a[key] === undefined) out = removeValue(out, [...at, key]);
      for (const [key, value] of Object.entries(a)) if (value !== undefined) walk([...at, key], b[key], value);
      return;
    }
    out = setValue(out, at, a, unit);
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
