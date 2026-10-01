import * as React from "react"
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon, FlaskConicalIcon, PlusIcon, Trash2Icon } from "@/components/icons"
import { toast } from "sonner"

import { Hint } from "@/components/hint"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DialogFooter } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api, type CatalogEntry, type ProviderSpec, type SpecTest } from "@/lib/api"
import { emptyField, fieldSlug, formIssues, slug, toForm, toSpec, type EnvRow, type FieldRow, type ProviderForm as Form } from "@/lib/provider-spec"

/**
 * Write or edit a JSON account provider: which CLI it needs, what the user picks (each with a
 * list / current / switch command), and the env a profile's servers get. "Test" runs the list and
 * current commands without saving; nothing is ever switched until the provider is used.
 */
export function ProviderForm({
  initial,
  editing,
  catalog,
  onSaved,
}: {
  initial?: ProviderSpec
  /** Editing an added provider: saving replaces its file. */
  editing?: boolean
  /** Entries to start from, when creating. */
  catalog?: CatalogEntry[]
  onSaved: (spec: ProviderSpec) => void
}) {
  const [form, setForm] = React.useState<Form>(() => toForm(initial))
  const [jsonMode, setJsonMode] = React.useState(false)
  const [jsonText, setJsonText] = React.useState("")
  const [jsonError, setJsonError] = React.useState<string | null>(null)
  const [test, setTest] = React.useState<{ key: string; result: SpecTest } | null>(null)
  const [testing, setTesting] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<{ message: string; override?: boolean } | null>(null)

  const spec = React.useMemo<ProviderSpec | null>(() => {
    if (!jsonMode) return toSpec(form)
    try {
      return JSON.parse(jsonText) as ProviderSpec
    } catch {
      return null
    }
  }, [jsonMode, form, jsonText])
  const specKey = JSON.stringify(spec)
  const issues = jsonMode ? (jsonError ? [jsonError] : []) : formIssues(form)
  const placeholders = form.fields.map((f) => f.id.trim()).filter(Boolean)

  const update = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))
  const updateField = (key: string, patch: Partial<FieldRow>) =>
    setForm((f) => ({ ...f, fields: f.fields.map((x) => (x.key === key ? { ...x, ...patch } : x)) }))
  const updateEnv = (key: string, patch: Partial<EnvRow>) => setForm((f) => ({ ...f, env: f.env.map((x) => (x.key === key ? { ...x, ...patch } : x)) }))

  function toggleJson(on: boolean) {
    if (on) {
      setJsonText(JSON.stringify(toSpec(form), null, 2))
      setJsonError(null)
      setJsonMode(true)
      return
    }
    try {
      setForm(toForm(JSON.parse(jsonText) as ProviderSpec))
      setJsonMode(false)
      setJsonError(null)
    } catch (e) {
      setJsonError(`Fix the JSON before going back to the form: ${(e as Error).message}`)
    }
  }

  function onJsonChange(text: string) {
    setJsonText(text)
    try {
      JSON.parse(text)
      setJsonError(null)
    } catch (e) {
      setJsonError(`Not valid JSON: ${(e as Error).message}`)
    }
  }

  function startFrom(id: string) {
    const entry = catalog?.find((e) => e.spec.id === id)
    if (!entry) return
    setForm(toForm(entry.spec))
    setJsonText(JSON.stringify(entry.spec, null, 2))
    setJsonError(null)
    setTest(null)
    setError(null)
  }

  async function runTest() {
    if (!spec) return
    setTesting(true)
    try {
      setTest({ key: specKey, result: await api<SpecTest>("/api/accounts/test", { spec }) })
    } catch (e) {
      toast.error("Couldn't run the test", { description: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  async function save(override = false) {
    if (!spec) return
    setSaving(true)
    setError(null)
    try {
      const r = await api<{ spec: ProviderSpec; file: string; installed: boolean }>("/api/accounts/providers", { spec, replace: editing, override })
      toast.success(`${editing ? "Saved" : "Added"} ${r.spec.name}`, {
        description: r.installed ? r.file : `Saved to ${r.file}. It shows up once ${r.spec.requires ?? "its CLI"} is installed.`,
      })
      onSaved(r.spec)
    } catch (e) {
      const message = (e as Error).message
      setError({ message, override: /built-in provider/.test(message) })
    } finally {
      setSaving(false)
    }
  }

  const stale = test && test.key !== specKey

  return (
    <div className="flex min-h-0 flex-1 flex-col">
    <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-2 pb-6">
      {!editing && !!catalog?.length && !jsonMode && (
        <Field orientation="responsive">
          <FieldLabel>Start from</FieldLabel>
          <Select
            items={[{ value: "", label: "A blank provider" }, ...catalog.map((e) => ({ value: e.spec.id, label: e.spec.name }))]}
            defaultValue=""
            onValueChange={(v) => v && startFrom(String(v))}
          >
            <SelectTrigger className="w-full sm:w-64" aria-label="Start from a catalog entry">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">A blank provider</SelectItem>
              {catalog.map((e) => (
                <SelectItem key={e.spec.id} value={e.spec.id}>
                  {e.spec.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {jsonMode ? "The provider as it's saved: ~/.servedev/providers/<id>.json." : "Describe how its CLI lists, shows and switches accounts."}
        </p>
        <Field orientation="horizontal" className="w-auto shrink-0">
          <Switch id="provider-json" checked={jsonMode} onCheckedChange={toggleJson} />
          <FieldLabel htmlFor="provider-json" className="font-normal">
            Edit as JSON
          </FieldLabel>
        </Field>
      </div>

      {jsonMode ? (
        <Field data-invalid={!!jsonError || undefined}>
          <Textarea
            value={jsonText}
            onChange={(e) => onJsonChange(e.target.value)}
            rows={20}
            spellCheck={false}
            aria-label="Provider JSON"
            aria-invalid={!!jsonError || undefined}
            className="font-mono text-xs"
          />
          {jsonError && <FieldDescription className="text-destructive">{jsonError}</FieldDescription>}
        </Field>
      ) : (
        <>
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="provider-name">Name</FieldLabel>
              <Input
                id="provider-name"
                value={form.name}
                placeholder="Fly.io"
                onChange={(e) => update({ name: e.target.value, id: form.idTouched ? form.id : slug(e.target.value) })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-id">Id</FieldLabel>
              <Input
                id="provider-id"
                value={form.id}
                placeholder="fly"
                disabled={editing}
                className="font-mono"
                onChange={(e) => update({ id: e.target.value, idTouched: true })}
              />
              <FieldDescription>Used in commands and profiles, e.g. servedev account {form.id || "fly"}.</FieldDescription>
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="provider-description">Description</FieldLabel>
              <Input
                id="provider-description"
                value={form.description}
                placeholder="The flyctl account apps deploy with."
                onChange={(e) => update({ description: e.target.value })}
              />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="provider-requires">CLI it needs</FieldLabel>
              <Input
                id="provider-requires"
                value={form.requires}
                placeholder="flyctl"
                className="font-mono"
                onChange={(e) => update({ requires: e.target.value })}
              />
              <FieldDescription>The provider only shows up when this command is installed. Leave empty to always show it.</FieldDescription>
            </Field>
          </FieldGroup>

          <FieldSet>
            <FieldLegend variant="label">What you pick</FieldLegend>
            <FieldDescription>
              Usually one field, like an account or a context. Commands run with /bin/sh. A list command prints one option per line: the value, then
              optionally a tab and a label, and a tab and a detail.
            </FieldDescription>
            <div className="flex flex-col gap-3">
              {form.fields.map((f, i) => (
                <FieldEditor
                  key={f.key}
                  row={f}
                  index={i}
                  others={placeholders.filter((p) => p !== f.id.trim())}
                  onChange={(patch) => updateField(f.key, patch)}
                  onRemove={form.fields.length > 1 ? () => update({ fields: form.fields.filter((x) => x.key !== f.key) }) : undefined}
                />
              ))}
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => update({ fields: [...form.fields, emptyField()] })}>
                <PlusIcon data-icon="inline-start" />
                Add field
              </Button>
            </div>
          </FieldSet>

          <FieldSet>
            <FieldLegend variant="label">Environment for a profile's servers</FieldLegend>
            <FieldDescription>
              How a server uses the account a profile picks, e.g. AWS_PROFILE = {"{profile}"}. Values are inserted as is; with "Run as command",
              the command's output is the value (for tokens, fetched fresh at every start). Leave this empty if the CLI can't be pointed at an
              account per process: then it can only be switched machine-wide.
              {placeholders.length > 0 && <> Placeholders: {placeholders.map((p) => `{${p}}`).join(", ")}.</>}
            </FieldDescription>
            <div className="flex flex-col gap-2">
              {form.env.map((e) => (
                <div key={e.key} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center">
                  <Input
                    value={e.name}
                    placeholder="AWS_PROFILE"
                    aria-label="Variable name"
                    className="font-mono sm:w-44"
                    onChange={(ev) => updateEnv(e.key, { name: ev.target.value })}
                  />
                  <Input
                    value={e.value}
                    placeholder={e.fromCommand ? "fly auth token" : `{${placeholders[0] ?? "account"}}`}
                    aria-label={e.fromCommand ? "Command whose output is the value" : "Value"}
                    className="min-w-0 flex-1 font-mono"
                    onChange={(ev) => updateEnv(e.key, { value: ev.target.value })}
                  />
                  <div className="flex items-center justify-between gap-3 sm:justify-start">
                    <Field orientation="horizontal" className="w-auto">
                      <Switch id={`${e.key}-cmd`} checked={e.fromCommand} onCheckedChange={(v) => updateEnv(e.key, { fromCommand: v })} />
                      <FieldLabel htmlFor={`${e.key}-cmd`} className="font-normal whitespace-nowrap">
                        Run as command
                      </FieldLabel>
                    </Field>
                    <Hint label="Remove this variable">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove this variable"
                        onClick={() => update({ env: form.env.filter((x) => x.key !== e.key) })}
                      >
                        <Trash2Icon />
                      </Button>
                    </Hint>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => update({ env: [...form.env, { key: `env-${Date.now()}`, name: "", value: "", fromCommand: false }] })}
              >
                <PlusIcon data-icon="inline-start" />
                Add variable
              </Button>
            </div>
          </FieldSet>
        </>
      )}

      {test && <TestResults result={test.result} stale={!!stale} />}

      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Couldn't save</AlertTitle>
          <AlertDescription className="break-words">{error.message}</AlertDescription>
          {error.override && (
            <AlertAction>
              <Button type="button" size="xs" variant="outline" onClick={() => void save(true)}>
                Replace the built-in one
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}

    </div>
      <DialogFooter className="items-stretch sm:items-center">
        {issues.length > 0 && <p className="order-last text-xs text-muted-foreground sm:order-first sm:mr-auto">{issues[0]}</p>}
        <Hint label="Run the list and current commands and preview the environment, without saving or switching anything">
          <Button type="button" variant="outline" onClick={() => void runTest()} disabled={!spec || testing || issues.length > 0}>
            {testing ? <Spinner data-icon="inline-start" /> : <FlaskConicalIcon data-icon="inline-start" />}
            Test
          </Button>
        </Hint>
        <Button type="button" onClick={() => void save()} disabled={!spec || saving || issues.length > 0}>
          {saving && <Spinner data-icon="inline-start" />}
          {editing ? "Save changes" : "Add platform"}
        </Button>
      </DialogFooter>
    </div>
  )
}

function FieldEditor({
  row: f,
  index,
  others,
  onChange,
  onRemove,
}: {
  row: FieldRow
  index: number
  others: string[]
  onChange: (patch: Partial<FieldRow>) => void
  onRemove?: () => void
}) {
  const id = f.id.trim() || "value"
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${f.key}-label`}>Label</FieldLabel>
            <Input
              id={`${f.key}-label`}
              value={f.label}
              placeholder={index === 0 ? "Account" : "Organization"}
              onChange={(e) => onChange({ label: e.target.value, id: f.idTouched ? f.id : fieldSlug(e.target.value) })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${f.key}-id`}>Placeholder</FieldLabel>
            <Input
              id={`${f.key}-id`}
              value={f.id}
              placeholder="account"
              className="font-mono"
              onChange={(e) => onChange({ id: e.target.value, idTouched: true })}
            />
          </Field>
        </div>
        {onRemove && (
          <Hint label="Remove this field">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove this field" onClick={onRemove} className="mt-6">
              <Trash2Icon />
            </Button>
          </Hint>
        )}
      </div>
      <Field>
        <FieldLabel htmlFor={`${f.key}-list`}>List command</FieldLabel>
        <Input
          id={`${f.key}-list`}
          value={f.list}
          placeholder="docker context ls --format '{{.Name}}'"
          className="font-mono"
          onChange={(e) => onChange({ list: e.target.value })}
        />
        {others.length > 0 && <FieldDescription>Can use the other fields: {others.map((o) => `{${o}}`).join(", ")}.</FieldDescription>}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${f.key}-current`}>Current command</FieldLabel>
        <Input
          id={`${f.key}-current`}
          value={f.current}
          placeholder="docker context show"
          className="font-mono"
          onChange={(e) => onChange({ current: e.target.value })}
        />
        <FieldDescription>Prints the value this machine uses now. Optional.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${f.key}-set`}>Switch command</FieldLabel>
        <Input
          id={`${f.key}-set`}
          value={f.set}
          placeholder={`docker context use {${id}}`}
          className="font-mono"
          onChange={(e) => onChange({ set: e.target.value })}
        />
        <FieldDescription>
          Switches this machine to {`{${id}}`}, which is filled in shell-quoted. Leave empty if the CLI has no machine-wide switch.
        </FieldDescription>
      </Field>
      <Field orientation="horizontal">
        <Switch id={`${f.key}-freeform`} checked={f.freeform} onCheckedChange={(v) => onChange({ freeform: v })} />
        <FieldLabel htmlFor={`${f.key}-freeform`} className="font-normal">
          Any value (not just the listed ones)
        </FieldLabel>
      </Field>
    </div>
  )
}

function TestResults({ result: r, stale }: { result: SpecTest; stale: boolean }) {
  const ok = <CircleCheckIcon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400 terminal:text-success terminal:dark:text-success studio:text-success-foreground studio:dark:text-success-foreground friendly:text-success-foreground friendly:dark:text-success-foreground" />
  const bad = <CircleXIcon className="size-4 shrink-0 text-destructive" />
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-3 text-sm" aria-label="Test results">
      <div className="flex items-center gap-2">
        <span className="font-medium">Test results</span>
        <span className="text-xs text-muted-foreground">nothing was saved or switched</span>
        {stale && <Badge variant="outline">changed since</Badge>}
      </div>
      {!r.valid ? (
        <p className="flex gap-2 break-words">
          {bad}
          {r.error}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {r.requires && (
            <li className="flex gap-2">
              {r.requires.found ? ok : bad}
              <span>
                <span className="font-mono">{r.requires.command}</span>{" "}
                {r.requires.found ? "is installed" : "isn't installed here, so the commands didn't run. The provider stays hidden until it is."}
              </span>
            </li>
          )}
          {r.fields.map((f) => (
            <li key={f.id} className="flex flex-col gap-1">
              <span className="font-medium">{f.label}</span>
              <span className="flex gap-2 break-words">
                {f.currentError ? bad : ok}
                {f.currentError ? `Current: ${f.currentError}` : `Current: ${f.current ?? "nothing printed"}`}
              </span>
              <span className="flex gap-2 break-words">
                {f.optionsError ? bad : ok}
                {f.optionsError
                  ? `List: ${f.optionsError}`
                  : `List: ${f.options?.length ?? 0} option${f.options?.length === 1 ? "" : "s"}${
                      f.options?.length ? ` (${f.options.slice(0, 6).map((o) => o.label ?? o.value).join(", ")}${f.options.length > 6 ? ", …" : ""})` : ""
                    }`}
              </span>
            </li>
          ))}
          {r.envError ? (
            <li className="flex gap-2 break-words">
              {bad}Environment: {r.envError}
            </li>
          ) : r.env ? (
            <li className="flex gap-2 break-words">
              {ok}
              <span>
                A profile's servers would get{" "}
                {r.env.length ? (
                  <span className="font-mono text-xs">{r.env.map((e) => `${e.name}=${e.preview}`).join("  ")}</span>
                ) : (
                  "no variables with these values"
                )}
              </span>
            </li>
          ) : (
            !r.perProfile &&
            r.requires?.found !== false && (
              <li className="text-muted-foreground">No environment: profiles can't pick accounts for it, only this machine can switch.</li>
            )
          )}
        </ul>
      )}
    </section>
  )
}
