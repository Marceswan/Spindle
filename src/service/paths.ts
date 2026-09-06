import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";

export const SERVICE_PROTOCOL = 1;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export function canonicalDbPath(dbPath: string): string {
  const absolute = resolve(dbPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  try { return realpathSync(absolute); } catch {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  }
}

export function serviceFiles(dbPath: string): { discovery: string; lock: string } {
  return { discovery: `${dbPath}.service.json`, lock: `${dbPath}.service-lock.db` };
}

export type ServiceRecord = { protocol: number; pid: number; port: number; token: string };
