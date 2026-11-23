import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { parseApex } from "../../src/parsers/apex/parse.ts";

setDefaultTimeout(30_000);

describe("Apex call resolution", () => {
  let dir: string;
  let store: GraphStore;
  let edges: string[];

  beforeAll(async () => {
    dir = join(realpathSync(tmpdir()), `spindle-calls-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const classes = join(dir, "force-app", "main", "default", "classes");
    const triggers = join(dir, "force-app", "main", "default", "triggers");
    mkdirSync(classes, { recursive: true });
    mkdirSync(triggers, { recursive: true });
    writeFileSync(join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }));
    writeFileSync(join(classes, "Worker.cls"), `public class Worker {
  public class Inner {
    public static void util() {}
  }
  public void run() {
    System.debug(helper());
    this.finish();
    Inner.util();
    Worker.Inner.util();
  }
  private String helper() { return ''; }
  private void finish() {}
  public static void handle(List<Account> records) {}
}`);
    // Alpha and Beta each have an inner class Wrapper; Gamma has none.
    for (const name of ["Alpha", "Beta"]) {
      writeFileSync(join(classes, `${name}.cls`), `public class ${name} {
  public class Wrapper { public static void build() {} }
  public void run() { Wrapper.build(); Wrapper w = new Wrapper(); }
}`);
    }
    writeFileSync(join(classes, "Gamma.cls"), `public class Gamma {
  public void run() { Wrapper.build(); Beta.Wrapper.build(); }
}`);
    writeFileSync(join(triggers, "AccountTrigger.trigger"), `trigger AccountTrigger on Account (before insert) {
  Worker.handle(Trigger.new);
  Worker w = new Worker();
  List<List<SObject>> found = [FIND 'x' IN ALL FIELDS RETURNING Contact(Id)];
}`);
    store = new GraphStore(join(dir, "graph.db"));
    await indexProject(dir, store, { mode: "full" });
    edges = store.db.query<{ t: string; s: string; d: string }, []>(
      `SELECT e.edge_type t, s.label || ':' || s.qualified_name s, d.label || ':' || d.qualified_name d
       FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes d ON d.id = e.target_id`,
    ).all().map(r => `${r.t} ${r.s} -> ${r.d}`);
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unqualified call in the arguments of a qualified call has no receiver", () => {
    const parsed = parseApex("X.cls", "public class X { void a() { System.debug(helper()); } String helper() { return ''; } }");
    const call = parsed.unresolved.find(u => u.kind === "call" && u.calleeName === "helper");
    expect(call).toMatchObject({ receiverText: null });
  });

  test("resolves an unqualified call nested in another call", () => {
    expect(edges).toContain("CALLS ApexMethod:Worker.run() -> ApexMethod:Worker.helper()");
  });

  test("resolves a call on this", () => {
    expect(edges).toContain("CALLS ApexMethod:Worker.run() -> ApexMethod:Worker.finish()");
  });

  test("resolves a static call on an inner class, short and qualified", () => {
    expect(edges.filter(e => e === "CALLS ApexMethod:Worker.run() -> ApexMethod:Worker.Inner.util()")).toHaveLength(2);
  });

  test("an inner class name resolves in its enclosing class, not in another class", () => {
    for (const name of ["Alpha", "Beta"]) {
      expect(edges).toContain(`CALLS ApexMethod:${name}.run() -> ApexMethod:${name}.Wrapper.build()`);
      expect(edges).toContain(`INSTANTIATES ApexMethod:${name}.run() -> ApexClass:${name}.Wrapper`);
    }
    expect(edges).not.toContain("CALLS ApexMethod:Alpha.run() -> ApexMethod:Beta.Wrapper.build()");
    expect(edges).not.toContain("INSTANTIATES ApexMethod:Alpha.run() -> ApexClass:Beta.Wrapper");
  });

  test("a short name that two classes have gives no edge; the qualified name does", () => {
    expect(edges.filter(e => e.startsWith("CALLS ApexMethod:Gamma.run() ->"))).toEqual(["CALLS ApexMethod:Gamma.run() -> ApexMethod:Beta.Wrapper.build()"]);
  });

  test("resolves calls and instantiations in a trigger body", () => {
    expect(edges).toContain("CALLS ApexTrigger:AccountTrigger -> ApexMethod:Worker.handle(List)");
    expect(edges).toContain("INSTANTIATES ApexTrigger:AccountTrigger -> ApexClass:Worker");
  });

  test("keeps a SOSL query in a trigger body", () => {
    expect(edges).toContain("SOSL_QUERIES ApexTrigger:AccountTrigger -> SObject:Contact");
  });
});
