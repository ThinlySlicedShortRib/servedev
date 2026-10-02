/**
 * A machine's connection state. Pure, so the transitions and backoff can be tested with a fake clock.
 *
 *   connecting    first attempt since the hub started or the machine was added
 *   connected     SSH up, its servedev answering through the forward
 *   reconnecting  lost it; retrying with backoff (attempt counts up)
 *   offline       still failing after a few attempts; retried every minute in the background
 */
export type ConnState = "connecting" | "connected" | "reconnecting" | "offline";

export interface ConnStatus {
  state: ConnState;
  /** Failed attempts since the last success. */
  attempt: number;
  /** When the next attempt starts (reconnecting / offline). */
  nextRetryAt?: number;
  lastError?: string;
  hint?: string;
  connectedAt?: number;
  /** Last time it was known to be up. */
  lastSeen?: number;
}

/** Attempts shown as "reconnecting" before the machine counts as offline. */
export const RECONNECT_ATTEMPTS = 5;
const MAX_DELAY = 60_000;

/** 1s, 2s, 4s, 8s, 16s, 32s, then every minute. */
export function backoff(attempt: number): number {
  return Math.min(MAX_DELAY, 1000 * 2 ** Math.max(0, attempt - 1));
}

export function initial(lastSeen?: number): ConnStatus {
  return { state: "connecting", attempt: 0, lastSeen };
}

export function succeeded(s: ConnStatus, now: number): ConnStatus {
  return { state: "connected", attempt: 0, connectedAt: now, lastSeen: now };
}

/** An attempt failed, or a live connection was lost (then `wasConnected`). */
export function failed(s: ConnStatus, now: number, error: { message: string; hint?: string }): ConnStatus {
  const lastSeen = s.state === "connected" ? now : s.lastSeen;
  const attempt = s.state === "connected" ? 1 : s.attempt + 1;
  // A machine that never connected since the hub started and fails its first try is simply offline.
  const state: ConnState = attempt > RECONNECT_ATTEMPTS || (s.state === "connecting" && !s.lastSeen) ? "offline" : "reconnecting";
  return { state, attempt, lastError: error.message, hint: error.hint, lastSeen, nextRetryAt: now + backoff(attempt) };
}

/** Someone asked to reconnect now: retry immediately, keeping what's known. */
export function retryNow(s: ConnStatus): ConnStatus {
  return s.state === "connected" ? s : { ...s, state: s.lastSeen ? "reconnecting" : "connecting", nextRetryAt: undefined };
}
