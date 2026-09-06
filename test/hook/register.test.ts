import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerHook, unregisterHook } from "../../src/hook/register.ts";

function newSettingsPath(): string {
  const dir = join(tmpdir(), `spindle-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "settings.json");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("registerHook", () => {
  let settingsPath: string;

  beforeEach(() => {
    settingsPath = newSettingsPath();
  });

  afterEach(() => {
    try { rmSync(settingsPath, { force: true }); } catch { /* ignore */ }
  });

  test("creates settings.json with SessionStart; shared clients own shutdown", () => {
    const result = registerHook({ settingsPath, binary: "/opt/spindle/sfdx-graph-mcp" });
    expect(result.changed).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const json = readJson(settingsPath) as { hooks: { SessionStart: unknown[]; SessionEnd: unknown[] } };
    expect(Array.isArray(json.hooks.SessionStart)).toBe(true);
    expect(json.hooks.SessionEnd).toBeUndefined();

    // SessionStart entry has no matcher so it fires on all subtypes (startup/resume/clear/compact).
    const start = json.hooks.SessionStart[0] as { matcher?: string; hooks: { command: string }[] };
    expect(start.matcher).toBeUndefined();
    expect(start.hooks[0]?.command).toContain("session-start-hook");

  });

  test("removes legacy SessionEnd stop-watch without touching other hooks", () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [
      { type: "command", command: "/old/sfdx-graph-mcp stop-watch" },
      { type: "command", command: "echo unrelated" },
    ] }] } }));
    registerHook({ settingsPath, binary: "/opt/spindle/sfdx-graph-mcp" });
    const json = readJson(settingsPath) as { hooks: { SessionEnd: { hooks: { command: string }[] }[] } };
    expect(json.hooks.SessionEnd[0]!.hooks.map(h => h.command)).toEqual(["echo unrelated"]);
  });

  test("preserves unrelated settings", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: "dark", model: "claude-opus-4-7", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } }, null, 2),
    );

    registerHook({ settingsPath, binary: "/opt/spindle/sfdx-graph-mcp" });

    const json = readJson(settingsPath) as { theme: string; model: string; hooks: { PreToolUse: unknown[]; SessionStart: unknown[] } };
    expect(json.theme).toBe("dark");
    expect(json.model).toBe("claude-opus-4-7");
    expect(json.hooks.PreToolUse).toHaveLength(1);
    expect(json.hooks.SessionStart).toHaveLength(1);
  });

  test("is idempotent: second run is a no-op", () => {
    registerHook({ settingsPath, binary: "/opt/spindle/sfdx-graph-mcp" });
    const second = registerHook({ settingsPath, binary: "/opt/spindle/sfdx-graph-mcp" });
    expect(second.changed).toBe(false);
  });

  test("replaces stale Spindle entries when binary path changes", () => {
    registerHook({ settingsPath, binary: "/old/path/sfdx-graph-mcp" });
    registerHook({ settingsPath, binary: "/new/path/sfdx-graph-mcp" });

    const json = readJson(settingsPath) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
    const commands = json.hooks.SessionStart[0]?.hooks.map((h) => h.command) ?? [];
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("/new/path/sfdx-graph-mcp");
  });

  test("coexists with other SessionStart hooks across matchers", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { SessionStart: [
        { hooks: [{ type: "command", command: "echo no-matcher" }] },
        { matcher: "startup", hooks: [{ type: "command", command: "echo other-startup" }] },
      ] } }, null, 2),
    );

    registerHook({ settingsPath, binary: "/opt/spindle/sfdx-graph-mcp" });

    const json = readJson(settingsPath) as { hooks: { SessionStart: { matcher?: string; hooks: { command: string }[] }[] } };
    const all = json.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
    expect(all).toContain("echo no-matcher");
    expect(all).toContain("echo other-startup");
    expect(all.some((c) => c.includes("session-start-hook"))).toBe(true);
  });

  test("relocates a previously-startup-matchered Spindle entry to no-matcher", () => {
    // Simulate v1.1.0 initial install where the hook was placed under matcher: "startup".
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { SessionStart: [
        { matcher: "startup", hooks: [
          { type: "command", command: "echo other-startup" },
          { type: "command", command: "/old/spindle session-start-hook" },
        ] },
      ] } }, null, 2),
    );

    registerHook({ settingsPath, binary: "/new/spindle/sfdx-graph-mcp" });

    const json = readJson(settingsPath) as { hooks: { SessionStart: { matcher?: string; hooks: { command: string }[] }[] } };
    const spindleEntries = json.hooks.SessionStart.flatMap((e) => e.hooks.filter((h) => h.command.includes("session-start-hook")));
    expect(spindleEntries).toHaveLength(1);
    expect(spindleEntries[0]?.command).toContain("/new/spindle/sfdx-graph-mcp");

    // The startup-matcher entry should still exist (it has another hook); Spindle's copy
    // moved to a no-matcher entry.
    const startupEntry = json.hooks.SessionStart.find((e) => e.matcher === "startup");
    expect(startupEntry?.hooks.map((h) => h.command)).toEqual(["echo other-startup"]);
    const noMatcherEntry = json.hooks.SessionStart.find((e) => e.matcher === undefined);
    expect(noMatcherEntry?.hooks.some((h) => h.command.includes("session-start-hook"))).toBe(true);
  });

  test("refuses to overwrite malformed settings", () => {
    writeFileSync(settingsPath, "{ not valid json");
    expect(() => registerHook({ settingsPath, binary: "/opt/spindle/sfdx-graph-mcp" })).toThrow();
  });
});

describe("unregisterHook", () => {
  let settingsPath: string;

  beforeEach(() => {
    settingsPath = newSettingsPath();
  });

  afterEach(() => {
    try { rmSync(settingsPath, { force: true }); } catch { /* ignore */ }
  });

  test("removes both hook entries and leaves the rest", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: "dark", hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo other" }] }] } }, null, 2),
    );

    registerHook({ settingsPath, binary: "/opt/spindle/sfdx-graph-mcp" });
    const result = unregisterHook({ settingsPath });
    expect(result.changed).toBe(true);

    const json = readJson(settingsPath) as { theme: string; hooks?: { SessionStart?: unknown[]; SessionEnd?: unknown[] } };
    expect(json.theme).toBe("dark");
    expect(json.hooks?.SessionEnd).toBeUndefined();
    const startupCommands = (json.hooks?.SessionStart as { hooks: { command: string }[] }[] | undefined)?.[0]?.hooks.map((h) => h.command) ?? [];
    expect(startupCommands).toEqual(["echo other"]);
  });

  test("no-op when settings.json missing", () => {
    const result = unregisterHook({ settingsPath });
    expect(result.changed).toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
  });

  test("drops empty hooks object completely", () => {
    registerHook({ settingsPath, binary: "/opt/spindle/sfdx-graph-mcp" });
    unregisterHook({ settingsPath });
    const json = readJson(settingsPath) as { hooks?: unknown };
    expect(json.hooks).toBeUndefined();
  });
});
