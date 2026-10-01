import * as React from "react"
import { ExternalLinkIcon, PencilIcon, PlusIcon, SearchIcon } from "@/components/icons"
import { toast } from "sonner"

import { Hint } from "@/components/hint"
import { ProviderForm } from "@/components/provider-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type CatalogEntry, type ProviderSpec } from "@/lib/api"

/**
 * Add a platform: one from the catalog, or a custom provider. With `editing`, it's just the form
 * for that provider.
 */
export function AddPlatformDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing?: ProviderSpec
}) {
  const [tab, setTab] = React.useState<"catalog" | "custom">("catalog")
  const [catalog, setCatalog] = React.useState<CatalogEntry[] | null>(null)
  const [draft, setDraft] = React.useState<{ spec?: ProviderSpec; n: number }>({ n: 0 })
  const [catalogVersion, setCatalogVersion] = React.useState(0)

  React.useEffect(() => {
    if (!open || editing) return
    let cancelled = false
    api<{ entries: CatalogEntry[] }>("/api/accounts/catalog")
      .then((r) => !cancelled && setCatalog(r.entries))
      .catch((e) => !cancelled && toast.error("Couldn't load the catalog", { description: (e as Error).message }))
    return () => {
      cancelled = true
    }
  }, [open, editing, catalogVersion])

  function customize(spec?: ProviderSpec) {
    setDraft((d) => ({ spec, n: d.n + 1 }))
    setTab("custom")
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) {
          setTab("catalog")
          setDraft((d) => ({ n: d.n + 1 }))
        }
      }}
    >
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "Add a platform"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes are saved to its JSON file and take effect right away."
              : "Pick accounts for another CLI from the dashboard, and give profiles their own. Each platform is a JSON file in ~/.servedev/providers you can edit or share."}
          </DialogDescription>
        </DialogHeader>
        {editing ? (
          <ProviderForm initial={editing} editing onSaved={() => onOpenChange(false)} />
        ) : (
          <Tabs value={tab} onValueChange={(v) => setTab(v as "catalog" | "custom")} className="min-h-0 flex-1 flex-col">
            <TabsList>
              <TabsTrigger value="catalog">Catalog</TabsTrigger>
              <TabsTrigger value="custom">Custom</TabsTrigger>
            </TabsList>
            <TabsContent value="catalog" className="-mx-4 min-h-0 overflow-y-auto px-4 pb-4">
              <CatalogList
                entries={catalog}
                onAdded={() => setCatalogVersion((v) => v + 1)}
                onCustomize={customize}
                onCustom={() => customize()}
              />
            </TabsContent>
            <TabsContent value="custom" className="flex min-h-0 flex-col">
              <ProviderForm key={draft.n} initial={draft.spec} catalog={catalog ?? undefined} onSaved={() => onOpenChange(false)} />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}

function CatalogList({
  entries,
  onAdded,
  onCustomize,
  onCustom,
}: {
  entries: CatalogEntry[] | null
  onAdded: () => void
  onCustomize: (spec: ProviderSpec) => void
  onCustom: () => void
}) {
  const [query, setQuery] = React.useState("")
  const [adding, setAdding] = React.useState<string | null>(null)

  const groups = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (e: CatalogEntry) =>
      !q || [e.spec.name, e.spec.id, e.spec.description ?? "", e.spec.category ?? ""].some((s) => s.toLowerCase().includes(q))
    const map = new Map<string, CatalogEntry[]>()
    for (const e of (entries ?? []).filter(match)) {
      const c = e.spec.category ?? "Other"
      if (!map.has(c)) map.set(c, [])
      map.get(c)!.push(e)
    }
    return [...map]
      .sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
      .map(([c, list]) => [c, list.sort((a, b) => a.spec.name.localeCompare(b.spec.name))] as const)
  }, [entries, query])

  async function add(e: CatalogEntry) {
    setAdding(e.spec.id)
    try {
      const r = await api<{ file: string; installed: boolean }>("/api/accounts/providers", { catalog: e.spec.id })
      toast.success(`Added ${e.spec.name}`, {
        description: r.installed
          ? "It's in the Accounts panel now."
          : `It shows up once ${e.spec.requires ?? "its CLI"} is installed${e.spec.install ? ` (${e.spec.install})` : ""}.`,
      })
      onAdded()
    } catch (err) {
      toast.error(`Couldn't add ${e.spec.name}`, { description: (err as Error).message })
    } finally {
      setAdding(null)
    }
  }

  if (entries === null) {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Spinner /> Loading the catalog…
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4 pt-2">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search platforms" aria-label="Search platforms" />
      </InputGroup>
      {groups.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>{entries.length ? `Nothing matches “${query}”` : "The catalog is empty"}</EmptyTitle>
            <EmptyDescription>Any CLI that can list and switch accounts works. Describe yours in a few commands.</EmptyDescription>
          </EmptyHeader>
          <Button size="sm" onClick={onCustom}>
            <PlusIcon data-icon="inline-start" />
            Write a custom provider
          </Button>
        </Empty>
      ) : (
        groups.map(([category, list]) => (
          <section key={category} className="flex flex-col gap-2" aria-label={category}>
            <h3 className="text-xs font-medium text-muted-foreground terminal:font-semibold terminal:tracking-wider terminal:uppercase">{category}</h3>
            <ItemGroup className="gap-2">
              {list.map((e) => (
                <Item key={e.spec.id} variant="outline" size="sm" className="flex-wrap">
                  <ItemContent className="min-w-48">
                    <ItemTitle className="flex flex-wrap items-center gap-1.5">
                      {e.spec.name}
                      {e.installed ? (
                        <Badge variant="secondary">installed</Badge>
                      ) : (
                        <Hint label={e.spec.install ? `Install it: ${e.spec.install}` : `Needs ${e.spec.requires ?? "its CLI"} on PATH`}>
                          <Badge variant="outline">not installed</Badge>
                        </Hint>
                      )}
                      {e.spec.tested === false && (
                        <Hint label="Its commands were written from the CLI's docs but haven't been run against it yet. Test it, and please report what doesn't work.">
                          <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400 terminal:border-warning/50 terminal:text-warning terminal:dark:text-warning">
                            untested
                          </Badge>
                        </Hint>
                      )}
                      {!e.spec.fields.some((f) => f.set) && (
                        <Hint label="Its CLI has no machine-wide switch, so servedev can't change it for the whole machine; profiles pick it for their servers.">
                          <Badge variant="outline">per profile only</Badge>
                        </Hint>
                      )}
                      {!e.spec.env && (
                        <Hint label="Its CLI can't be pointed at an account per process, so it can only be switched for the whole machine, not per profile.">
                          <Badge variant="outline">machine only</Badge>
                        </Hint>
                      )}
                    </ItemTitle>
                    {e.spec.description && <ItemDescription>{e.spec.description}</ItemDescription>}
                  </ItemContent>
                  <ItemActions>
                    {e.spec.homepage && (
                      <Hint label={`Open ${e.spec.homepage}`}>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          nativeButton={false}
                          render={<a href={e.spec.homepage} target="_blank" rel="noopener" aria-label={`${e.spec.name} website`} />}
                        >
                          <ExternalLinkIcon />
                        </Button>
                      </Hint>
                    )}
                    <Hint label="Open it in the custom form to change its commands before adding it">
                      <Button variant="ghost" size="icon-sm" aria-label={`Customize ${e.spec.name}`} onClick={() => onCustomize(e.spec)}>
                        <PencilIcon />
                      </Button>
                    </Hint>
                    {e.added ? (
                      <Button size="sm" variant="outline" disabled>
                        Added
                      </Button>
                    ) : (
                      <Hint label={`Save ${e.spec.name} to ~/.servedev/providers/${e.spec.id}.json`}>
                        <Button size="sm" onClick={() => void add(e)} disabled={adding !== null}>
                          {adding === e.spec.id ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
                          Add
                        </Button>
                      </Hint>
                    )}
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </section>
        ))
      )}
      <p className="text-xs text-muted-foreground">
        Not listed? Any CLI that can list and switch accounts works:{" "}
        <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onCustom}>
          write a custom provider
        </Button>
        .
      </p>
    </div>
  )
}
