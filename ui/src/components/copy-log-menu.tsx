import { BotIcon, ChevronDownIcon, CopyIcon, ListFilterIcon, ScrollTextIcon } from "@/components/icons"
import { toast } from "sonner"

import { Hint } from "@/components/hint"
import { searchRegex } from "@/components/log-search"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { copyText, lineCount } from "@/lib/clipboard"

async function copy(text: string, what: string) {
  try {
    await copyText(text)
    const n = lineCount(text)
    toast.success(`Copied ${what}`, { description: `${n} ${n === 1 ? "line" : "lines"}` })
  } catch (e) {
    toast.error("Couldn't copy", { description: (e as Error).message })
  }
}

/** Copy the log: all of it, the lines matching the search, or wrapped with server details for pasting to an agent. */
export function CopyLogMenu({
  text,
  query,
  serverId,
  command,
  runLabel,
}: {
  /** The run's full, cleaned log. */
  text: string
  query: string
  serverId?: string
  command?: string
  runLabel: string
}) {
  const log = text.replace(/\n+$/, "")
  const re = searchRegex(query)
  const matching = re
    ? log
        .split("\n")
        .filter((l) => {
          re.lastIndex = 0
          return re.test(l)
        })
        .join("\n")
    : ""

  const forAgent = [
    `Logs from dev server ${serverId ?? ""}${command ? ` (\`${command}\`)` : ""}, ${runLabel.toLowerCase()}:`,
    "",
    "```",
    log,
    "```",
  ].join("\n")

  return (
    <DropdownMenu>
      <Hint label="Copy this log to the clipboard: all of it, only the lines matching your search, or ready to paste to an agent">
        <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={!log} />}>
          <CopyIcon data-icon="inline-start" />
          Copy
          <ChevronDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuItem onClick={() => copy(log, "the log")}>
          <ScrollTextIcon />
          Copy log
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{lineCount(log)} lines</span>
        </DropdownMenuItem>
        {re && (
          <DropdownMenuItem disabled={!matching} onClick={() => copy(matching, `lines matching "${query}"`)}>
            <ListFilterIcon />
            Copy matching lines
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">{lineCount(matching)}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => copy(forAgent, "the log for an agent")}>
          <BotIcon />
          Copy for an agent
          <span className="ml-auto text-xs text-muted-foreground">with server details</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
