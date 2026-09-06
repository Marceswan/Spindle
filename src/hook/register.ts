// Idempotent registration/removal of Spindle's SessionStart hook in Claude Code's
// settings.json.
//
// Settings shape:
//   { "hooks": { "SessionStart": [ { "matcher": "startup", "hooks": [ ... ] } ] } }
//
// We identify our own entry by command suffix "sfdx-graph-mcp session-start-hook" so
// reinstalls at a different binary path replace the old entry rather than duplicating.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execPath } from "node:process";

const START_HOOK_SUFFIX = "session-start-hook";
const STOP_HOOK_SUFFIX = "stop-watch";
const SPINDLE_BINARY_NAME = "sfdx-graph-mcp";

type HookEntry = {
  type: string;
  command: string;
};

type MatcherEntry = {
  matcher?: string;
  hooks?: HookEntry[];
};

type Settings = {
  hooks?: {
    SessionStart?: MatcherEntry[];
    SessionEnd?: MatcherEntry[];
    [event: string]: MatcherEntry[] | undefined;
  };
  [key: string]: unknown;
};

export type RegisterOptions = {
  settingsPath?: string;
  /** Override the binary path used when constructing hook commands. */
  binary?: string;
};

export type RegisterResult = { changed: boolean; path: string };

export function getDefaultSettingsPath(): string {
  const home =
    process.env["CLAUDE_CONFIG_DIR"] ??
    join(process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp", ".claude");
  return join(home, "settings.json");
}

function resolveSelfBinary(): string {
  // Under a Bun-compiled single-file binary, process.argv[0] is the runtime name "bun"
  // (NOT the binary path); process.execPath is the absolute path to the compiled binary.
  // The installer always invokes the compiled binary so execPath is correct in production.
  return execPath || SPINDLE_BINARY_NAME;
}

function buildSessionStartCommand(binary: string): string {
  return `${quoteIfNeeded(binary)} session-start-hook`;
}

function quoteIfNeeded(p: string): string {
  if (p.includes(" ") || p.includes("\t")) return `"${p}"`;
  return p;
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as Settings;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected JSON object at top level");
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `cannot parse ${path}: ${(err as Error).message}. Refusing to overwrite — fix the file or pass --settings to a different path.`,
    );
  }
}

function serialize(settings: Settings): string {
  return JSON.stringify(settings, null, 2) + "\n";
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o644;
  if (existsSync(path)) {
    try { mode = statSync(path).mode & 0o777; } catch { /* ignore */ }
  }
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

export function registerHook(opts: RegisterOptions = {}): RegisterResult {
  const path = opts.settingsPath ?? getDefaultSettingsPath();
  const binary = opts.binary ?? resolveSelfBinary();
  const startCommand = buildSessionStartCommand(binary);

  const original = readSettings(path);
  const before = serialize(original);
  const settings = JSON.parse(before.trim() === "" ? "{}" : before) as Settings;

  if (!settings.hooks) settings.hooks = {};

  // SessionStart — indexes through the shared service. Use no matcher so the hook
  // fires on every SessionStart subtype: startup, resume, clear, compact. Skipping any of
  // these can leave the graph stale across resumed sessions; the hook is idempotent so
  // re-firing is cheap.
  upsertHook(settings, "SessionStart", null, startCommand, isSessionStartHook);

  // Existing SessionEnd hooks must not stop work belonging to another client.
  // The shared service observes connection lifetimes directly.
  stripEvent(settings, "SessionEnd", isSessionEndHook);

  const after = serialize(settings);
  if (after === before) return { changed: false, path };

  writeAtomically(path, after);
  return { changed: true, path };
}

function upsertHook(
  settings: Settings,
  event: "SessionStart" | "SessionEnd",
  matcher: string | null,
  command: string,
  ownership: (h: HookEntry) => boolean,
): void {
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];

  const list = settings.hooks[event] as MatcherEntry[];

  // First, strip our prior hook from ALL matcher entries in this event so reinstalls
  // that move the hook between matcher scopes don't leave a stale copy behind.
  for (const entry of list) {
    if (!Array.isArray(entry.hooks)) continue;
    entry.hooks = entry.hooks.filter((h) => !ownership(h));
  }

  // Then find (or create) the target entry and add the new command there.
  let target = matcher !== null
    ? list.find((e) => e.matcher === matcher)
    : list.find((e) => e.matcher === undefined || e.matcher === null);

  if (!target) {
    target = matcher !== null ? { matcher, hooks: [] } : { hooks: [] };
    list.push(target);
  }
  if (!Array.isArray(target.hooks)) target.hooks = [];

  target.hooks.push({ type: "command", command });

  // Drop now-empty matcher entries so we don't leave dangling `{ matcher: "startup", hooks: [] }`.
  settings.hooks[event] = list.filter((e) => Array.isArray(e.hooks) && e.hooks.length > 0);
}

export function unregisterHook(opts: { settingsPath?: string } = {}): RegisterResult {
  const path = opts.settingsPath ?? getDefaultSettingsPath();
  if (!existsSync(path)) return { changed: false, path };

  const original = readSettings(path);
  const before = serialize(original);
  const settings = JSON.parse(before.trim() === "" ? "{}" : before) as Settings;

  stripEvent(settings, "SessionStart", isSessionStartHook);
  stripEvent(settings, "SessionEnd", isSessionEndHook);

  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  const after = serialize(settings);
  if (after === before) return { changed: false, path };

  writeAtomically(path, after);
  return { changed: true, path };
}

function stripEvent(
  settings: Settings,
  event: "SessionStart" | "SessionEnd",
  ownership: (h: HookEntry) => boolean,
): void {
  const list = settings.hooks?.[event];
  if (!Array.isArray(list) || list.length === 0) return;

  for (const entry of list) {
    if (!Array.isArray(entry.hooks)) continue;
    entry.hooks = entry.hooks.filter((h) => !ownership(h));
  }

  if (settings.hooks) {
    settings.hooks[event] = list.filter(
      (e) => Array.isArray(e.hooks) && e.hooks.length > 0,
    );
    if (settings.hooks[event]?.length === 0) {
      delete settings.hooks[event];
    }
  }
}

function isSessionStartHook(h: HookEntry): boolean {
  return hasSubcommand(h, START_HOOK_SUFFIX);
}

function isSessionEndHook(h: HookEntry): boolean {
  // Match `... stop-watch` or `... stop-watch --cwd ...`. Require either a leading space
  // or path separator so we don't false-match unrelated commands containing the string.
  if (!hasSubcommand(h, STOP_HOOK_SUFFIX)) return false;
  const cmd = (h.command ?? "");
  return /(?:^|[\s/])stop-watch(?:\s|$)/.test(cmd);
}

function hasSubcommand(h: HookEntry, subcommand: string): boolean {
  if (h === null || typeof h !== "object") return false;
  if (typeof h.command !== "string") return false;
  // Subcommand names (session-start-hook, stop-watch) are unique to Spindle. Match any
  // command running them — covers stale `bun <subcommand>` entries from prior installs.
  return h.command.includes(subcommand);
}
