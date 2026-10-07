/** Case-insensitive, global; an invalid regex is searched as plain text. */
export function searchRegex(query: string): RegExp | null {
  if (!query) return null
  try {
    return new RegExp(query, "gi")
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
  }
}

export function lineMatches(re: RegExp, line: string): boolean {
  re.lastIndex = 0
  const m = re.exec(line)
  return !!m && m[0].length > 0
}

/** Scroll a line into the middle of its own scroll container, without scrolling the page around it. */
export function scrollToLine(container: HTMLElement | null | undefined, index: number) {
  const el = container?.querySelector<HTMLElement>(`[data-line="${index}"]`)
  if (!container || !el) return
  const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  container.scrollTop = top - container.clientHeight / 2 + el.offsetHeight / 2
}
