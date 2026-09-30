import { GitBranchIcon } from "lucide-react"

import { TruncatedText } from "@/components/hint"
import { cn } from "@/lib/utils"

/** The git branch a server's folder has checked out; long names show in full on hover. */
export function BranchTag({ branch, className }: { branch: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-sm border px-1 py-px font-mono text-[10px] leading-none font-normal text-muted-foreground",
        className
      )}
    >
      <GitBranchIcon className="size-3 shrink-0" aria-label="branch" />
      <TruncatedText text={branch} />
    </span>
  )
}
