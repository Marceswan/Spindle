// MCP stdio server bootstrap. Registers all six v0.1 tools and dispatches call requests.
// See section 9 of sfdx-graph-mcp-design.md for the full tool catalog.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import { GraphStore } from "./graph/store.ts";
import { logger } from "./util/logger.ts";
import { getDefaultDbPath } from "./util/db-path.ts";

import * as toolIndexProject from "./tools/index-project.ts";
import * as toolListProjects from "./tools/list-projects.ts";
import * as toolGetSchema from "./tools/get-schema.ts";
import * as toolSearchGraph from "./tools/search-graph.ts";
import * as toolTraceReferences from "./tools/trace-references.ts";
import * as toolGetSourceSnippet from "./tools/get-source-snippet.ts";
import * as toolGetFieldUsage from "./tools/get-field-usage.ts";
import * as toolGetPermissionAccess from "./tools/get-permission-access.ts";
import * as toolQueryGraph from "./tools/query-graph.ts";

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
    inputSchema: toolIndexProject.inputSchema as unknown as Record<string, unknown>,
    handler: toolIndexProject.handler,
  },
  {
    name: toolListProjects.name,
    description: toolListProjects.description,
    inputSchema: toolListProjects.inputSchema as unknown as Record<string, unknown>,
    handler: toolListProjects.handler,
  },
  {
    name: toolGetSchema.name,
    description: toolGetSchema.description,
    inputSchema: toolGetSchema.inputSchema as unknown as Record<string, unknown>,
    handler: toolGetSchema.handler,
  },
  {
    name: toolSearchGraph.name,
    description: toolSearchGraph.description,
    inputSchema: toolSearchGraph.inputSchema as unknown as Record<string, unknown>,
    handler: toolSearchGraph.handler,
  },
  {
    name: toolTraceReferences.name,
    description: toolTraceReferences.description,
    inputSchema: toolTraceReferences.inputSchema as unknown as Record<string, unknown>,
    handler: toolTraceReferences.handler,
  },
  {
    name: toolGetSourceSnippet.name,
    description: toolGetSourceSnippet.description,
    inputSchema: toolGetSourceSnippet.inputSchema as unknown as Record<string, unknown>,
    handler: toolGetSourceSnippet.handler,
  },
  {
    name: toolGetFieldUsage.name,
    description: toolGetFieldUsage.description,
    inputSchema: toolGetFieldUsage.inputSchema as unknown as Record<string, unknown>,
    handler: toolGetFieldUsage.handler,
  },
  {
    name: toolGetPermissionAccess.name,
    description: toolGetPermissionAccess.description,
    inputSchema: toolGetPermissionAccess.inputSchema as unknown as Record<string, unknown>,
    handler: toolGetPermissionAccess.handler,
  },
  {
    name: toolQueryGraph.name,
    description: toolQueryGraph.description,
    inputSchema: toolQueryGraph.inputSchema as unknown as Record<string, unknown>,
    handler: toolQueryGraph.handler,
  },
];

export async function startServer(): Promise<void> {
  const server = new Server(
    { name: "sfdx-graph-mcp", version: "1.1.2" },
    { capabilities: { tools: {} } },
  );

  // Ensure default DB directory exists before opening.
  const dbPath = getDefaultDbPath();
  await mkdir(dirname(dbPath), { recursive: true });
  const store = new GraphStore(dbPath);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsWithStore.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const toolInput = req.params.arguments ?? {};

    const withStore = toolsWithStore.find((t) => t.name === toolName);
    if (withStore !== undefined) {
      try {
        const result = await withStore.handler(toolInput, store);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        logger.error({ toolName, err }, "tool handler error");
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("sfdx-graph-mcp server attached to stdio transport");
}
