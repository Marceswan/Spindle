import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
setDefaultTimeout(30_000);

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSessionStartHook } from "../../src/hook/session-start.ts";


const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `spindle-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env["SFDX_GRAPH_HOME"];
  process.env["SFDX_GRAPH_HOME"] = makeTempDir();
});

afterEach(async () => {
  await Bun.sleep(1500); // shared service idle shutdown completes before removing its database
  if (previousHome === undefined) delete process.env["SFDX_GRAPH_HOME"];
  else process.env["SFDX_GRAPH_HOME"] = previousHome;
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("runSessionStartHook detection", () => {
  test("skips non-SFDX directories", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "README.md"), "hello");
    const result = await runSessionStartHook({ cwd: dir, skipStdin: true });
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

    const result = await runSessionStartHook({ cwd: dir, skipStdin: true });
    expect(result.status).toBe("indexed");
  });

  test("walks up from a subdirectory of an SFDX project", async () => {
    const dir = makeTempDir();
    writeValidSfdxProject(dir);
    const sub = join(dir, "force-app", "main", "default", "classes");

    const result = await runSessionStartHook({ cwd: sub, skipStdin: true });
    expect(result.status).toBe("indexed");
    if (result.status === "indexed") {
      expect(result.projectRoot).toBe(dir);
    }
  });

  test("skips gracefully when sfdx-project.json is malformed", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [] }));
    const result = await runSessionStartHook({ cwd: dir, skipStdin: true });
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toContain("index-failed");
    }
  });

  test("force-app-only directory triggers detection but indexer skip is graceful", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "force-app", "main", "default", "classes"), { recursive: true });

    const result = await runSessionStartHook({ cwd: dir, skipStdin: true });
    // Detected as SFDX, but indexProject needs sfdx-project.json — must not crash.
    expect(["indexed", "skipped"]).toContain(result.status);
  });
});
