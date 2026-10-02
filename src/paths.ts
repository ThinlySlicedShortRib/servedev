import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "0.2.0";

export const HOME = process.env.SERVEDEV_HOME ?? path.join(os.homedir(), ".servedev");
export const LOG_DIR = path.join(HOME, "logs");
/** Pre-SQLite state; imported into the database once, then renamed. */
export const STATE_FILE = path.join(HOME, "state.json");
export const DB_FILE = path.join(HOME, "servedev.db");
/** Your configuration: projects, your servers and profiles, your changes to shared ones, settings. */
export const LOCAL_CONFIG = path.join(HOME, "config.json");
export const TOKEN_FILE = path.join(HOME, "token");
export const DAEMON_LOG = path.join(HOME, "daemon.log");
/** Remote machines: SSH control sockets, last known state, and (off macOS) their tokens. */
export const MACHINES_DIR = path.join(HOME, "machines");
export const DAEMON_PORT = Number(process.env.SERVEDEV_PORT ?? 7777);
export const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

export function ensureHome() {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
}

/** Shared secret between the daemon and its clients. Blocks drive-by requests from web pages. */
export function getToken(): string {
  ensureHome();
  try {
    fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch {
    // already exists
  }
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}
