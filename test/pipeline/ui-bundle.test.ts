// React UI bundles (the UIBundle metadata type). The fixture is one bundle with GraphQL
// queries and mutations, one `.graphql` file and Apex REST calls, plus the Apex classes and
// the object that those references point at.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { Confidence } from "../../src/model/confidence.ts";
import { EdgeType } from "../../src/model/edge-types.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { parseGraphql, type GqlField, type GqlSelection } from "../../src/parsers/ui-bundle/graphql.ts";
import { extractUiBundle } from "../../src/parsers/ui-bundle/parse.ts";
import { discoverApexFiles } from "../../src/pipeline/discover.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { handler as fieldUsage } from "../../src/tools/get-field-usage.ts";

setDefaultTimeout(30_000);

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUNDLE = join(FIXTURES, "ui-bundle", "uiBundles", "customerPortal");
const read = (path: string): string => readFileSync(join(BUNDLE, path), "utf8");

describe("GraphQL reader", () => {
  test("reads operations, fragments, arguments and directives", () => {
    const doc = parseGraphql(`
      # a comment
      query Q($first: Int = 10, $ids: [ID!]!) {
        uiapi { query { Account(first: $first, where: { Name: { like: "A%" } }) @skip(if: false) {
          edges { node { Id alias: Name @optional { value } ...F ... on Account { Phone { value } } } }
        } } }
      }
      fragment F on Account { Industry { value } }
    `);
    if (doc === null) throw new Error("the document did not parse");
    expect(doc.operations.map((o) => o.kind)).toEqual(["query"]);
    expect(doc.fragments.map((f) => `${f.name} on ${f.typeCondition}`)).toEqual(["F on Account"]);
    const fieldAt = (selections: GqlSelection[], name: string): GqlField => {
      const found = selections.find((s): s is GqlField => s.kind === "field" && s.name === name);
      if (found === undefined) throw new Error(`no field ${name}`);
      return found;
    };
    const query = fieldAt(fieldAt(doc.operations[0]!.selections, "uiapi").selections, "query");
    const account = fieldAt(query.selections, "Account");
    expect(account.line).toBe(4);
    expect(account.args["where"]).toEqual({
      kind: "object",
      fields: { Name: { kind: "object", fields: { like: { kind: "scalar", value: "A%" } } } },
    });
    const node = fieldAt(fieldAt(account.selections, "edges").selections, "node");
    expect(node.selections.map((s) => (s.kind === "field" ? (s.alias ?? s.name) : s.kind))).toEqual(["Id", "alias", "spread", "inline"]);
  });

  test("returns null for text that is not GraphQL", () => {
    expect(parseGraphql("Ask your admin about uiapi { and stop")).toBeNull();
    expect(parseGraphql("uiapi is the name of an API")).toBeNull();
  });
});

describe("UI bundle extraction", () => {
  const files = [
    "customerPortal.uibundle-meta.xml",
    "ui-bundle.json",
    "src/api/customers.ts",
    "src/api/orders.graphql",
    "src/api/mutations.ts",
    "src/pages/Login.tsx",
  ].map((path) => ({ path, absolutePath: `/p/${path}`, source: read(path) }));
  const parsed = extractUiBundle("customerPortal", files);

  const edges = (type: string) => parsed.edges.filter((e) => e.edgeType === type);
  const fieldKey = (e: (typeof parsed.edges)[number]): string =>
    `${(e.properties?.["soqlObjectPath"] as string[]).join(">")}:${String(e.properties?.["soqlFieldPath"])}`;

  test("emits one bundle node with the label and the description of the meta file", () => {
    expect(parsed.nodes).toHaveLength(1);
    const node = parsed.nodes[0]!;
    expect(node.label).toBe(NodeLabel.UiBundle);
    expect(node.qualifiedName).toBe("customerPortal");
    expect(node.properties?.["masterLabel"]).toBe("Customer Portal");
    expect(node.properties?.["isActive"]).toBe(true);
    expect(node.properties?.["outputDir"]).toBe("out");
  });

  test("reads selected fields, fragment fields, filters and order fields of a query", () => {
    const keys = edges(EdgeType.UiBundleUsesField)
      .filter((e) => e.properties?.["sourceFile"] === "/p/src/api/customers.ts")
      .map(fieldKey)
      .sort();
    expect(keys).toEqual(
      [
        "Customer__c:Email__c",
        "Customer__c:Tier__c",
        "Customer__c:Status__c",
        "Customer__c:Region__c",
        "Customer__c:Sort_Key__c",
        "Customer__c:Owner.Name",
        "Customer__c>Orders__r:Amount__c",
      ].sort(),
    );
  });

  test("reads parent relationships, type conditions and aggregates in a .graphql file", () => {
    const keys = edges(EdgeType.UiBundleUsesField)
      .filter((e) => e.properties?.["sourceFile"] === "/p/src/api/orders.graphql")
      .map(fieldKey)
      .sort();
    expect(keys).toEqual(
      [
        "Order__c:Amount__c",
        "Order__c:Customer__c", // the lookup behind Customer__r
        "Order__c:Customer__r.Email__c",
        "Order__c:Customer__r.Tier__c",
        "Customer__c:Nickname__c", // `... on Customer__c` below a polymorphic relationship
        "Order__c:Stage__c",
        "Order__c:Total__c",
      ].sort(),
    );
  });

  test("reads the object and the inline input fields of a mutation", () => {
    const keys = edges(EdgeType.UiBundleUsesField)
      .filter((e) => e.properties?.["sourceFile"] === "/p/src/api/mutations.ts")
      .map(fieldKey)
      .sort();
    expect(keys).toEqual(["Customer__c:Created_Flag__c", "Customer__c:Email__c", "Customer__c:Nickname__c"]);
    const objects = edges(EdgeType.UiBundleUsesObject).map((e) => `${e.toQName}:${String(e.properties?.["operation"])}`);
    expect(objects).toContain("Customer__c:create");
    expect(objects).toContain("Order__c:update");
    // A template with no gql tag is read too, when it holds a uiapi document.
    expect(objects).toContain("Invoice__c:delete");
    expect(objects).toContain("Customer__c:query");
    expect(objects).toContain("Order__c:aggregate");
  });

  test("gives each field edge a line in its source file", () => {
    const email = edges(EdgeType.UiBundleUsesField).find(
      (e) => e.properties?.["sourceFile"] === "/p/src/api/customers.ts" && fieldKey(e) === "Customer__c:Email__c",
    );
    expect(email?.sourceLine).toBe(22);
    expect(email?.confidence).toBe(Confidence.Resolved);
    const amount = edges(EdgeType.UiBundleUsesField).find(
      (e) => e.properties?.["sourceFile"] === "/p/src/api/orders.graphql" && fieldKey(e) === "Order__c:Amount__c",
    );
    expect(amount?.sourceLine).toBe(8);
  });

  test("reads Apex REST paths, with a wildcard for each dynamic part", () => {
    const paths = edges(EdgeType.UiBundleUsesApex).map((e) => String(e.properties?.["apexRestPath"])).sort();
    expect(paths).toEqual(["/auth/login", "/auth/session/*", "/portal/profile", "/unknown/thing"]);
    for (const e of edges(EdgeType.UiBundleUsesApex)) {
      expect(e.toLabel).toBe(NodeLabel.ApexClass);
      expect(e.confidence).toBe(Confidence.Heuristic);
    }
  });

  test("does not read text that is not a uiapi document", () => {
    const all = JSON.stringify(parsed.edges);
    expect(all).not.toContain("Fake__c");
    expect(all).not.toContain("Not_A_Field__c");
  });

  test("reports a file that does not parse and keeps the rest", () => {
    const broken = extractUiBundle("customerPortal", [
      ...files,
      { path: "src/broken.ts", absolutePath: "/p/src/broken.ts", source: "const Q = gql`query { uiapi {`; const = ;;; {" },
    ]);
    expect(broken.warnings.some((w) => w.message.includes("src/broken.ts"))).toBe(true);
    expect(broken.edges.length).toBe(parsed.edges.length);
  });
});

describe("UI bundle in the pipeline", () => {
  let dir: string;
  let store: GraphStore;
  let projectId: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "spindle-ui-bundle-"));
    cpSync(join(FIXTURES, "sample-sfdx-project"), dir, { recursive: true });
    cpSync(join(FIXTURES, "ui-bundle"), join(dir, "force-app/main/default"), { recursive: true });
    // Build output, packages and tests are not source: each holds a query on a decoy object.
    const bundle = join(dir, "force-app/main/default/uiBundles/customerPortal");
    const decoy = "export const Q = `query { uiapi { query { Decoy__c { edges { node { Id } } } } } }`;";
    for (const sub of ["out/assets", "node_modules/pkg", "src/__tests__"]) {
      mkdirSync(join(bundle, sub), { recursive: true });
      writeFileSync(join(bundle, sub, "decoy.js"), decoy);
    }
    writeFileSync(join(bundle, "src/api/customers.test.ts"), decoy);
    store = new GraphStore(join(dir, "graph.db"));
    await indexProject(dir, store, { mode: "full" });
    projectId = store.db.query<{ id: number }, []>("SELECT id FROM projects LIMIT 1").get()!.id;
  });

  afterAll(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const targets = (edgeType: string): string[] =>
    store.db
      .query<{ q: string }, [number, string]>(
        `SELECT DISTINCT t.qualified_name AS q FROM edges e
         JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ? AND e.edge_type = ? AND s.label = 'UiBundle' ORDER BY q`,
      )
      .all(projectId, edgeType)
      .map((r) => r.q);

  test("discovers the bundle as one file with its source files", async () => {
    const found = (await discoverApexFiles(dir)).filter((f) => f.kind === "ui-bundle");
    expect(found).toHaveLength(1);
    expect(found[0]!.bundleName).toBe("customerPortal");
    expect(found[0]!.bundleFiles!.map((f) => f.fileName).sort()).toEqual([
      "customerPortal.uibundle-meta.xml",
      "src/api/customers.ts",
      "src/api/mutations.ts",
      "src/api/orders.graphql",
      "src/pages/Login.tsx",
      "ui-bundle.json",
    ]);
  });

  test("links the bundle to fields, with relationships resolved from metadata", () => {
    expect(targets(EdgeType.UiBundleUsesField)).toEqual(
      [
        "Customer__c.Created_Flag__c",
        "Customer__c.Email__c",
        "Customer__c.Nickname__c",
        "Customer__c.Region__c",
        "Customer__c.Sort_Key__c",
        "Customer__c.Status__c",
        "Customer__c.Tier__c",
        "Order__c.Amount__c",
        "Order__c.Customer__c",
        "Order__c.Stage__c",
        "Order__c.Total__c",
      ].sort(),
    );
  });

  test("links the bundle to objects and to Apex REST classes", () => {
    expect(targets(EdgeType.UiBundleUsesObject)).toEqual(["Customer__c", "Invoice__c", "Order__c"]);
    expect(targets(EdgeType.UiBundleUsesApex)).toEqual(["PortalAuthResource", "PortalProfileResource"]);
  });

  test("get_field_usage lists the bundle with the file and the line of the reference", async () => {
    const result = (await fieldUsage({ project_id: projectId, field: "Customer__c.Email__c" }, store)) as {
      ui_bundles: { qualified_name: string; file_path: string; line: number; scope: string }[];
      coverage: { authoritative: string[] };
    };
    const files = result.ui_bundles.map((u) => u.file_path.split("customerPortal/")[1]).sort();
    expect(files).toEqual(["src/api/customers.ts", "src/api/mutations.ts", "src/api/orders.graphql"]);
    expect(result.ui_bundles.every((u) => u.qualified_name === "customerPortal" && u.scope === "field")).toBe(true);
    expect(result.coverage.authoritative).toContain("ui_bundles");
  });

  test("get_field_usage lists an object-level use when no field-level use is known", async () => {
    // The update of Order__c gets its input from a variable, so each field is a possible use.
    type Report = { ui_bundles: { qualified_name: string; scope: string; context: string; file_path: string }[] };
    const result = (await fieldUsage({ project_id: projectId, field: "Order__c.Notes__c" }, store)) as Report;
    expect(result.ui_bundles).toHaveLength(1);
    expect(result.ui_bundles[0]!.scope).toBe("object");
    expect(result.ui_bundles[0]!.context).toBe("UI_API_UPDATE");
    expect(result.ui_bundles[0]!.file_path.endsWith("src/api/mutations.ts")).toBe(true);
    const direct = (await fieldUsage(
      { project_id: projectId, field: "Order__c.Notes__c", include_indirect: false },
      store,
    )) as Report;
    expect(direct.ui_bundles).toEqual([]);
    // A delete names no field, and a query with literal arguments names each of its fields.
    const invoice = (await fieldUsage({ project_id: projectId, field: "Invoice__c.Total__c" }, store)) as Report;
    expect(invoice.ui_bundles).toEqual([]);
    const customer = (await fieldUsage({ project_id: projectId, field: "Customer__c.Other__c" }, store)) as Report;
    expect(customer.ui_bundles).toEqual([]);
  });

  test("an edit to one source file of the bundle updates the graph on an incremental index", async () => {
    const path = join(dir, "force-app/main/default/uiBundles/customerPortal/src/api/mutations.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace("Created_Flag__c", "Renamed_Flag__c"));
    await indexProject(dir, store, { mode: "incremental" });
    const fields = targets(EdgeType.UiBundleUsesField);
    expect(fields).toContain("Customer__c.Renamed_Flag__c");
    expect(fields).not.toContain("Customer__c.Created_Flag__c");
    expect(targets(EdgeType.UiBundleUsesApex)).toEqual(["PortalAuthResource", "PortalProfileResource"]);
  });

  test("an Apex REST class that is deleted and comes back gets its edge back", async () => {
    const path = join(dir, "force-app/main/default/classes/PortalAuthResource.cls");
    const source = readFileSync(path, "utf8");
    rmSync(path);
    await indexProject(dir, store, { mode: "incremental" });
    expect(targets(EdgeType.UiBundleUsesApex)).toEqual(["PortalProfileResource"]);
    writeFileSync(path, source);
    await indexProject(dir, store, { mode: "incremental" });
    expect(targets(EdgeType.UiBundleUsesApex)).toEqual(["PortalAuthResource", "PortalProfileResource"]);
  });

  test("a changed urlMapping moves the edge on an incremental index", async () => {
    const path = join(dir, "force-app/main/default/classes/PortalProfileResource.cls");
    writeFileSync(path, readFileSync(path, "utf8").replace("/portal/profile", "/portal/other"));
    await indexProject(dir, store, { mode: "incremental" });
    expect(targets(EdgeType.UiBundleUsesApex)).toEqual(["PortalAuthResource"]);
  });

  test("a new Apex REST class gets the edge from a path that had no class before", async () => {
    const path = join(dir, "force-app/main/default/classes/UnknownThingResource.cls");
    writeFileSync(path, "@RestResource(urlMapping='/unknown/*')\nglobal class UnknownThingResource {\n  @HttpGet global static String read() { return 'ok'; }\n}\n");
    await indexProject(dir, store, { mode: "incremental" });
    expect(targets(EdgeType.UiBundleUsesApex)).toEqual(["PortalAuthResource", "UnknownThingResource"]);
  });

  test("the graph after the incremental indexes is the same as after a full index", async () => {
    const snapshot = (): string[] =>
      store.db
        .query<{ row: string }, []>(
          `SELECT e.edge_type || ' ' || s.label || ':' || s.qualified_name || ' -> ' || t.label || ':' || t.qualified_name
             || ' @' || COALESCE(e.source_line, 0) AS row
           FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id ORDER BY 1`,
        )
        .all()
        .map((r) => r.row);
    const incremental = snapshot();
    await indexProject(dir, store, { mode: "full" });
    expect(snapshot()).toEqual(incremental);
  });
});
