// Per-project watcher lifecycle. The SessionStart hook spawns a detached watch daemon;
// the SessionEnd hook (or the user) signals it via SIGTERM.
//
// PID files live at <db-dir>/watchers/<sha256(projectRoot).slice(0,16)>.pid. Choosing the
// shared db dir keeps everything in one place and avoids leaking watcher state into the
// indexed project tree.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getDefaultDbDir } from "../util/db-path.ts";

export function getWatchersDir(): string {
  const dir = join(getDefaultDbDir(), "watchers");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getPidFilePath(projectRoot: string): string {
  const slug = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  return join(getWatchersDir(), `${slug}.pid`);
}

export type PidRecord = {
  pid: number;
  projectRoot: string;
  startedAt: number;
};

export function readPidFile(path: string): PidRecord | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as PidRecord;
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePidFile(path: string, record: PidRecord): void {
  writeFileSync(path, JSON.stringify(record), { mode: 0o644 });
}

export function removePidFile(path: string): void {
  try { unlinkSync(path); } catch { /* best-effort */ }
}

/**
 * Returns true if the given pid is a live process. We can't tell that it's *our* process
 * without something more elaborate (cmdline scanning is OS-specific), so we accept the
 * small risk of pid-reuse for the simpler implementation. The daemon is idempotent — if
 * a stale pid file points at an unrelated process, the next session will skip starting
 * a new watcher; the user can `stop-watch --force` to clear it.
 */
export function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    // Signal 0 == "does the process exist and can I signal it". Doesn't actually send a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we don't have permission to signal it — still "alive".
    if (code === "EPERM") return true;
    return false;
  }
}

export function stopWatcher(projectRoot: string): { stopped: boolean; pidFile: string } {
  const pidFile = getPidFilePath(projectRoot);
  const record = readPidFile(pidFile);
  if (!record) return { stopped: false, pidFile };
  if (!isPidAlive(record.pid)) {
    removePidFile(pidFile);
    return { stopped: false, pidFile };
  }
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    // Process may have exited between the check and the signal.
  }
  removePidFile(pidFile);
  return { stopped: true, pidFile };
}
