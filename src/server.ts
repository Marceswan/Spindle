// Stdio compatibility adapter: graph state and work stay in the one shared service.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ensureService, serviceRequest } from "./service/client.ts";

export async function startServer(): Promise<void> {
  await ensureService();
  const server = new Server(
    { name: "sfdx-graph-mcp", version: "1.1.2" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await serviceRequest<Tool[]>(
      await ensureService(),
      "/service/tools",
    ),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await serviceRequest(
        await ensureService(),
        "/service/call",
        {
          name: request.params.name,
          arguments: request.params.arguments ?? {},
        },
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (error as Error).message }],
      };
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.on("end", () => {
    void server.close();
  });
}
