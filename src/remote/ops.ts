/** `servedev remote ...`: adding, listing and repairing other machines (for the CLI and agents). */
import { api } from "../client";
import { ago, table, type OpResult } from "../ops";
import type { MachineSummary, SetupStep } from "./types";

const MARK: Record<SetupStep["status"], string> = { ok: "✓", warning: "⚠", failed: "✗", skipped: "·" };

export function describeSteps(steps: SetupStep[]): string {
  return steps
    .map((s) => {
      const line = `  ${MARK[s.status]} ${s.label}${s.status === "skipped" ? " (skipped)" : s.detail ? `: ${s.detail}` : ""}`;
      return s.hint ? `${line}\n      ${s.status === "failed" ? "fix" : "note"}: ${s.hint}` : line;
    })
    .join("\n");
}

function serverCounts(m: MachineSummary): string {
  return `${m.counts.total} server${m.counts.total === 1 ? "" : "s"} (${m.counts.running} running${m.counts.crashed ? `, ${m.counts.crashed} crashed` : ""})`;
}

function bootHint(m: MachineSummary): string {
  return m.kind === "wsl" ? `\nWSL stops (with every server in it) when nothing on Windows holds it open. To start servedev when the PC boots: servedev remote boot ${m.name}` : "";
}

export async function opRemoteAdd(a: { name: string; ssh: string }): Promise<OpResult> {
  const r = await api<{ ok: boolean; steps: SetupStep[]; machine?: MachineSummary }>("/api/machines/add", { name: a.name, ssh: a.ssh });
  const head = `Adding ${a.name} (${a.ssh}):\n${describeSteps(r.steps)}`;
  if (!r.ok || !r.machine) return { ok: false, text: `${head}\n\n✗ ${a.name} wasn't added. Fix the step above and run this again.`, data: r };
  const m = r.machine;
  return {
    ok: true,
    text:
      `${head}\n\n✓ ${m.name} added: ${serverCounts(m)}. Its servers are ${m.name}/<id> here: servedev ls --on ${m.name}, servedev logs <name> --on ${m.name}.` +
      bootHint(m),
    data: r,
  };
}

export async function opRemoteList(): Promise<OpResult> {
  const r = await api<{ machines: MachineSummary[]; hubVersion: string }>("/api/machines");
  if (!r.machines.length) return { ok: true, text: "no other machines. Add one with: servedev remote add <name> <user@host>", data: r };
  const rows = [["NAME", "STATE", "SSH", "SYSTEM", "SERVEDEV", "SERVERS", "FORWARDS", "LAST SEEN"]];
  for (const m of r.machines) {
    const state = m.state === "reconnecting" ? `reconnecting (attempt ${m.attempt})` : m.state;
    rows.push([
      m.name,
      state,
      m.ssh,
      m.os ?? m.kind ?? "-",
      m.version ? `${m.version}${m.versionMismatch ? " (differs)" : ""}` : "-",
      `${m.counts.running} running / ${m.counts.total}`,
      String(m.forwards.length),
      m.state === "connected" ? "now" : m.lastSeen ? `${ago(m.lastSeen)} ago` : "never",
    ]);
  }
  const notes = r.machines.flatMap((m) => [
    ...(m.versionMismatch ? [`${m.name} runs servedev ${m.version}; this machine runs ${m.hubVersion}. Update one so they match.`] : []),
    ...(m.state !== "connected" && m.lastError ? [`${m.name}: ${m.lastError}${m.hint ? `\n  fix: ${m.hint}` : ""}${m.nextRetryAt ? `\n  ${m.nextRetryAt > Date.now() ? `next try in ${Math.round((m.nextRetryAt - Date.now()) / 1000)}s` : "trying now"} (or now: servedev remote reconnect ${m.name})` : ""}`] : []),
  ]);
  return { ok: true, text: table(rows) + (notes.length ? `\n\n${notes.join("\n")}` : ""), data: r };
}

export async function opRemoteRemove(name: string): Promise<OpResult> {
  const r = await api<{ removed: string }>("/api/machines/remove", { name });
  return { ok: true, text: `removed ${r.removed}: disconnected, and its token and cached servers deleted here. Nothing changed on ${r.removed} itself.`, data: r };
}

export async function opRemoteReconnect(name: string): Promise<OpResult> {
  const r = await api<{ ok: boolean; steps: SetupStep[]; machine: MachineSummary }>("/api/machines/reconnect", { name });
  const text = `Reconnecting ${name}:\n${describeSteps(r.steps)}\n\n` + (r.ok ? `✓ ${name} is connected: ${serverCounts(r.machine)}.` : `✗ still not connected; servedev keeps retrying in the background.`);
  return { ok: r.ok, text, data: r };
}

export async function opRemoteBoot(a: { name: string; install?: boolean }): Promise<OpResult> {
  const r = await api<{ supported: boolean; note?: string; task?: string; script?: string; powershell?: string; installed?: boolean; output?: string }>("/api/machines/boot", {
    name: a.name,
    install: a.install,
  });
  if (!r.supported) return { ok: true, text: r.note ?? "", data: r };
  const lines = [
    `Wrote ${r.script} on ${a.name}: it starts servedev (and its pinned servers) and keeps WSL running.`,
    "",
  ];
  if (a.install) {
    lines.push(r.installed ? `✓ Registered the "${r.task}" logon task on ${a.name} and started it.` : `✗ Registering the task failed${r.output ? `: ${r.output}` : ""}. Run the command below on the PC instead.`);
    if (r.installed) return { ok: true, text: lines.join("\n"), data: r };
  } else {
    lines.push(`To run it at every logon, run this once in PowerShell on ${a.name} (or: servedev remote boot ${a.name} --install):`);
  }
  lines.push("", r.powershell ?? "");
  return { ok: !a.install || !!r.installed, text: lines.join("\n"), data: r };
}
