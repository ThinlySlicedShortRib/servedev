import type { ProviderSpec } from "@/lib/api"

/** Editable rows of the custom-provider form; `extra` keeps spec keys the form doesn't show. */
export interface FieldRow {
  key: string
  id: string
  idTouched: boolean
  label: string
  list: string
  current: string
  set: string
  freeform: boolean
  extra: Omit<ProviderSpec["fields"][number], "id" | "label" | "list" | "current" | "set" | "freeform">
}

export interface EnvRow {
  key: string
  name: string
  value: string
  fromCommand: boolean
}

export interface ProviderForm {
  id: string
  idTouched: boolean
  name: string
  description: string
  requires: string
  fields: FieldRow[]
  env: EnvRow[]
  /** Everything else in the spec (actions, catalog metadata), kept as is. */
  base: Omit<ProviderSpec, "id" | "name" | "description" | "requires" | "fields" | "env">
}

let seq = 0
const key = () => `row-${++seq}`

/** "Fly.io" → "fly-io": provider ids are lowercase letters, digits and dashes, starting with a letter. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
}

/** Field ids become placeholders like {account}, so keep them short: "AWS profile" → "aws_profile". */
export function fieldSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

export function emptyField(): FieldRow {
  return { key: key(), id: "", idTouched: false, label: "", list: "", current: "", set: "", freeform: false, extra: {} }
}

export function toForm(spec?: ProviderSpec): ProviderForm {
  if (!spec) return { id: "", idTouched: false, name: "", description: "", requires: "", fields: [{ ...emptyField(), id: "account", label: "Account" }], env: [], base: {} }
  const { id, name, description, requires, fields, env, ...base } = spec
  return {
    id,
    idTouched: true,
    name,
    description: description ?? "",
    requires: requires ?? "",
    fields: fields.map(({ id: fid, label, list, current, set, freeform, ...extra }) => ({
      key: key(),
      id: fid,
      idTouched: true,
      label,
      list: list ?? "",
      current: current ?? "",
      set: set ?? "",
      freeform: !!freeform,
      extra,
    })),
    env: Object.entries(env ?? {}).map(([n, v]) => ({
      key: key(),
      name: n,
      value: typeof v === "string" ? v : v.command,
      fromCommand: typeof v !== "string",
    })),
    base,
  }
}

const opt = (s: string) => (s.trim() ? s.trim() : undefined)

export function toSpec(form: ProviderForm): ProviderSpec {
  const env = Object.fromEntries(
    form.env.filter((e) => e.name.trim()).map((e) => [e.name.trim(), e.fromCommand ? { command: e.value.trim() } : e.value.trim()])
  )
  const spec: ProviderSpec = {
    id: form.id.trim(),
    name: form.name.trim(),
    description: opt(form.description),
    ...form.base,
    requires: opt(form.requires),
    fields: form.fields.map((f) => ({
      id: f.id.trim(),
      label: f.label.trim(),
      ...f.extra,
      list: opt(f.list),
      current: opt(f.current),
      set: opt(f.set),
      freeform: f.freeform || undefined,
    })),
    env: Object.keys(env).length ? env : undefined,
  }
  // Drop undefined keys, so the JSON file stays tidy.
  return JSON.parse(JSON.stringify(spec)) as ProviderSpec
}

/** Problems worth fixing before saving; the daemon validates again. */
export function formIssues(form: ProviderForm): string[] {
  const issues: string[] = []
  if (!form.name.trim()) issues.push("Give it a name.")
  if (!/^[a-z][a-z0-9-]*$/.test(form.id.trim())) issues.push("The id must be lowercase letters, digits and dashes, starting with a letter.")
  const ids = new Set<string>()
  form.fields.forEach((f, i) => {
    const which = f.label.trim() || `Field ${i + 1}`
    if (!f.label.trim()) issues.push(`${which} needs a label.`)
    if (!/^[\w-]+$/.test(f.id.trim())) issues.push(`${which} needs an id (letters, digits, _ -).`)
    else if (ids.has(f.id.trim())) issues.push(`Two fields have the id "${f.id.trim()}".`)
    ids.add(f.id.trim())
    if (!f.list.trim() && !f.freeform && !f.extra.options) issues.push(`${which} needs a command that lists the options, or "Any value".`)
  })
  for (const e of form.env) {
    if (e.name.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name.trim())) issues.push(`"${e.name}" isn't a valid variable name.`)
    if (e.name.trim() && !e.value.trim()) issues.push(`${e.name.trim()} needs a value.`)
  }
  return issues
}
