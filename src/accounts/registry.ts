import fs from "node:fs";
import path from "node:path";

import { HOME } from "../paths";
import { CATALOG } from "./catalog";
import { fromSpec, validateSpec, type ProviderSpec } from "./declarative";
import { gcloud } from "./providers/gcloud";
import { github } from "./providers/github";
import type { AccountProvider, Notice, Option, Selection } from "./types";

export const PROVIDERS_DIR = path.join(HOME, "providers");
const BUILT_IN: AccountProvider[] = [gcloud, github];

export interface FieldState {
  id: string;
  label: string;
  description?: string;
  freeform?: boolean;
  /** Whether the machine-wide value can be switched. */
  settable: boolean;
  current?: string;
  options: Option[];
  error?: string;
}

export interface ProviderState {
  id: string;
  name: string;
  description?: string;
  source: string;
  /** Profiles can pick accounts for their servers (the provider produces env). */
  perProfile: boolean;
  fields: FieldState[];
  notices: Notice[];
  actions: { id: string; label: string; description: string; interactive?: boolean }[];
  /** A JSON file in the providers folder: the dashboard can edit and remove it. */
  editable: boolean;
  removable: boolean;
}

export interface CatalogEntry {
  spec: ProviderSpec;
  /** Its CLI is on PATH. */
  installed: boolean;
  /** A provider with this id exists already (built in, or added). */
  added: boolean;
}

/** A dry run of a provider spec: what each command printed, without saving or switching anything. */
export interface SpecTest {
  valid: boolean;
  error?: string;
  requires?: { command: string; found: boolean };
  fields: { id: string; label: string; current?: string; currentError?: string; options?: Option[]; optionsError?: string }[];
  /** Env a profile's servers would get, values masked. */
  env?: { name: string; preview: string }[];
  envError?: string;
  perProfile: boolean;
}

export interface LoadError {
  file: string;
  message: string;
}

/** Selections of a profile or a server, by provider id. */
export type Selections = Record<string, Selection>;

/**
 * Account providers: the built-in ones plus any in ~/.servedev/providers (*.json, or *.ts/*.js
 * modules whose default export is an AccountProvider). User providers replace built-in ones with
 * the same id, so a built-in can be customized by copying it.
 */
export class AccountRegistry {
  private user: AccountProvider[] = [];
  errors: LoadError[] = [];
  private loadedKey = "";
  private availability = new Map<string, { at: number; ok: boolean }>();
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(private dir = PROVIDERS_DIR) {}

  /** (Re)load user providers when the folder changed. */
  async load(force = false) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => /\.(json|ts|js|mjs)$/.test(f) && !f.startsWith(".")).sort();
    } catch {}
    // A file deleted between readdir and stat just drops out of the key; it fails to load below.
    const mtime = (f: string) => {
      try {
        return fs.statSync(path.join(this.dir, f)).mtimeMs;
      } catch {
        return 0;
      }
    };
    const key = files.map((f) => `${f}:${mtime(f)}`).join("|");
    if (!force && key === this.loadedKey) return;
    this.loadedKey = key;
    const user: AccountProvider[] = [];
    const errors: LoadError[] = [];
    for (const f of files) {
      const file = path.join(this.dir, f);
      try {
        let p: AccountProvider;
        if (f.endsWith(".json")) p = fromSpec(validateSpec(JSON.parse(fs.readFileSync(file, "utf8"))));
        else {
          const mod = await import(`${file}?v=${mtime(f)}`);
          p = mod.default ?? mod.provider;
          if (!p?.id || !Array.isArray(p.fields) || typeof p.available !== "function") {
            throw new Error("the default export must be an AccountProvider (id, name, available(), fields)");
          }
        }
        if (user.some((u) => u.id === p.id)) throw new Error(`another file already defines provider "${p.id}"`);
        user.push({ ...p, source: file });
      } catch (e) {
        errors.push({ file, message: (e as Error).message });
      }
    }
    this.user = user;
    this.errors = errors;
    this.cache.clear();
  }

  all(): AccountProvider[] {
    const overridden = new Set(this.user.map((p) => p.id));
    return [...BUILT_IN.filter((p) => !overridden.has(p.id)).map((p) => ({ ...p, source: "built in" })), ...this.user];
  }

  get(id: string): AccountProvider {
    const p = this.all().find((x) => x.id === id);
    if (!p) throw new Error(`no account provider "${id}". Known: ${this.all().map((x) => x.id).join(", ")}`);
    return p;
  }

  private async isAvailable(p: AccountProvider): Promise<boolean> {
    const hit = this.availability.get(p.id);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    const ok = await p.available().catch(() => false);
    this.availability.set(p.id, { at: Date.now(), ok });
    return ok;
  }

  async available(): Promise<AccountProvider[]> {
    const all = this.all();
    const ok = await Promise.all(all.map((p) => this.isAvailable(p)));
    return all.filter((_, i) => ok[i]);
  }

  /** Short-lived cache: platform CLIs are slow to start, and the dashboard asks often. */
  private async cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  invalidate() {
    this.cache.clear();
  }

  async options(providerId: string, fieldId: string, selection: Selection = {}): Promise<Option[]> {
    const field = this.field(providerId, fieldId);
    return this.cached(`options:${providerId}:${fieldId}:${JSON.stringify(selection)}`, 30_000, () => field.options(selection));
  }

  private field(providerId: string, fieldId: string) {
    const p = this.get(providerId);
    const f = p.fields.find((x) => x.id === fieldId);
    if (!f) throw new Error(`${p.name} has no field "${fieldId}". Fields: ${p.fields.map((x) => x.id).join(", ")}`);
    return f;
  }

  async state(p: AccountProvider): Promise<ProviderState> {
    const currents: Selection = {};
    const fields = await Promise.all(
      p.fields.map(async (f): Promise<FieldState> => {
        const base = { id: f.id, label: f.label, description: f.description, freeform: f.freeform, settable: !!f.set };
        try {
          const current = await this.cached(`current:${p.id}:${f.id}`, 10_000, () => f.current());
          if (current) currents[f.id] = current;
          return { ...base, current, options: [] };
        } catch (e) {
          return { ...base, options: [], error: (e as Error).message };
        }
      }),
    );
    // Options may depend on other fields (projects of the account), so they come second.
    await Promise.all(
      fields.map(async (fs_, i) => {
        try {
          fs_.options = await this.options(p.id, p.fields[i].id, currents);
        } catch (e) {
          fs_.error ??= (e as Error).message;
        }
      }),
    );
    const notices = p.status ? await this.cached(`status:${p.id}`, 10_000, () => p.status!()).catch((e) => [{ level: "warning" as const, message: (e as Error).message }]) : [];
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      source: p.source ?? "built in",
      perProfile: !!p.env,
      fields,
      notices,
      actions: Object.entries(p.actions ?? {}).map(([id, a]) => ({ id, label: a.label, description: a.description, interactive: a.interactive })),
      editable: this.isUserJson(p),
      removable: this.isUserJson(p),
    };
  }

  // ---------- adding platforms ----------

  private isUserJson(p: AccountProvider): boolean {
    return !!p.source && p.source.endsWith(".json") && path.dirname(p.source) === this.dir;
  }

  private userProvider(id: string): AccountProvider | undefined {
    return this.user.find((p) => p.id === id);
  }

  async catalog(): Promise<CatalogEntry[]> {
    await this.load();
    const ids = new Set(this.all().map((p) => p.id));
    return CATALOG.map((spec) => ({ spec, installed: !spec.requires || !!Bun.which(spec.requires), added: ids.has(spec.id) }));
  }

  catalogSpec(id: string): ProviderSpec {
    const spec = CATALOG.find((s) => s.id === id);
    if (!spec) throw new Error(`no catalog entry "${id}". Catalog: ${CATALOG.map((s) => s.id).join(", ")}`);
    return spec;
  }

  /**
   * Write a JSON provider to the providers folder. An existing provider with the id needs
   * `replace`; replacing a built-in one (gcloud, github) needs `override` too.
   */
  async saveSpec(raw: unknown, opts: { replace?: boolean; override?: boolean } = {}): Promise<{ spec: ProviderSpec; file: string; replaced: boolean }> {
    await this.load();
    const spec = validateSpec(raw);
    const existing = this.userProvider(spec.id);
    const builtIn = BUILT_IN.some((p) => p.id === spec.id);
    if (existing && !opts.replace) throw new Error(`a provider "${spec.id}" already exists (${existing.source}); edit it, or pass replace to overwrite it`);
    if (existing && !this.isUserJson(existing)) throw new Error(`"${spec.id}" is defined by ${existing.source}, which isn't a JSON file in ${this.dir}; edit that file instead`);
    if (!existing && builtIn && !opts.override) {
      throw new Error(`"${spec.id}" is a built-in provider; saving this replaces it. Pass override to confirm, or pick another id`);
    }
    const file = existing?.source ?? path.join(this.dir, `${spec.id}.json`);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 });
    this.availability.delete(spec.id);
    await this.load(true);
    const failed = this.errors.find((e) => e.file === file);
    if (failed) throw new Error(`saved ${file}, but it didn't load: ${failed.message}`);
    return { spec, file, replaced: !!existing || builtIn };
  }

  /** The JSON of a provider added as a file, for editing. */
  async specOf(id: string): Promise<{ spec: ProviderSpec; file: string }> {
    await this.load();
    const p = this.userProvider(id);
    if (!p) {
      if (BUILT_IN.some((b) => b.id === id)) throw new Error(`"${id}" is built in (TypeScript); copy it into a file in ${this.dir} to customize it`);
      throw new Error(`no provider "${id}" in ${this.dir}`);
    }
    if (!this.isUserJson(p)) throw new Error(`"${id}" comes from ${p.source}, a TypeScript module; edit that file directly`);
    return { spec: JSON.parse(fs.readFileSync(p.source!, "utf8")), file: p.source! };
  }

  async removeSpec(id: string): Promise<{ file: string; restoredBuiltIn: boolean }> {
    await this.load();
    const p = this.userProvider(id);
    if (!p) {
      if (BUILT_IN.some((b) => b.id === id)) throw new Error(`"${id}" is built in and can't be removed`);
      throw new Error(`no provider "${id}" in ${this.dir}`);
    }
    if (!this.isUserJson(p)) throw new Error(`"${id}" comes from ${p.source}, a TypeScript module; delete that file yourself if you want it gone`);
    fs.rmSync(p.source!, { force: true });
    this.availability.delete(id);
    await this.load(true);
    return { file: p.source!, restoredBuiltIn: BUILT_IN.some((b) => b.id === id) };
  }

  /**
   * Try a spec without saving it: run each field's `current` and `list`, and build the env for
   * `selection` (default: the current values). Never runs `set` or actions.
   */
  async testSpec(raw: unknown, selection: Selection = {}): Promise<SpecTest> {
    let spec: ProviderSpec;
    try {
      spec = validateSpec(raw);
    } catch (e) {
      return { valid: false, error: (e as Error).message, fields: [], perProfile: false };
    }
    const result: SpecTest = { valid: true, fields: [], perProfile: !!spec.env && Object.keys(spec.env).length > 0 };
    if (spec.requires) {
      result.requires = { command: spec.requires, found: !!Bun.which(spec.requires) };
      if (!result.requires.found) return result;
    }
    const p = fromSpec(spec);
    const currents: Selection = {};
    for (const f of p.fields) {
      const row: SpecTest["fields"][number] = { id: f.id, label: f.label };
      try {
        row.current = await f.current();
        if (row.current) currents[f.id] = row.current;
      } catch (e) {
        row.currentError = (e as Error).message;
      }
      result.fields.push(row);
    }
    const sel = { ...currents, ...selection };
    await Promise.all(
      p.fields.map(async (f, i) => {
        try {
          result.fields[i].options = await f.options(Object.fromEntries(Object.entries(sel).filter(([k]) => k !== f.id)));
        } catch (e) {
          result.fields[i].optionsError = (e as Error).message;
        }
      }),
    );
    if (p.env) {
      try {
        const env = await p.env(sel);
        result.env = Object.entries(env).map(([name, v]) => ({ name, preview: mask(v) }));
      } catch (e) {
        result.envError = (e as Error).message;
      }
    }
    return result;
  }

  /** Added providers whose CLI isn't installed, so they don't show (but can still be removed). */
  async hidden(): Promise<{ id: string; name: string; source: string; removable: boolean }[]> {
    const shown = new Set((await this.available()).map((p) => p.id));
    return this.all()
      .filter((p) => !shown.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, source: p.source ?? "built in", removable: this.isUserJson(p) }));
  }

  async states(): Promise<ProviderState[]> {
    await this.load();
    return Promise.all((await this.available()).map((p) => this.state(p)));
  }

  /** Switch the machine-wide value of a field. */
  async set(providerId: string, fieldId: string, value: string) {
    const p = this.get(providerId);
    const f = this.field(providerId, fieldId);
    if (!f.set) throw new Error(`${p.name} ${f.label} can't be switched machine-wide; pick it per profile instead`);
    try {
      await f.set(value);
    } finally {
      this.invalidate();
    }
  }

  async action(providerId: string, actionId: string, args: Record<string, string> = {}): Promise<string> {
    const p = this.get(providerId);
    const a = p.actions?.[actionId];
    if (!a) throw new Error(`${p.name} has no action "${actionId}". Actions: ${Object.keys(p.actions ?? {}).join(", ") || "none"}`);
    try {
      return await a.run(args);
    } finally {
      this.invalidate();
    }
  }

  /** Env for a process using `selections`; throws with the provider's name on failure. */
  async env(selections: Selections): Promise<Record<string, string>> {
    await this.load();
    const env: Record<string, string> = {};
    for (const [id, selection] of Object.entries(selections)) {
      const p = this.get(id);
      if (!p.env) throw new Error(`${p.name} can't pick accounts per profile (it doesn't produce environment variables)`);
      try {
        Object.assign(env, await p.env(selection));
      } catch (e) {
        const msg = (e as Error).message;
        throw new Error(msg.startsWith(p.name) ? msg : `${p.name}: ${msg}`);
      }
    }
    return env;
  }

  /** Check selections name real providers and fields; drops empty values. */
  normalize(raw: unknown): Selections {
    if (raw == null) return {};
    if (typeof raw !== "object") throw new Error("accounts must be an object like { gcloud: { account: \"me@example.com\" } }");
    const out: Selections = {};
    for (const [id, sel] of Object.entries(raw as Record<string, unknown>)) {
      if (sel == null) continue;
      const p = this.get(id);
      if (!p.env) throw new Error(`${p.name} can't pick accounts per profile`);
      const clean: Selection = {};
      for (const [fid, v] of Object.entries(sel as Record<string, unknown>)) {
        if (!p.fields.some((f) => f.id === fid)) throw new Error(`${p.name} has no field "${fid}". Fields: ${p.fields.map((f) => f.id).join(", ")}`);
        if (v != null && String(v).trim()) clean[fid] = String(v).trim();
      }
      if (Object.keys(clean).length) out[id] = clean;
    }
    return out;
  }
}

/** Enough of a value to recognize it, not enough to use it (tokens). */
function mask(v: string): string {
  if (!v) return "(empty)";
  return v.length <= 8 ? `${v.slice(0, 2)}…` : `${v.slice(0, 4)}… (${v.length} chars)`;
}
