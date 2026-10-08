/** The Platform for the OS this process runs on (see types.ts). */
import { posix } from "./posix";
import type { Platform } from "./types";
import { windows } from "./windows";

export type { AutostartContext, AutostartStatus, Listener, Platform, Proc } from "./types";
export { Unsupported } from "./types";

export function platformFor(os: NodeJS.Platform): Platform {
  return os === "win32" ? windows : posix;
}

export const platform: Platform = platformFor(process.platform);
