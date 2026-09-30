/** Copy text to the clipboard; falls back to a hidden textarea where the async API isn't available. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // fall through
  }
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.style.position = "fixed"
  ta.style.opacity = "0"
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand("copy")
  ta.remove()
  if (!ok) throw new Error("the browser blocked clipboard access")
}

export const lineCount = (text: string) => (text ? text.replace(/\n$/, "").split("\n").length : 0)
