// Canonical benchmark query definitions for the Spindle bench harness.
// Each entry is a self-contained description of a tool invocation and the
// expected correctness criteria against the sample-sfdx-project fixture.
//
// Ground truth is hand-verified against the fixture source files:
//   - AccountService.cls  (extends BaseService, implements Cleanable)
//   - BaseService.cls     (virtual class with doThing())
//   - Cleanable.cls       (interface with cleanup())
//   - Orchestrator.cls    (calls AccountService.cleanup(), instantiates AccountService)
//   - AccountTrigger.trigger (before insert, after update on Account)

export type GroundTruth = {
  mustContain?: { qualifiedName: string; label?: string | undefined }[];
  mustNotContain?: { qualifiedName: string; label?: string | undefined }[];
  minResults?: number | undefined;
  maxResults?: number | undefined;
};

export type BenchQuery = {
  id: string;
  description: string;
  tool: string;
  input: Record<string, unknown>;
  groundTruth: GroundTruth;
  // Pattern used by the grep+read baseline simulator. null means the tool has
  // no meaningful grep equivalent (e.g. get_schema enumerates names, not content).
  grepPattern: string | null;
};

// ---------------------------------------------------------------------------
// NOTE: project_id is placeholder 1. The runner will substitute the real
// project ID after indexing. All other fields are final.
// ---------------------------------------------------------------------------

export const QUERIES: BenchQuery[] = [
  {
    id: "search-method-cleanup",
    description: "search_graph: find ApexMethod named 'cleanup' (exact match)",
    tool: "search_graph",
    input: {
      project_id: 1,
      label: "ApexMethod",
      name_pattern: "^cleanup$",
    },
    groundTruth: {
      mustContain: [
        { qualifiedName: "AccountService.cleanup()", label: "ApexMethod" },
      ],
      // cleanup() in the interface Cleanable is also present — that is correct;
      // we do NOT declare it mustNotContain. The query should surface at least 1.
      minResults: 1,
    },
    // Agent would grep for the method name, then read every matched file.
    grepPattern: "cleanup",
  },

  {
    id: "trace-inbound-calls-cleanup",
    description: "trace_references inbound CALLS to AccountService.cleanup() — Orchestrator.run() must appear",
    tool: "trace_references",
    input: {
      project_id: 1,
      start: { qualified_name: "AccountService.cleanup()" },
      direction: "inbound",
      edge_types: ["CALLS"],
      depth: 1,
    },
    groundTruth: {
      // The traversal starts at cleanup and returns cleanup itself + callers.
      mustContain: [
        { qualifiedName: "AccountService.cleanup()", label: "ApexMethod" },
        { qualifiedName: "Orchestrator.run()", label: "ApexMethod" },
      ],
      // AccountService.purge() is not a caller of cleanup
      mustNotContain: [
        { qualifiedName: "AccountService.purge()", label: "ApexMethod" },
      ],
      minResults: 2,
    },
    // Agent would grep all files for "cleanup(" to find callers, then read each match.
    grepPattern: "cleanup(",
  },

  {
    id: "trace-outbound-from-orchestrator-run",
    description: "trace_references outbound CALLS from Orchestrator.run() — cleanup() reachable at depth 1, purge() at depth 2",
    tool: "trace_references",
    input: {
      project_id: 1,
      start: { qualified_name: "Orchestrator.run()" },
      direction: "outbound",
      edge_types: ["CALLS"],
      depth: 2,
    },
    groundTruth: {
      // At depth 2: run -> cleanup -> purge, so purge IS expected in the result.
      mustContain: [
        { qualifiedName: "Orchestrator.run()", label: "ApexMethod" },
        { qualifiedName: "AccountService.cleanup()", label: "ApexMethod" },
        { qualifiedName: "AccountService.purge()", label: "ApexMethod" },
      ],
      minResults: 3,
    },
    // Grep for Orchestrator.run to find the definition, then grep for everything it calls.
    grepPattern: "Orchestrator",
  },

  {
    id: "get-schema-summary",
    description: "get_schema: schema summary for the indexed project has ApexClass and ApexMethod entries",
    tool: "get_schema",
    input: {
      project_id: 1,
    },
    // get_schema returns a flat summary object, not a node list.
    // Correctness is assessed by the runner's schema-specific check (minResults >= 1
    // on the keys of nodeCounts). The mustContain/mustNotContain arrays address node
    // traversal results; get_schema uses only minResults as the correctness gate.
    groundTruth: {
      minResults: 1,
    },
    // No meaningful file content to grep for a schema summary; agent would ls the directory.
    grepPattern: null,
  },

  {
    id: "get-source-snippet-cleanup",
    description: "get_source_snippet: retrieve source for AccountService.cleanup()",
    tool: "get_source_snippet",
    input: {
      project_id: 1,
      qualified_name: "AccountService.cleanup()",
    },
    // get_source_snippet returns { file_path, start_line, end_line, source }.
    // No node list to walk; minResults: 1 signals the runner to check for a
    // non-error response.
    groundTruth: {
      minResults: 1,
    },
    // Grep to find which file, then read the whole file.
    grepPattern: "AccountService",
  },

  {
    id: "search-all-apex-classes",
    description: "search_graph: find all ApexClass nodes — at least 4 (BaseService, AccountService, Orchestrator, AccountWrapper inner class)",
    tool: "search_graph",
    input: {
      project_id: 1,
      label: "ApexClass",
    },
    groundTruth: {
      mustContain: [
        { qualifiedName: "AccountService", label: "ApexClass" },
        { qualifiedName: "BaseService", label: "ApexClass" },
        { qualifiedName: "Orchestrator", label: "ApexClass" },
      ],
      // SObject placeholder nodes must not appear as ApexClass
      mustNotContain: [
        { qualifiedName: "Account", label: "ApexClass" },
      ],
      minResults: 3,
    },
    // Grep for class declarations to enumerate all Apex classes.
    grepPattern: "public.*class ",
  },

  {
    id: "search-apex-interface",
    description: "search_graph: find ApexInterface nodes — Cleanable must appear",
    tool: "search_graph",
    input: {
      project_id: 1,
      label: "ApexInterface",
    },
    groundTruth: {
      mustContain: [
        { qualifiedName: "Cleanable", label: "ApexInterface" },
      ],
      mustNotContain: [
        { qualifiedName: "AccountService", label: "ApexInterface" },
      ],
      minResults: 1,
      maxResults: 5,
    },
    grepPattern: "public interface ",
  },

  {
    id: "search-apex-trigger",
    description: "search_graph: find ApexTrigger nodes — AccountTrigger must appear",
    tool: "search_graph",
    input: {
      project_id: 1,
      label: "ApexTrigger",
    },
    groundTruth: {
      mustContain: [
        { qualifiedName: "AccountTrigger", label: "ApexTrigger" },
      ],
      minResults: 1,
    },
    grepPattern: "^trigger ",
  },
];
