import * as React from "react"

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import type { AccountOption } from "@/lib/api"

/** Stands for "no pick": the profile leaves this field to its default. */
const DEFAULT = "\u0000default"

/**
 * Pick a value for one field of an account provider. Freeform fields (a project id the list can't
 * show) accept whatever is typed. With `defaultLabel`, a first option clears the pick.
 */
export function AccountPicker({
  id,
  options,
  value,
  onChange,
  freeform,
  defaultLabel,
  disabled,
  placeholder,
}: {
  id?: string
  options: AccountOption[]
  value: string | undefined
  onChange: (value: string | undefined) => void
  freeform?: boolean
  defaultLabel?: string
  disabled?: boolean
  placeholder?: string
}) {
  const [query, setQuery] = React.useState("")
  const byValue = React.useMemo(() => new Map(options.map((o) => [o.value, o])), [options])
  const items = React.useMemo(() => {
    const list = options.map((o) => o.value)
    if (defaultLabel !== undefined) list.unshift(DEFAULT)
    // The current value may not be listed (typed earlier, or the list failed to load).
    if (value && !byValue.has(value)) list.push(value)
    const typed = query.trim()
    if (freeform && typed && !list.includes(typed) && typed !== label(value)) list.push(typed)
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, defaultLabel, value, query, freeform])

  function label(v: string | undefined | null): string {
    if (!v) return ""
    if (v === DEFAULT) return defaultLabel ?? ""
    return byValue.get(v)?.label ?? v
  }

  return (
    <Combobox
      items={items}
      value={value ?? (defaultLabel !== undefined ? DEFAULT : null)}
      onValueChange={(v) => {
        if (v === null) return
        onChange(v === DEFAULT ? undefined : (v as string))
      }}
      itemToStringLabel={(v) => label(v as string)}
      onInputValueChange={setQuery}
      disabled={disabled}
    >
      <ComboboxInput id={id} placeholder={placeholder ?? (freeform ? "Pick or type" : "Pick one")} disabled={disabled} className="w-full" />
      <ComboboxContent>
        <ComboboxEmpty>{freeform ? "Type a value to use it" : "No matches"}</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => {
            const o = byValue.get(item)
            return (
              <ComboboxItem key={item} value={item}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {item === DEFAULT ? defaultLabel : o ? (o.label ?? o.value) : freeform && item === query.trim() ? `Use “${item}”` : item}
                  </span>
                  {o?.detail && <span className="truncate text-xs text-muted-foreground">{o.detail}</span>}
                </span>
              </ComboboxItem>
            )
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
