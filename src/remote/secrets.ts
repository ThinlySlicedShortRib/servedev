/**
 * Remote machines' access keys (issued to this hub by each machine; or, from an older servedev
 * there, its own token). They grant control of that machine's servers, so they never go in
 * config.json (which people sync through dotfiles): the macOS Keychain on a Mac, else a file only
 * you can read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME } from "../paths";

export interface SecretStore {
  get(machine: string): string | undefined;
  set(machine: string, token: string): void;
  delete(machine: string): void;
  /** Where it's kept, to tell people ("your Keychain", a file's path). */
  where?(machine: string): string;
}

/** One Keychain item per machine; a separate SERVEDEV_HOME gets separate items. */
function keychainService(home: string): string {
  return home === path.join(process.env.HOME ?? "", ".servedev") ? "dev.servedev.machine" : `dev.servedev.machine:${home}`;
}

export function keychainStore(home = HOME): SecretStore {
  const service = keychainService(home);
  const run = (args: string[]) => Bun.spawnSync(["security", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    get(machine) {
      const r = run(["find-generic-password", "-s", service, "-a", machine, "-w"]);
      return r.exitCode === 0 ? r.stdout.toString().trim() || undefined : undefined;
    },
    set(machine, token) {
      const r = run(["add-generic-password", "-U", "-s", service, "-a", machine, "-l", `servedev: ${machine}`, "-w", token]);
      if (r.exitCode !== 0) throw new Error(`couldn't save ${machine}'s access key in the Keychain: ${r.stderr.toString().trim()}`);
    },
    delete(machine) {
      run(["delete-generic-password", "-s", service, "-a", machine]);
    },
    where: () => "your Keychain",
  };
}

/** <home>/machines/<name>.token, mode 0600. */
export function fileStore(dir: string): SecretStore {
  const file = (machine: string) => path.join(dir, `${machine}.token`);
  return {
    get(machine) {
      try {
        return fs.readFileSync(file(machine), "utf8").trim() || undefined;
      } catch {
        return undefined;
      }
    },
    set(machine, token) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file(machine)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, token, { mode: 0o600 });
      fs.renameSync(tmp, file(machine));
    },
    delete(machine) {
      fs.rmSync(file(machine), { force: true });
    },
    where(machine) {
      const f = file(machine);
      const home = os.homedir();
      return f.startsWith(home + path.sep) ? `~${f.slice(home.length)}` : f;
    },
  };
}

export function defaultSecretStore(machinesDir: string): SecretStore {
  return process.platform === "darwin" && Bun.which("security") ? keychainStore() : fileStore(machinesDir);
}
