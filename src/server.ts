// Each stdio client has a thin adapter. All graph work lives in the shared service.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { connectService, type ServiceClient } from "./service/client.ts";
import { VERSION } from "./version.ts";
import { logger } from "./util/logger.ts";

export async function startServer(): Promise<void> {
  const server = new Server({ name: "sfdx-graph-mcp", version: VERSION }, { capabilities: { tools: {} } });
  let client: ServiceClient | undefined;
  let connecting: Promise<ServiceClient> | undefined;
  let stopping = false;
  // The service can stop while this adapter stays open (crash, kill, oversized frame).
  // Connect again for the next request. One shared promise, so concurrent requests
  // cannot open a second connection that nothing closes.
  const service = (): Promise<ServiceClient> => {
    if (stopping) return Promise.reject(new Error("Spindle adapter is stopping"));
    if (client && !client.isClosed()) return Promise.resolve(client);
    connecting ??= connectService()
      .then(connected => { client = connected; return connected; })
      .finally(() => { connecting = undefined; });
    return connecting;
  };
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdin.off("end", onEnd);
    process.stdin.off("close", onEnd);
    process.off("SIGINT", onEnd); process.off("SIGTERM", onEnd); process.off("SIGHUP", onEnd);
    await connecting?.catch(() => undefined);
    await client?.close();
    await server.close();
    process.stdin.pause();
  };
  const onEnd = (): void => { void shutdown(); };
  process.stdin.once("end", onEnd); process.stdin.once("close", onEnd);
  process.on("SIGINT", onEnd); process.on("SIGTERM", onEnd); process.on("SIGHUP", onEnd);
  server.onclose = onEnd;
  try {
    client = await connectService();
    if (stopping || process.stdin.readableEnded) { await client.close(); await shutdown(); return; }
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await (await service()).request("list") as ListToolsResult["tools"] }));
    server.setRequestHandler(CallToolRequestSchema, async req => {
      try {
        const result = await (await service()).request("call", { name: req.params.name, arguments: req.params.arguments ?? {} });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    await server.connect(new StdioServerTransport());
    logger.info("stdio adapter connected to shared graph service");
  } catch (err) { await shutdown(); throw err; }
}
