/**
 * Group log lines into entries: a line plus the lines that continue it (indented fields of a
 * structured log, stack frames, closing brackets). Task prefixes like turbo's "@keel/web:dev: "
 * are ignored when deciding.
 */
const TASK_PREFIX = /^[\w@/.-]+:[\w:.-]+: /

function body(line: string): string {
  return line.replace(TASK_PREFIX, "")
}

export function isContinuation(line: string): boolean {
  const b = body(line)
  if (b.trim() === "") return false
  // Two or more spaces (or a tab): tools like Next.js start ordinary lines with a single space.
  return /^( {2,}|\t)/.test(b) || /^\s?(at |Caused by:|\.\.\. \d+ more)/.test(b) || /^[}\])]/.test(b)
}

/** First and last line index of the entry containing line `i`. */
export function entryBounds(lines: string[], i: number): [number, number] {
  if (lines[i] === undefined || lines[i].trim() === "") return [i, i]
  let start = i
  while (start > 0 && isContinuation(lines[start]) && lines[start - 1].trim() !== "") start--
  let end = i
  while (end + 1 < lines.length && isContinuation(lines[end + 1])) end++
  return [start, end]
}
