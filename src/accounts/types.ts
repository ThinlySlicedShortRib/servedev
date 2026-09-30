/**
 * Account providers: how servedev lists, switches and hands out accounts for platform CLIs
 * (gcloud, GitHub, Docker, AWS, ...). A provider is either a TypeScript module
 * (src/accounts/providers/*.ts) or a JSON file in ~/.servedev/providers/ (see declarative.ts
 * and docs/providers.md).
 *
 * A provider has one or more fields, e.g. gcloud has `account` and `project`. Each field has a
 * machine-wide current value that servedev can read and (optionally) switch. A "selection" is a
 * value per field; a profile can store one, and servers started from that profile get the
 * environment the provider derives from it, without changing the machine-wide value.
 */

export interface Option {
  value: string;
  /** Shown instead of `value` when set. */
  label?: string;
  /** Secondary text, e.g. "credentials saved" or a project number. */
  detail?: string;
}

/** A value per field id, e.g. { account: "me@example.com", project: "my-project" }. */
export type Selection = Record<string, string>;

export interface AccountField {
  id: string;
  label: string;
  description?: string;
  /** Values other than the listed options are allowed (e.g. a project id the list can't show). */
  freeform?: boolean;
  /** Choices for this field. `selection` holds the other fields' values, for dependent lists. */
  options(selection: Selection): Promise<Option[]>;
  /** The machine-wide value, if there is one. */
  current(): Promise<string | undefined>;
  /** Switch the machine-wide value. Omit when the platform has no global notion of "current". */
  set?(value: string): Promise<void>;
}

export interface Notice {
  level: "info" | "warning";
  message: string;
  /** An action that resolves it, e.g. { action: "setup-credentials", args: { account } }. */
  fix?: { action: string; label: string; args?: Record<string, string> };
}

export interface ProviderAction {
  label: string;
  description: string;
  /** Needs the user (a browser login, say); the dashboard says so while it waits. */
  interactive?: boolean;
  run(args: Record<string, string>): Promise<string>;
}

export interface AccountProvider {
  /** Stable, lowercase: "gcloud", "github". Used in profiles and on the CLI. */
  id: string;
  /** Display name: "Google Cloud", "GitHub". */
  name: string;
  description?: string;
  /** Whether the platform's CLI is installed (providers that aren't are hidden). */
  available(): Promise<boolean>;
  fields: AccountField[];
  /**
   * Environment for a process that should use `selection` instead of the machine-wide values.
   * Called every time a server starts, so tokens are fresh and never stored.
   */
  env?(selection: Selection): Promise<Record<string, string>>;
  /** Things worth knowing about the current state, with optional fixes. */
  status?(): Promise<Notice[]>;
  /** Extra operations, e.g. logging in; invoked by id from the dashboard, CLI or agents. */
  actions?: Record<string, ProviderAction>;
  /** Where it was loaded from (built in, or a JSON file path). Filled in by the registry. */
  source?: string;
}
