import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";

setDefaultTimeout(30_000);

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

// Incremental reindex must leave the graph identical to a full reindex of the same files.
describe("incremental reindex keeps the graph consistent", () => {
  let dir: string;
  let store: GraphStore;
  let classes: string;

  const edges = (): string[] => store.db.query<{ t: string; s: string; d: string }, []>(
    `SELECT e.edge_type t, s.label || ':' || s.qualified_name s, d.label || ':' || d.qualified_name d
     FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes d ON d.id = e.target_id ORDER BY 1, 2, 3`,
  ).all().map(r => `${r.t} ${r.s} -> ${r.d}`);
  const nodeNames = (): string[] => store.db.query<{ n: string }, []>(
    "SELECT label || ':' || qualified_name n FROM nodes ORDER BY 1",
  ).all().map(r => r.n);
  const incremental = (): Promise<unknown> => indexProject(dir, store, { mode: "incremental" });

  beforeEach(async () => {
    dir = join(realpathSync(tmpdir()), `spindle-incr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    cpSync(FIXTURE_DIR, dir, { recursive: true });
    classes = join(dir, "force-app", "main", "default", "classes");
    store = new GraphStore(join(dir, "graph.db"));
    await indexProject(dir, store, { mode: "full" });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a changed file keeps the inbound edges from unchanged files", async () => {
    const before = edges();
    expect(before).toContain("CALLS ApexMethod:Orchestrator.run() -> ApexMethod:AccountService.cleanup()");
    appendFileSync(join(classes, "AccountService.cls"), "\n// touched\n");
    await incremental();
    expect(edges()).toEqual(before);
  });

  test("node ids are stable across a reparse of the same symbols", async () => {
    const id = (): number => store.db.query<{ id: number }, []>(
      "SELECT id FROM nodes WHERE label = 'ApexMethod' AND qualified_name = 'AccountService.cleanup()'",
    ).get()!.id;
    const before = id();
    appendFileSync(join(classes, "AccountService.cls"), "\n// touched\n");
    await incremental();
    expect(id()).toBe(before);
  });

  test("an Apex placeholder does not replace real object metadata", async () => {
    const before = edges();
    appendFileSync(join(classes, "CustomerLookup.cls"), "\n// touched\n");
    await incremental();
    const row = store.db.query<{ file_path: string | null; ph: number | null }, []>(
      "SELECT file_path, json_extract(properties, '$.isPlaceholder') ph FROM nodes WHERE label = 'SObject' AND qualified_name = 'Customer__c'",
    ).get()!;
    expect(row.ph).toBe(0);
    expect(row.file_path).toEndWith("Customer__c.object-meta.xml");
    expect(edges()).toEqual(before);
  });

  test("a placeholder object survives the reparse of one of the files that use it", async () => {
    // Account has no object metadata in the fixture: the trigger and AccountService share a placeholder.
    const before = edges();
    appendFileSync(join(classes, "AccountService.cls"), "\n// touched\n");
    await incremental();
    appendFileSync(join(classes, "AccountService.cls"), "\n// touched again\n");
    await incremental();
    expect(edges()).toEqual(before);
    const row = store.db.query<{ file_path: string | null }, []>(
      "SELECT file_path FROM nodes WHERE label = 'SObject' AND qualified_name = 'Account'",
    ).get()!;
    expect(row.file_path).toBeNull();
  });

  test("a database from an older version keeps a placeholder that one file owned", async () => {
    // Older versions stored the placeholder with the path of the file that used it last.
    // Contact is used only by the new trigger, so nothing else can restore it.
    const triggers = join(dir, "force-app", "main", "default", "triggers");
    const trigger = join(triggers, "ContactTrigger.trigger");
    writeFileSync(trigger, "trigger ContactTrigger on Contact (before insert) {\n}\n");
    await incremental();
    const before = edges();
    expect(before).toContain("TRIGGERS_ON ApexTrigger:ContactTrigger -> SObject:Contact");
    store.db.query("UPDATE nodes SET file_path = ? WHERE label = 'SObject' AND qualified_name = 'Contact'").run(trigger);
    store.db.exec("DELETE FROM file_hashes");
    await incremental();
    expect(edges()).toEqual(before);
    await incremental();
    expect(edges()).toEqual(before);
  });

  test("a deleted file leaves no nodes, edges or file hash", async () => {
    rmSync(join(classes, "Orchestrator.cls"));
    await incremental();
    expect(nodeNames().filter(n => n.includes("Orchestrator"))).toEqual([]);
    expect(edges().filter(e => e.includes("Orchestrator"))).toEqual([]);
    const hashes = store.db.query<{ n: number }, []>(
      "SELECT count(*) n FROM file_hashes WHERE file_path LIKE '%Orchestrator%'",
    ).get()!;
    expect(hashes.n).toBe(0);
  });

  test("a full reindex also removes deleted files", async () => {
    rmSync(join(classes, "Orchestrator.cls"));
    await indexProject(dir, store, { mode: "full" });
    expect(nodeNames().filter(n => n.includes("Orchestrator"))).toEqual([]);
  });

  test("a symbol that disappears and comes back gets its inbound edges back", async () => {
    const before = edges();
    const file = join(classes, "AccountService.cls");
    const original = readFileSync(file, "utf8");
    // A broken intermediate save: cleanup() is renamed, so callers lose their target.
    writeFileSync(file, original.replace("public static void cleanup()", "public static void cleanupRenamed()"));
    await incremental();
    expect(edges()).not.toContain("CALLS ApexMethod:Orchestrator.run() -> ApexMethod:AccountService.cleanup()");
    writeFileSync(file, original);
    await incremental();
    expect(edges()).toEqual(before);
  });

  test("a deleted file that comes back gets its inbound edges back", async () => {
    const before = edges();
    const file = join(classes, "AccountService.cls");
    const original = readFileSync(file, "utf8");
    rmSync(file);
    await incremental();
    expect(nodeNames().filter(n => n.startsWith("ApexMethod:AccountService."))).toEqual([]);
    writeFileSync(file, original);
    await incremental();
    expect(edges()).toEqual(before);
  });

  test("an unchanged project does no work and keeps the graph", async () => {
    const before = edges();
    const result = await indexProject(dir, store, { mode: "incremental" });
    expect(result.filesParsed).toBe(0);
    expect(edges()).toEqual(before);
  });

  test("an email template body change causes a reparse", async () => {
    const body = join(dir, "force-app", "main", "default", "email", "Marketing", "CustomerWelcome.email");
    appendFileSync(body, "\nA new line in the body.\n");
    const result = await indexProject(dir, store, { mode: "incremental" });
    expect(result.filesParsed).toBe(1);
  });

  test("a project row that an older version stored under a symlinked path is adopted", async () => {
    const before = edges();
    const link = `${dir}-alias`;
    symlinkSync(dir, link);
    try {
      store.db.query("UPDATE projects SET root_path = ?").run(link);
      store.db.query("UPDATE nodes SET file_path = replace(file_path, ?, ?) WHERE file_path IS NOT NULL").run(dir, link);
      await incremental();
      expect(store.db.query<{ id: number; root_path: string }, []>("SELECT id, root_path FROM projects").all()).toEqual([{ id: 1, root_path: dir }]);
      expect(edges()).toEqual(before);
      const paths = store.db.query<{ n: number }, [string]>("SELECT count(*) n FROM nodes WHERE file_path LIKE ? || '%'").get(link)!;
      expect(paths.n).toBe(0);
    } finally {
      rmSync(link, { force: true });
    }
  });

  test("the same project through a symlink is one project", async () => {
    const link = `${dir}-link`;
    symlinkSync(dir, link);
    try {
      await indexProject(link, store, { mode: "incremental" });
      const projects = store.db.query<{ root_path: string }, []>("SELECT root_path FROM projects").all();
      expect(projects).toEqual([{ root_path: dir }]);
    } finally {
      rmSync(link, { force: true });
    }
  });
});
