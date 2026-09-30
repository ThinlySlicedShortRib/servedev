import { errorText, sh, shellQuote } from "./exec";
import type { AccountField, AccountProvider, Option, ProviderAction, Selection } from "./types";

/**
 * Providers written as JSON, for platforms whose CLI can list, show and switch accounts with a
 * command each. See docs/providers.md. In commands, {field} is replaced by that field's value,
 * shell-quoted; in env values it's inserted as is. Commands run with /bin/sh.
 */
export interface ProviderSpec {
  id: string;
  name: string;
  description?: string;
  /** Catalog metadata: the platform's website, a grouping like "Cloud" or "Containers", */
  homepage?: string;
  category?: string;
  /** how to install the CLI (a command or a URL), */
  install?: string;
  /** and false when the commands were written from docs but never run against the real CLI. */
  tested?: boolean;
  /** Command that must be on PATH for the provider to show up, e.g. "docker". */
  requires?: string;
  fields: {
    id: string;
    label: string;
    description?: string;
    freeform?: boolean;
    /** Prints one option per line: value, optionally followed by a tab and a label, and a tab and detail. */
    list?: string;
    /** Fixed options, instead of `list`. */
    options?: (string | Option)[];
    /** Prints the machine-wide value. */
    current?: string;
    /** Switches the machine-wide value. */
    set?: string;
  }[];
  /** Env for servers in a profile that picks accounts: a template, or { "command": "..." } whose output is the value. */
  env?: Record<string, string | { command: string }>;
  actions?: Record<string, { label: string; description: string; command: string; interactive?: boolean }>;
}

const PLACEHOLDER = /\{([\w-]+)\}/g;

/** Fill {field} placeholders; undefined when one of them has no value. */
function fill(template: string, values: Selection, quote: boolean): string | undefined {
  let missing = false;
  const out = template.replace(PLACEHOLDER, (_, k: string) => {
    if (values[k] === undefined || values[k] === "") {
      missing = true;
      return "";
    }
    return quote ? shellQuote(values[k]) : values[k];
  });
  return missing ? undefined : out;
}

async function output(command: string): Promise<string> {
  const r = await sh(command);
  if (r.code !== 0) throw new Error(errorText(r.stderr || r.stdout) || `exited with ${r.code}: ${command}`);
  return r.stdout.trim();
}

export function validateSpec(raw: unknown): ProviderSpec {
  const s = raw as ProviderSpec;
  const where = (msg: string) => new Error(msg);
  if (!s || typeof s !== "object") throw where("expected a JSON object");
  if (typeof s.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(s.id)) throw where(`"id" must be lowercase letters, digits and dashes, e.g. "docker"`);
  if (typeof s.name !== "string" || !s.name) throw where(`"name" is required, e.g. "Docker"`);
  for (const k of ["description", "requires", "homepage", "category", "install"] as const) {
    if (s[k] !== undefined && typeof s[k] !== "string") throw where(`"${k}" must be a string`);
  }
  if (s.tested !== undefined && typeof s.tested !== "boolean") throw where(`"tested" must be true or false`);
  if (!Array.isArray(s.fields) || !s.fields.length) throw where(`"fields" needs at least one field`);
  const seen = new Set<string>();
  for (const f of s.fields) {
    if (typeof f.id !== "string" || !/^[\w-]+$/.test(f.id)) throw where(`each field needs an "id" (letters, digits, _ -)`);
    if (seen.has(f.id)) throw where(`two fields have the id "${f.id}"`);
    seen.add(f.id);
    if (typeof f.label !== "string" || !f.label) throw where(`field "${f.id}" needs a "label"`);
    if (!f.list && !f.options && !f.freeform) throw where(`field "${f.id}" needs "list" (a command), "options", or "freeform": true`);
  }
  const ids = new Set(s.fields.map((f) => f.id));
  const known = [...ids].map((k) => `{${k}}`).join(", ");
  /** Placeholders a template may use: `allowed` lists them, for the error message too. */
  const check = (what: string, template: unknown, allowed: Set<string>, hint: string) => {
    if (template === undefined) return;
    if (typeof template !== "string") throw where(`${what} must be a string (a shell command)`);
    for (const [, k] of template.matchAll(PLACEHOLDER)) if (!allowed.has(k)) throw where(`${what} uses {${k}}, ${ids.has(k) ? "which isn't allowed there" : "which isn't a field"}; ${hint}`);
  };
  for (const f of s.fields) {
    check(`field "${f.id}" list`, f.list, ids, `it can use other fields' values: ${known}`);
    check(`field "${f.id}" current`, f.current, new Set(), "it prints the machine-wide value, so it can't use placeholders");
    check(`field "${f.id}" set`, f.set, new Set([f.id, "value"]), `it can use only {${f.id}} (or {value}), the value being set`);
  }
  for (const [name, v] of Object.entries(s.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw where(`env "${name}" isn't a valid variable name (letters, digits, _)`);
    const template = typeof v === "string" ? v : v?.command;
    if (typeof template !== "string") throw where(`env ${name} must be a string or { "command": "..." }`);
    check(`env ${name}`, template, ids, `it can use field values: ${known}`);
  }
  for (const [id, a] of Object.entries(s.actions ?? {})) {
    if (!a?.command || !a.label) throw where(`action "${id}" needs "label" and "command"`);
    // Any {name} is fine: actions take their arguments from the caller (CLI key=value, MCP args, the dashboard).
    if (typeof a.command !== "string") throw where(`action "${id}" command must be a string`);
  }
  return s;
}

export function fromSpec(spec: ProviderSpec): AccountProvider {
  const fields: AccountField[] = spec.fields.map((f) => ({
    id: f.id,
    label: f.label,
    description: f.description,
    freeform: f.freeform,
    async options(selection) {
      if (f.options) return f.options.map((o) => (typeof o === "string" ? { value: o } : o));
      if (!f.list) return [];
      const cmd = fill(f.list, selection, true) ?? f.list.replace(PLACEHOLDER, "");
      return (await output(cmd))
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          const [value, label, detail] = l.split("\t").map((x) => x.trim());
          return { value, label: label || undefined, detail: detail || undefined };
        });
    },
    current: async () => (f.current ? (await output(f.current)) || undefined : undefined),
    set: f.set
      ? async (value) => {
          const cmd = fill(f.set!, { [f.id]: value, value }, true);
          if (!cmd) throw new Error(`can't set ${f.label}: ${value ? `its "set" command uses a placeholder other than {${f.id}}` : "no value given"}`);
          await output(cmd);
        }
      : undefined,
  }));

  const actions: Record<string, ProviderAction> = {};
  for (const [id, a] of Object.entries(spec.actions ?? {})) {
    actions[id] = {
      label: a.label,
      description: a.description,
      interactive: a.interactive,
      run: async (args) => (await output(fill(a.command, args, true) ?? a.command.replace(PLACEHOLDER, ""))) || "Done.",
    };
  }

  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    available: async () => !spec.requires || !!Bun.which(spec.requires),
    fields,
    env: spec.env
      ? async (selection) => {
          const env: Record<string, string> = {};
          for (const [name, v] of Object.entries(spec.env!)) {
            if (typeof v === "string") {
              const value = fill(v, selection, false);
              if (value !== undefined) env[name] = value;
            } else {
              const cmd = fill(v.command, selection, true);
              if (cmd) env[name] = await output(cmd);
            }
          }
          return env;
        }
      : undefined,
    actions,
  };
}
