// One tool host owns one store; all client adapters share this dispatch queue.
import { realpathSync } from "node:fs";
import type { GraphStore } from "../graph/store.ts";
import { recordInvocation } from "../metrics/record-invocation.ts";
import * as toolIndexProject from "../tools/index-project.ts";
import * as toolListProjects from "../tools/list-projects.ts";
import * as toolGetSchema from "../tools/get-schema.ts";
import * as toolSearchGraph from "../tools/search-graph.ts";
import * as toolTraceReferences from "../tools/trace-references.ts";
import * as toolGetSourceSnippet from "../tools/get-source-snippet.ts";
import * as toolGetFieldUsage from "../tools/get-field-usage.ts";
import * as toolGetPermissionAccess from "../tools/get-permission-access.ts";
import * as toolQueryGraph from "../tools/query-graph.ts";

// Tool registry: tools that need the shared store (list, schema, search, trace, snippet,
// index_project). The default db is the shared store from util/db-path.ts so writes from
// any subcommand or tool are visible to all read tools.
type ToolWithStore = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown, store: GraphStore) => Promise<unknown>;
};

const toolsWithStore: ToolWithStore[] = [
  {
    name: toolIndexProject.name,
    description: toolIndexProject.description,
    inputSchema: toolIndexProject.inputSchema as unknown as Record<
      string,
      unknown
    >,
    handler: toolIndexProject.handler,
  },
  {
    name: toolListProjects.name,
    description: toolListProjects.description,
    inputSchema: toolListProjects.inputSchema as unknown as Record<
      string,
      unknown
    >,
    handler: toolListProjects.handler,
  },
  {
    name: toolGetSchema.name,
    description: toolGetSchema.description,
    inputSchema: toolGetSchema.inputSchema as unknown as Record<
      string,
      unknown
    >,
    handler: toolGetSchema.handler,
  },
  {
    name: toolSearchGraph.name,
    description: toolSearchGraph.description,
    inputSchema: toolSearchGraph.inputSchema as unknown as Record<
      string,
      unknown
    >,
    handler: toolSearchGraph.handler,
  },
  {
    name: toolTraceReferences.name,
    description: toolTraceReferences.description,
    inputSchema: toolTraceReferences.inputSchema as unknown as Record<
      string,
      unknown
    >,
    handler: toolTraceReferences.handler,
  },
  {
    name: toolGetSourceSnippet.name,
    description: toolGetSourceSnippet.description,
    inputSchema: toolGetSourceSnippet.inputSchema as unknown as Record<
      string,
      unknown
    >,
    handler: toolGetSourceSnippet.handler,
  },
  {
    name: toolGetFieldUsage.name,
    description: toolGetFieldUsage.description,
    inputSchema: toolGetFieldUsage.inputSchema as unknown as Record<
      string,
      unknown
    >,
    handler: toolGetFieldUsage.handler,
  },
  {
    name: toolGetPermissionAccess.name,
    description: toolGetPermissionAccess.description,
    inputSchema: toolGetPermissionAccess.inputSchema as unknown as Record<
      string,
      unknown
    >,
    handler: toolGetPermissionAccess.handler,
  },
  {
    name: toolQueryGraph.name,
    description: toolQueryGraph.description,
    inputSchema: toolQueryGraph.inputSchema as unknown as Record<
      string,
      unknown
    >,
    handler: toolQueryGraph.handler,
  },
];

type ToolHost = {
  list(): Omit<ToolWithStore, "handler">[];
  call(name: string, input: Record<string, unknown>): Promise<unknown>;
  idle(): Promise<void>;
};

export function createToolHost(
  store: GraphStore,
  onIndexed: (root: string) => Promise<void>,
): ToolHost {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    list() {
      return toolsWithStore.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
    },
    call(name: string, input: Record<string, unknown>): Promise<unknown> {
      const task = tail.then(async () => {
        const tool = toolsWithStore.find((t) => t.name === name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        if (
          name === "index_project" &&
          typeof input["project_root"] === "string"
        ) {
          input = {
            ...input,
            project_root: realpathSync(input["project_root"]),
          };
        }
        const started = Date.now();
        const result = await tool.handler(input, store);
        if (
          name === "index_project" &&
          typeof input["project_root"] === "string"
        )
          await onIndexed(input["project_root"]);
        recordInvocation(store, {
          projectId:
            typeof input["project_id"] === "number"
              ? input["project_id"]
              : null,
          toolName: name,
          params: input,
          durationMs: Date.now() - started,
          resultJson: JSON.stringify(result),
          now: Date.now(),
        });
        return result;
      });
      tail = task.catch(() => {});
      return task;
    },
    async idle(): Promise<void> {
      await tail;
    },
  };
}
