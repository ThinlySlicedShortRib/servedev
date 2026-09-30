import * as React from "react"
import { ChevronDownIcon, CircleAlertIcon, TriangleAlertIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { ConfigIssue, ConfigSummary } from "@/lib/api"

const tildify = (p: string) => p.replace(/^\/Users\/[^/]+/, "~")

function where(i: ConfigIssue) {
  return `${tildify(i.file)}${i.line ? `:${i.line}${i.column ? `:${i.column}` : ""}` : ""}`
}

/**
 * Problems in config files. A syntax error never takes servers away (the last version that parsed
 * stays in use), but it's shown until fixed; warnings (a profile naming a server that doesn't
 * exist, an email in a shared file) are folded away.
 */
export function ConfigIssues({ config }: { config: ConfigSummary }) {
  const [open, setOpen] = React.useState(false)
  const errors = config.issues.filter((i) => i.level === "error")
  const warnings = config.issues.filter((i) => i.level === "warning")
  if (!errors.length && !warnings.length) return null
  const shown = errors.length ? errors : open ? warnings : []
  return (
    <Alert variant={errors.length ? "destructive" : "default"} className="m-4 mb-0 w-auto md:mx-6">
      {errors.length ? <CircleAlertIcon /> : <TriangleAlertIcon />}
      <AlertTitle className="flex items-center gap-2">
        {errors.length
          ? `${errors.length === 1 ? "A config file has" : `${errors.length} config files have`} a syntax error`
          : `${warnings.length} ${warnings.length === 1 ? "thing" : "things"} to check in your config`}
        {!errors.length && (
          <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? "Hide" : "Show"}
            <ChevronDownIcon data-icon="inline-end" className={open ? "rotate-180" : undefined} />
          </Button>
        )}
      </AlertTitle>
      <AlertDescription>
        {errors.length > 0 && <p>servedev keeps using the last version that worked until it's fixed; edits show up as soon as you save.</p>}
        {shown.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1">
            {[...shown, ...(errors.length && open ? warnings : [])].map((i, k) => (
              <li key={k} className="min-w-0 break-words">
                <span className="font-mono text-xs">{where(i)}</span> {i.message}
              </li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  )
}
