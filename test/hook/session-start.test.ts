import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
setDefaultTimeout(30_000);

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSessionStartHook } from "../../src/hook/session-start.ts";
import { startService } from "../../src/service/host.ts";
import type { ServiceConnection } from "../../src/service/client.ts";

const tempDirs: string[] = [];
let previousHome: string | undefined;
let testHome: string;
let host: Awaited<ReturnType<typeof startService>>;
let service: ServiceConnection;
beforeEach(async () => {
  previousHome = process.env["SFDX_GRAPH_HOME"];
  testHome = mkdtempSync(join(tmpdir(), "spindle-hook-home-"));
  process.env["SFDX_GRAPH_HOME"] = testHome;
  const dbPath = join(testHome, "graph.db");
  host = await startService({ port: 0, runtimePath: join(testHome, "service.json"), dbPath });
  service = { port: host.port, token: host.token, dbPath, pid: process.pid };
});

function makeTempDir(): string {
  const dir = join(tmpdir(), `spindle-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await host.close();
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  rmSync(testHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env["SFDX_GRAPH_HOME"];
  else process.env["SFDX_GRAPH_HOME"] = previousHome;
});

describe("runSessionStartHook detection", () => {
  test("skips non-SFDX directories", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "README.md"), "hello");
    const result = await runSessionStartHook({ cwd: dir, skipStdin: true, service });
    expect(result.status).toBe("skipped");
  });

  function writeValidSfdxProject(dir: string): void {
    writeFileSync(
      join(dir, "sfdx-project.json"),
      JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], sourceApiVersion: "64.0" }),
    );
    mkdirSync(join(dir, "force-app", "main", "default", "classes"), { recursive: true });
  }

  test("detects sfdx-project.json and runs an index", async () => {
    const dir = makeTempDir();
    writeValidSfdxProject(dir);

    const result = await runSessionStartHook({ cwd: dir, skipStdin: true, service });
    expect(result.status).toBe("indexed");
  });

  test("walks up from a subdirectory of an SFDX project", async () => {
    const dir = makeTempDir();
    writeValidSfdxProject(dir);
    const sub = join(dir, "force-app", "main", "default", "classes");

    const result = await runSessionStartHook({ cwd: sub, skipStdin: true, service });
    expect(result.status).toBe("indexed");
    if (result.status === "indexed") {
      expect(result.projectRoot).toBe(dir);
    }
  });

  test("skips gracefully when sfdx-project.json is malformed", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [] }));
    const result = await runSessionStartHook({ cwd: dir, skipStdin: true, service });
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toContain("index-failed");
    }
  });

  test("force-app-only directory triggers detection but indexer skip is graceful", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "force-app", "main", "default", "classes"), { recursive: true });

    const result = await runSessionStartHook({ cwd: dir, skipStdin: true, service });
    // Detected as SFDX, but indexProject needs sfdx-project.json — must not crash.
    expect(["indexed", "skipped"]).toContain(result.status);
  });
});
