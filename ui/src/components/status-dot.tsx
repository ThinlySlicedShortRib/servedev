import { cn } from "@/lib/utils"
import type { Status } from "@/lib/api"

export function StatusDot({ status, className }: { status: Status | "idle"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "running" && "bg-emerald-500",
        (status === "starting" || status === "stopping") && "animate-pulse bg-amber-500 motion-reduce:animate-none",
        status === "crashed" && "bg-destructive",
        (status === "stopped" || status === "exited") && "bg-muted-foreground/40",
        status === "idle" && "border border-muted-foreground/60",
        className
      )}
    />
  )
}
