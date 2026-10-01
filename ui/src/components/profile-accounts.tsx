import * as React from "react"
import { CircleAlertIcon } from "lucide-react"

import { AccountPicker } from "@/components/account-picker"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { useAccountsContext, useFieldOptions } from "@/hooks/use-accounts"
import { runAccountAction } from "@/lib/accounts"
import { api, type AccountField, type AccountProvider, type Selections } from "@/lib/api"

/**
 * The accounts a profile's servers use instead of this machine's, for every provider that can set
 * them per process. Checks the picks as they change, so a missing credential shows up here rather
 * than as a failed start.
 */
export function ProfileAccounts({
  value,
  onChange,
  defaults,
  check,
  legend = "Accounts",
  description = "Servers in this profile use these instead of this machine's accounts; this machine stays as it is. Changes apply when they next start.",
}: {
  value: Selections
  onChange: (v: Selections) => void
  /** Values used when a field has no pick, e.g. what a shared profile's repo asks for. */
  defaults?: Selections
  /** What to check for problems (defaults plus picks); `value` when omitted. */
  check?: Selections
  legend?: string
  description?: string
}) {
  const { providers } = useAccountsContext()
  const usable = (providers ?? []).filter((p) => p.perProfile)
  const checked_ = check ?? value
  const key = JSON.stringify(checked_)
  // The check result for the picks it was made for; stale results are ignored.
  const [checked, setChecked] = React.useState<{ key: string; error?: string } | null>(null)
  const problem = Object.keys(checked_).length && checked?.key === key ? (checked.error ?? null) : null

  React.useEffect(() => {
    if (!Object.keys(checked_).length) return
    let cancelled = false
    const t = setTimeout(() => {
      api<{ error?: string }>("/api/accounts/check", { accounts: checked_ })
        .then((r) => !cancelled && setChecked({ key, error: r.error }))
        .catch(() => {})
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, providers])

  if (!usable.length) return null

  function set(provider: string, field: string, v: string | undefined) {
    const sel = { ...(value[provider] ?? {}) }
    if (v) sel[field] = v
    else delete sel[field]
    const next = { ...value }
    if (Object.keys(sel).length) next[provider] = sel
    else delete next[provider]
    onChange(next)
  }

  const fixFor = problem ? usable.find((p) => problem.startsWith(p.name)) : undefined
  const signIn = fixFor?.actions.find((a) => a.interactive)

  return (
    <FieldSet>
      <FieldLegend variant="label">{legend}</FieldLegend>
      <FieldDescription>{description}</FieldDescription>
      <div className="flex flex-col gap-4">
        {usable.map((p) => (
          <ProviderPicks
            key={p.id}
            provider={p}
            selection={value[p.id] ?? {}}
            defaults={defaults?.[p.id] ?? {}}
            onSet={(f, v) => set(p.id, f, v)}
          />
        ))}
        {problem && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription className="flex flex-col items-start gap-2 [overflow-wrap:anywhere]">
              {problem}
              {fixFor && signIn && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="h-auto max-w-full py-1 text-left whitespace-normal"
                  onClick={() => runAccountAction(fixFor, signIn.id, checked_[fixFor.id] ?? {}).then(() => setChecked(null))}
                >
                  {signIn.label}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </FieldSet>
  )
}

function ProviderPicks({
  provider: p,
  selection,
  defaults,
  onSet,
}: {
  provider: AccountProvider
  selection: Record<string, string>
  defaults: Record<string, string>
  onSet: (field: string, value: string | undefined) => void
}) {
  return (
    <FieldGroup className="gap-2 rounded-lg border p-3">
      <span className="text-sm font-medium">{p.name}</span>
      {p.fields.map((f) => (
        <FieldPick key={f.id} provider={p} field={f} selection={selection} fallback={defaults[f.id]} onSet={(v) => onSet(f.id, v)} />
      ))}
    </FieldGroup>
  )
}

function FieldPick({
  provider: p,
  field: f,
  selection,
  fallback,
  onSet,
}: {
  provider: AccountProvider
  field: AccountField
  selection: Record<string, string>
  /** Used when nothing is picked (the repo's value for a shared profile). */
  fallback?: string
  onSet: (value: string | undefined) => void
}) {
  // Other fields' picks can change the options (a different account sees different projects).
  const others = Object.fromEntries(Object.entries(selection).filter(([k]) => k !== f.id))
  const dependent = Object.keys(others).length > 0
  const options = useFieldOptions(p.id, f.id, others, f.options, dependent)
  const id = `profile-acct-${p.id}-${f.id}`
  return (
    <Field orientation="responsive" className="gap-1">
      <FieldLabel htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {f.label}
      </FieldLabel>
      <AccountPicker
        id={id}
        options={options}
        value={selection[f.id]}
        onChange={onSet}
        freeform={f.freeform}
        defaultLabel={fallback ? `Repo's: ${fallback}` : `Default${f.current ? ` (this machine: ${f.current})` : ""}`}
      />
    </Field>
  )
}
