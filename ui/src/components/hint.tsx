import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type Side = "top" | "bottom" | "left" | "right"

/** A tooltip explaining what a control does. The child (a button, link or trigger) is the trigger. */
export function Hint({ label, side, children }: { label: React.ReactNode; side?: Side; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} className="max-w-xs text-pretty">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Text that truncates with an ellipsis and shows the full text in a tooltip, only when it's
 * actually cut off.
 */
export function TruncatedText({
  text,
  className,
  children,
  side,
}: {
  text: string
  className?: string
  /** What to render, when it differs from the plain text (e.g. highlighted). */
  children?: React.ReactNode
  side?: Side
}) {
  const [cut, setCut] = React.useState(false)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("truncate", className)}
            onPointerEnter={(e) => setCut(e.currentTarget.scrollWidth > e.currentTarget.clientWidth + 1)}
          />
        }
      >
        {children ?? text}
      </TooltipTrigger>
      {cut && (
        <TooltipContent side={side} className="max-w-md break-words">
          {text}
        </TooltipContent>
      )}
    </Tooltip>
  )
}
