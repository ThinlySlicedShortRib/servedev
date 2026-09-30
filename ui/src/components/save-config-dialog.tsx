import * as React from "react"
import { ShieldIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { api, type ConfigPlan, type Server } from "@/lib/api"

const show = (v: unknown) => (v === undefined ? "" : JSON.stringify(v))

/** One line per change; env is compared variable by variable so a long map stays readable. */
function changeLines(changes: ConfigPlan["changes"]): { text: string; kind: "add" | "remove" | "change" }[] {
  return changes.flatMap((c) => {
    if (c.key === "env") {
      const before = (c.before ?? {}) as Record<string, string>
      const after = (c.after ?? {}) as Record<string, string>
      return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((k) =>
        before[k] === after[k]
          ? []
          : [
              k in after
                ? { text: `${k in before ? "~" : "+"} env ${k}=${after[k]}`, kind: k in before ? ("change" as const) : ("add" as const) }
                : { text: `- env ${k}`, kind: "remove" as const },
            ]
      )
    }
    if (c.before === undefined) return [{ text: `+ ${c.key}: ${show(c.after)}`, kind: "add" as const }]
    if (c.after === undefined) return [{ text: `- ${c.key}: ${show(c.before)}`, kind: "remove" as const }]
    return [{ text: `~ ${c.key}: ${show(c.before)}\n    → ${show(c.after)}`, kind: "change" as const }]
  })
}

/**
 * Preview, then write a server into its repo's servedev.json. Replacing an entry that differs is
 * spelled out on the button, since it overwrites what the repo has.
 */
export function SaveConfigDialog({ server: s, open, onOpenChange }: { server: Server; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [includeSecrets, setIncludeSecrets] = React.useState(false)
  const [loaded, setLoaded] = React.useState<{ key: string; plan?: ConfigPlan; error?: string } | null>(null)
  const [saving, setSaving] = React.useState(false)
  const key = `${s.id}:${includeSecrets}:${s.config}`
  const plan = loaded?.key === key ? loaded.plan : undefined
  const error = loaded?.key === key ? loaded.error : undefined

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    api<ConfigPlan>(`/api/config?${new URLSearchParams({ id: s.id, includeSecrets: includeSecrets ? "1" : "0" })}`)
      .then((p) => !cancelled && setLoaded({ key, plan: p }))
      .catch((e) => !cancelled && setLoaded({ key, error: (e as Error).message }))
    return () => {
      cancelled = true
    }
  }, [open, key, s.id, includeSecrets])

  async function save(e: React.MouseEvent) {
    e.preventDefault()
    if (!plan) return
    setSaving(true)
    try {
      await api("/api/config", { id: s.id, force: plan.state === "differs", includeSecrets })
      toast.success(`Saved ${s.name} to servedev.json`, { description: `Commit ${plan.file} to share it; teammates run servedev up.` })
      onOpenChange(false)
    } catch (err) {
      toast.error("Couldn't save to servedev.json", { description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const replacing = plan?.state === "differs"
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{replacing ? "Update servedev.json" : "Save to servedev.json"}</AlertDialogTitle>
          <AlertDialogDescription>
            Writes how to run {s.name} into its repo, so it's shared through git: anyone who clones it can run <code className="font-mono">servedev up</code>.
            Only variables set on purpose are written, never your whole environment.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : !plan ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Checking servedev.json…
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-xs break-all text-muted-foreground">
              {plan.file}
              {plan.exists ? "" : " (new file)"}
            </p>
            {plan.state === "defined" ? (
              <p className="text-sm">It's already defined there exactly like this. Nothing to change.</p>
            ) : (
              <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all" aria-label="Changes">
                {changeLines(plan.changes).map((l) => (
                  <div key={l.text} className={l.kind === "add" ? "text-emerald-700 dark:text-emerald-400" : l.kind === "remove" ? "text-destructive" : undefined}>
                    {l.text}
                  </div>
                ))}
              </pre>
            )}
            {plan.removed.length > 0 && (
              <Alert>
                <ShieldIcon />
                <AlertTitle>Credentials removed from the command</AlertTitle>
                <AlertDescription>
                  {plan.removed.join(", ")}. They'd be committed to git and expire anyway; servers get credentials from accounts (e.g. Google app
                  credentials) or .env instead.
                </AlertDescription>
              </Alert>
            )}
            {(plan.rewritten.length > 0 || plan.warnings.length > 0) && (
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                {plan.rewritten.map((r) => (
                  <li key={r} className="break-all">
                    Made portable: <span className="font-mono">{r}</span>
                  </li>
                ))}
                {plan.warnings.map((w) => (
                  <li key={w} className="break-all text-amber-700 dark:text-amber-400">
                    {w}
                  </li>
                ))}
              </ul>
            )}
            {replacing && (
              <Alert>
                <TriangleAlertIcon />
                <AlertTitle>servedev.json already defines {s.name} differently</AlertTitle>
                <AlertDescription>Saving replaces those settings with this server's. Other servers and keys like dependsOn stay as they are.</AlertDescription>
              </Alert>
            )}
            {(plan.omittedSecrets.length > 0 || includeSecrets) && (
              <Field orientation="horizontal">
                <Checkbox id="include-secrets" checked={includeSecrets} onCheckedChange={(v) => setIncludeSecrets(!!v)} />
                <FieldLabel htmlFor="include-secrets" className="font-normal">
                  <span>
                    Also write {includeSecrets ? "secret-looking variables" : plan.omittedSecrets.join(", ")}.{" "}
                    <span className="text-muted-foreground">They'd be committed to git; a .env file is usually better.</span>
                  </span>
                </FieldLabel>
              </Field>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={save} disabled={!plan || plan.state === "defined" || saving}>
            {saving && <Spinner data-icon="inline-start" />}
            {replacing ? "Replace in servedev.json" : "Save to servedev.json"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
