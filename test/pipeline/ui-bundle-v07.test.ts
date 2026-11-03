// v0.7 features: member-expression calls, .d.ts indexing, GraphQL operation extraction,
// and TypeScript Compiler API enrichment.

import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { EdgeType } from "../../src/model/edge-types.ts";

setDefaultTimeout(60_000);

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

type NodeRow = {
  id: number;
  label: string;
  name: string;
  qualified_name: string;
  properties: string;
};

function findNode(
  store: GraphStore,
  projectId: number,
  label: string,
  qname: string,
): NodeRow | null {
  return store.db
    .query<NodeRow, [number, string, string]>(
      "SELECT id, label, name, qualified_name, properties FROM nodes WHERE project_id = ? AND label = ? AND qualified_name = ?",
    )
    .get(projectId, label, qname);
}

function findNodes(store: GraphStore, projectId: number, label: string): NodeRow[] {
  return store.db
    .query<NodeRow, [number, string]>(
      "SELECT id, label, name, qualified_name, properties FROM nodes WHERE project_id = ? AND label = ?",
    )
    .all(projectId, label);
}

function edgeExists(
  store: GraphStore,
  projectId: number,
  edgeType: string,
  fromQNameLike: string,
  toQNameLike: string,
): boolean {
  type Row = { n: number };
  const row = store.db
    .query<Row, [number, string, string, string]>(
      `SELECT COUNT(*) AS n FROM edges e
       JOIN nodes s ON s.id = e.source_id
       JOIN nodes t ON t.id = e.target_id
       WHERE e.project_id = ? AND e.edge_type = ?
         AND s.qualified_name LIKE ?
         AND t.qualified_name LIKE ?`,
    )
    .get(projectId, edgeType, `%${fromQNameLike}%`, `%${toQNameLike}%`);
  return (row?.n ?? 0) > 0;
}

function countEdgesByType(store: GraphStore, projectId: number, edgeType: string): number {
  type Row = { n: number };
  return store.db
    .query<Row, [number, string]>(
      "SELECT COUNT(*) AS n FROM edges WHERE project_id = ? AND edge_type = ?",
    )
    .get(projectId, edgeType)?.n ?? 0;
}

describe("uiBundle pipeline v0.7", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-uibundle-v07-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    cpSync(join(FIXTURE_DIR, "force-app"), join(tempDir, "force-app"), { recursive: true });
    cpSync(join(FIXTURE_DIR, "sfdx-project.json"), join(tempDir, "sfdx-project.json"));
    const dbDir = join(tempDir, ".sfdx-graph");
    mkdirSync(dbDir, { recursive: true });
    store = new GraphStore(join(dbDir, "graph.db"));
    await indexProject(tempDir, store, { mode: "full" });
    const row = store.db.query<{ id: number }, []>("SELECT id FROM projects LIMIT 1").get();
    projectId = row?.id ?? 1;

    cleanup = () => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    };
  });

  afterAll(() => {
    store.close();
    cleanup();
  });

  // --- .d.ts indexing ---
  describe(".d.ts indexing", () => {
    test("emits TsInterface nodes for ambient interfaces", () => {
      const agentCtx = findNode(
        store,
        projectId,
        NodeLabel.TsInterface,
        "uiBundle:agentConsole:src/types/globals.d.ts::AgentContext",
      );
      expect(agentCtx).not.toBeNull();
      const props = JSON.parse(agentCtx!.properties) as Record<string, unknown>;
      expect(props["ambient"]).toBe(true);

      const extended = findNode(
        store,
        projectId,
        NodeLabel.TsInterface,
        "uiBundle:agentConsole:src/types/globals.d.ts::ExtendedContext",
      );
      expect(extended).not.toBeNull();
    });

    test("emits TsTypeAlias node for ambient type alias", () => {
      const tyAlias = findNode(
        store,
        projectId,
        NodeLabel.TsTypeAlias,
        "uiBundle:agentConsole:src/types/globals.d.ts::ContextResolver",
      );
      expect(tyAlias).not.toBeNull();
    });

    test("emits TS_TYPE_EXTENDS edge for `interface ExtendedContext extends AgentContext`", () => {
      expect(
        edgeExists(
          store,
          projectId,
          EdgeType.TsTypeExtends,
          "src/types/globals.d.ts::ExtendedContext",
          "src/types/globals.d.ts::AgentContext",
        ),
      ).toBe(true);
    });

    test("does NOT emit runtime TsFunction nodes from .d.ts declarations", () => {
      // legacyHelper is declared via `declare function legacyHelper(...)` — TypeDecl, not Export.
      const legacy = findNode(
        store,
        projectId,
        NodeLabel.TsFunction,
        "uiBundle:agentConsole:src/types/globals.d.ts::legacyHelper",
      );
      expect(legacy).toBeNull();
    });
  });

  // --- Member-expression calls ---
  describe("member-expression calls", () => {
    test("Utils.cn(...) resolves via namespace import to TsFunction cn", () => {
      // graphqlClient.ts::classNames calls Utils.cn() where Utils is `import * as Utils from "@/lib/utils"`.
      expect(
        edgeExists(
          store,
          projectId,
          EdgeType.TsCalls,
          "src/api/graphqlClient.ts::classNames",
          "src/lib/utils.ts::cn",
        ),
      ).toBe(true);
    });

    test("TS_IMPLEMENTS edge emitted for class implementing imported interface", () => {
      // ContextHolder implements ExtendedContext (imported from @/types/globals)
      expect(
        edgeExists(
          store,
          projectId,
          EdgeType.TsImplements,
          "src/api/graphqlClient.ts::ContextHolder",
          "src/types/globals.d.ts::ExtendedContext",
        ),
      ).toBe(true);
    });
  });

  // --- GraphQL extraction ---
  describe("GraphQL operation extraction", () => {
    test("emits GraphqlOperation node for standalone .graphql file query", () => {
      const ops = findNodes(store, projectId, NodeLabel.GraphqlOperation);
      const names = ops.map((o) => o.name);
      expect(names).toContain("GetCustomerEmail");
      expect(names).toContain("UpdateTier");
    });

    test("emits GraphqlFragment node for fragment definition", () => {
      const frags = findNodes(store, projectId, NodeLabel.GraphqlFragment);
      const names = frags.map((f) => f.name);
      expect(names).toContain("CustomerCore");
    });

    test("emits GraphqlOperation for inline gql tagged template", () => {
      const ops = findNodes(store, projectId, NodeLabel.GraphqlOperation);
      const names = ops.map((o) => o.name);
      expect(names).toContain("InlineCustomer");
    });

    test("cross-domain: GRAPHQL_USES_FIELD resolves to existing Field node", () => {
      // GetCustomerEmail selects Customer__c.Email__c which is a real Field in the fixture
      expect(
        edgeExists(
          store,
          projectId,
          EdgeType.GraphqlUsesField,
          "::gql:query:GetCustomerEmail",
          "Customer__c.Email__c",
        ),
      ).toBe(true);
    });

    test("cross-domain: fragment GRAPHQL_USES_FIELD also resolves", () => {
      expect(
        edgeExists(
          store,
          projectId,
          EdgeType.GraphqlUsesField,
          "::gqlFragment:CustomerCore",
          "Customer__c.Email__c",
        ),
      ).toBe(true);
    });

    test("GRAPHQL_DEFINED_IN edges connect operations to their owning TsModule", () => {
      expect(countEdgesByType(store, projectId, EdgeType.GraphqlDefinedIn)).toBeGreaterThanOrEqual(3);
    });
  });

  // --- TS compiler enrichment ---
  describe("TypeScript Compiler API enrichment", () => {
    test("TS_TYPE_REFERENCES edge from consumeContext to AgentContext (parameter type)", () => {
      // consumeContext(ctx: AgentContext, ...) — the TS compiler pass resolves the
      // parameter type to the imported interface and emits a TS_TYPE_REFERENCES edge.
      expect(
        edgeExists(
          store,
          projectId,
          EdgeType.TsTypeReferences,
          "src/api/graphqlClient.ts::consumeContext",
          "src/types/globals.d.ts::AgentContext",
        ),
      ).toBe(true);
    });

    test("TS_TYPE_REFERENCES edge captures ContextResolver type alias too", () => {
      expect(
        edgeExists(
          store,
          projectId,
          EdgeType.TsTypeReferences,
          "src/api/graphqlClient.ts::consumeContext",
          "src/types/globals.d.ts::ContextResolver",
        ),
      ).toBe(true);
    });
  });
});
