import { KeyRoundIcon } from "@/components/icons"

import { Hint } from "@/components/hint"
import { useAccountsContext } from "@/hooks/use-accounts"
import { describeSelections } from "@/lib/accounts"
import type { Server } from "@/lib/api"
import { cn } from "@/lib/utils"

/** The accounts a server runs with, when a profile picked them instead of this machine's. */
export function AccountTag({ server: s, className }: { server: Server; className?: string }) {
  const { providers } = useAccountsContext()
  if (!s.accounts) return null
  const text = describeSelections(s.accounts.selections, providers)
  const label = `Runs with ${s.accounts.profile.name}'s accounts: ${text}.${s.accountsStale ? " The profile changed since it started; restart to apply." : ""}`
  return (
    <Hint label={label}>
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-sm border px-1 py-px text-[10px] leading-none text-muted-foreground",
        s.accountsStale && "border-amber-500/50 text-amber-700 dark:text-amber-400 terminal:border-warning/50 terminal:text-warning terminal:dark:text-warning",
        className
      )}
    >
      <KeyRoundIcon className="size-3 shrink-0" aria-label="accounts" />
      <span className="truncate">{text}</span>
    </span>
    </Hint>
  )
}
