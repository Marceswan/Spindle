import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("production bundle defers Explore and keeps initial JavaScript below 200 kB", () => {
  const out = mkdtempSync(join(tmpdir(), "spindle-bundle-"));
  const web = fileURLToPath(new URL("../../web/", import.meta.url));
  try {
    const build = Bun.spawnSync(
      [
        process.execPath,
        join(web, "node_modules/vite/bin/vite.js"),
        "build",
        "--manifest",
        "--outDir",
        out,
      ],
      { cwd: web, env: { ...process.env, NODE_ENV: "production" } },
    );
    expect(build.exitCode).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(out, ".vite/manifest.json"), "utf8"),
    ) as Record<
      string,
      { file: string; imports?: string[]; isDynamicEntry?: boolean }
    >;
    expect(manifest["src/tabs/explore.tsx"]?.isDynamicEntry).toBe(true);
    const loaded = new Set<string>();
    const visit = (key: string): void => {
      if (loaded.has(key)) return;
      loaded.add(key);
      for (const dependency of manifest[key]!.imports ?? []) visit(dependency);
    };
    visit("index.html");
    expect(loaded.has("src/tabs/explore.tsx")).toBe(false);
    const initialBytes = [...loaded].reduce(
      (bytes, key) => bytes + statSync(join(out, manifest[key]!.file)).size,
      0,
    );
    expect(initialBytes).toBeLessThan(200_000);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 30_000);
