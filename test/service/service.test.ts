import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService } from "../../src/service/host.ts";

test("one listener serves clients and rejects a second owner without overwriting discovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spindle-service-"));
  const runtimePath = join(dir, "runtime.json"),
    dbPath = join(dir, "graph.db");
  const host = await startService({ port: 0, runtimePath, dbPath });
  try {
    const before = readFileSync(runtimePath, "utf8");
    await expect(
      startService({ port: host.port, runtimePath, dbPath }),
    ).rejects.toThrow();
    expect(readFileSync(runtimePath, "utf8")).toBe(before);
    const headers = {
      authorization: `Bearer ${host.token}`,
      "content-type": "application/json",
    };
    const url = `http://127.0.0.1:${host.port}`;
    const statuses = await Promise.all(
      Array.from({ length: 4 }, () =>
        fetch(url + "/service/status", { headers }).then((r) => r.json()),
      ),
    );
    expect(new Set(statuses.map((s) => (s as { pid: number }).pid)).size).toBe(
      1,
    );
    expect((await fetch(url + "/service/status")).status).toBe(401);
    expect(
      (
        await fetch(url + "/service/status", {
          headers: { ...headers, origin: "https://example.invalid" },
        })
      ).status,
    ).toBe(403);
    const replies = await Promise.all(
      Array.from({ length: 3 }, () =>
        fetch(url + "/service/call", {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "list_projects", arguments: {} }),
        }).then((r) => r.json()),
      ),
    );
    expect(replies).toHaveLength(3);
    expect(JSON.stringify(replies)).not.toContain("error");
  } finally {
    await host.close();
  }
  const replacement = await startService({
    port: host.port,
    runtimePath,
    dbPath,
  });
  await replacement.close();
  rmSync(dir, { recursive: true, force: true });
});

test("independent process races converge; crash recovery replaces stale discovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spindle-race-"));
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port!;
  await probe.stop(true);
  const options = {
    port,
    runtimePath: join(dir, "runtime.json"),
    dbPath: join(dir, "graph.db"),
  };
  const command = [
    process.execPath,
    join(import.meta.dir, "fixtures/owner.ts"),
    JSON.stringify(options),
  ];
  const children = Array.from({ length: 4 }, () =>
    Bun.spawn(command, { stdout: "pipe", stderr: "pipe" }),
  );
  let replacement: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const results = await Promise.all(
      children.map(async (child) => {
        const reader = child.stdout.getReader();
        const first = await reader.read();
        reader.releaseLock();
        return JSON.parse(new TextDecoder().decode(first.value)) as {
          owner: boolean;
          pid: number;
        };
      }),
    );
    expect(results.filter((r) => r.owner)).toHaveLength(1);
    for (let i = 0; i < children.length; i++)
      if (!results[i]!.owner) expect(await children[i]!.exited).toBe(0);
    const { ensureService, serviceRequest } = await import(
      "../../src/service/client.ts"
    );
    const connections = await Promise.all(
      Array.from({ length: 5 }, () => ensureService({ ...options, command })),
    );
    expect(new Set(connections.map((c) => c.pid)).size).toBe(1);
    const owner = children[results.findIndex((r) => r.owner)]!;
    owner.kill("SIGKILL");
    await owner.exited;
    // The old discovery remains after SIGKILL, but it must not block the next owner.
    replacement = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const reader = (
      replacement.stdout as ReadableStream<Uint8Array>
    ).getReader();
    const first = await reader.read();
    reader.releaseLock();
    expect(JSON.parse(new TextDecoder().decode(first.value)).owner).toBe(true);
    const connection = await ensureService({ ...options, command });
    expect(connection.pid).not.toBe(owner.pid);
    expect(await serviceRequest(connection, "/service/tools")).toBeArray();
  } finally {
    for (const child of [...children, ...(replacement ? [replacement] : [])]) {
      child.kill("SIGTERM");
      await child.exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("native MCP HTTP clients share tool state", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const dir = mkdtempSync(join(tmpdir(), "spindle-mcp-"));
  const host = await startService({
    port: 0,
    runtimePath: join(dir, "runtime.json"),
    dbPath: join(dir, "graph.db"),
  });
  const clients = [
    new Client({ name: "a", version: "1" }),
    new Client({ name: "b", version: "1" }),
  ];
  try {
    for (const client of clients)
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${host.port}/mcp`),
          {
            requestInit: { headers: { authorization: `Bearer ${host.token}` } },
          },
        ),
      );
    expect((await clients[0]!.listTools()).tools).toHaveLength(9);
    expect(
      (await clients[1]!.callTool({ name: "list_projects", arguments: {} }))
        .isError,
    ).not.toBe(true);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one service watches projects under hidden ancestors, deduplicates roots and restores watchers", async () => {
  const { mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
  const { serviceRequest } = await import("../../src/service/client.ts");
  const dir = mkdtempSync(join(tmpdir(), "spindle-projects-"));
  const runtimePath = join(dir, "runtime.json"),
    dbPath = join(dir, "graph.db");
  let host = await startService({ port: 0, runtimePath, dbPath });
  const connection = () => ({
    port: host.port,
    token: host.token,
    pid: process.pid,
    dbPath,
  });
  const roots = ["a", "b"].map((name) => join(dir, ".worktrees", name));
  const index = (root: string) =>
    serviceRequest(connection(), "/service/call", {
      name: "index_project",
      arguments: { project_root: root },
    });
  const projects = () =>
    serviceRequest<Array<{ id: number; name: string; nodeCount: number }>>(
      connection(),
      "/api/projects",
    );
  const settled = async (predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await Bun.sleep(50);
    }
    throw new Error("watcher did not settle");
  };
  try {
    for (const root of roots) {
      mkdirSync(join(root, "force-app/main/default/classes"), {
        recursive: true,
      });
      writeFileSync(
        join(root, "sfdx-project.json"),
        JSON.stringify({ packageDirectories: [{ path: "force-app" }] }),
      );
      writeFileSync(
        join(root, "force-app/main/default/classes/A.cls"),
        "public class A {}",
      );
    }
    await Promise.all(roots.map(index));
    symlinkSync(roots[0]!, join(dir, "alias"), "dir");
    await index(join(dir, "alias"));
    expect((await projects()).length).toBe(2);
    const status = await serviceRequest<{ projects: string[] }>(
      connection(),
      "/service/status",
    );
    expect(status.projects.length).toBe(2);
    // Wait for the initial ready rescan so an ordinary edit must be caught by the watcher.
    await Bun.sleep(700);
    writeFileSync(
      join(roots[1]!, "force-app/main/default/classes/B.cls"),
      "public class B {}",
    );
    await settled(
      async () =>
        !!(await projects()).find((p) => p.name === "b" && p.nodeCount === 2),
    );
    await host.close();
    host = await startService({ port: host.port, runtimePath, dbPath });
    expect(
      (
        await serviceRequest<{ projects: string[] }>(
          connection(),
          "/service/status",
        )
      ).projects.length,
    ).toBe(2);
    rmSync(join(roots[1]!, "force-app/main/default/classes/B.cls"));
    await settled(
      async () =>
        !!(await projects()).find((p) => p.name === "b" && p.nodeCount === 1),
    );
    await serviceRequest(connection(), "/service/unwatch", { root: roots[0] });
    expect(
      (
        await serviceRequest<{ projects: string[] }>(
          connection(),
          "/service/status",
        )
      ).projects.length,
    ).toBe(1);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('shutdown retains ownership until all service state is closed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'spindle-shutdown-'));
 const runtimePath=join(dir,'runtime.json'),dbPath=join(dir,'graph.db');
 const host=await startService({port:0,runtimePath,dbPath});
 let replacement:Awaited<ReturnType<typeof startService>>|undefined;
 try {
  const stopping=host.close();
  let refused=false;
  try {replacement=await startService({port:host.port,runtimePath,dbPath});}catch{refused=true;}
  await stopping;
  expect(refused).toBe(true);
  replacement=await startService({port:host.port,runtimePath,dbPath});
 }finally{await host.close();await replacement?.close();rmSync(dir,{recursive:true,force:true});}
});
