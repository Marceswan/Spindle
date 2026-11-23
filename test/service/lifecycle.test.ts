import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectService } from "../../src/service/client.ts";

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await Bun.sleep(50);
  }
  throw new Error(`service ${pid} did not stop`);
}

test("concurrent clients share one service; last disconnect closes it and permits restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "spindle-service-"));
  const dbPath = join(home, "graph.db");
  const clients: Awaited<ReturnType<typeof connectService>>[] = [];
  try {
    clients.push(...await Promise.all(Array.from({ length: 4 }, () => connectService(dbPath))));
    const infos = await Promise.all(clients.map(c => c.request("status"))) as { pid: number; clients: number; watchers: number }[];
    expect(new Set(infos.map(i => i.pid)).size).toBe(1);
    expect(infos[0]!.clients).toBe(4);
    const fixture = join(import.meta.dir, "../fixtures/sample-sfdx-project");
    await clients[0]!.request("call", { name: "index_project", arguments: { project_root: fixture } });
    await clients[1]!.request("call", { name: "index_project", arguments: { project_root: fixture } });
    expect((await clients[0]!.request("status") as { watchers: number }).watchers).toBe(1);
    await clients[0]!.close();
    expect((await clients[1]!.request("call", { name: "list_projects", arguments: {} }) as { projects: unknown[] }).projects.length).toBe(1);
    await Promise.all(clients.map(c => c.close()));
    await waitForExit(infos[0]!.pid);
    const restarted = await connectService(dbPath);
    clients.push(restarted);
    const info = await restarted.request("status") as { pid: number };
    expect(info.pid).not.toBe(infos[0]!.pid);
    await restarted.close();
    await waitForExit(info.pid);
  } finally {
    await Promise.all(clients.map(c => c.close()));
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

test("crash releases singleton ownership and stale discovery is recovered", async () => {
  const home = mkdtempSync(join(tmpdir(), "spindle-crash-"));
  const dbPath = join(home, "graph.db");
  const first = await connectService(dbPath);
  let second: Awaited<ReturnType<typeof connectService>> | undefined;
  try {
    const { pid } = await first.request("status") as { pid: number };
    process.kill(pid, "SIGKILL");
    await waitForExit(pid);
    second = await connectService(dbPath);
    const info = await second.request("status") as { pid: number };
    expect(info.pid).not.toBe(pid);
    process.kill(info.pid, "SIGTERM");
    await waitForExit(info.pid);
  } finally {
    await first.close();
    await second?.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

test("MCP adapters share service and release connections on transport close", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const home = mkdtempSync(join(tmpdir(), "spindle-mcp-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env["SFDX_GRAPH_HOME"] = home;
  const clients = [new Client({ name: "one", version: "1" }), new Client({ name: "two", version: "1" })];
  try {
    await Promise.all(clients.map(c => c.connect(new StdioClientTransport({
      command: process.env["SPINDLE_TEST_BINARY"] ?? process.execPath,
      args: process.env["SPINDLE_TEST_BINARY"] ? [] : [join(import.meta.dir, "../../src/cli.ts")], env, stderr: "pipe",
    }))));
    const probe = await connectService(join(home, "graph.db"), false);
    const status = await probe.request("status") as { pid: number; clients: number };
    expect(status.clients).toBe(3);
    await probe.close();
    expect((await clients[0]!.listTools()).tools.length).toBe(10);
    await clients[0]!.close();
    expect((await clients[1]!.callTool({ name: "list_projects", arguments: {} })).isError).not.toBe(true);
    await clients[1]!.close();
    await waitForExit(status.pid);
  } finally {
    await Promise.all(clients.map(c => c.close()));
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

test("stdin EOF closes an adapter and its otherwise idle service", async () => {
  const { spawn } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "spindle-eof-"));
  const child = spawn(process.execPath, [join(import.meta.dir, "../../src/cli.ts")], {
    env: { ...process.env, SFDX_GRAPH_HOME: home }, stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  let servicePid: number | undefined;
  try {
    let probe: Awaited<ReturnType<typeof connectService>> | undefined;
    const deadline = Date.now() + 8000;
    while (!probe && Date.now() < deadline) {
      try { probe = await connectService(join(home, "graph.db"), false); } catch { await Bun.sleep(50); }
    }
    expect(probe).toBeDefined();
    let status = await probe!.request("status") as { pid: number; clients: number };
    while (status.clients < 2 && Date.now() < deadline) {
      await Bun.sleep(20);
      status = await probe!.request("status") as typeof status;
    }
    expect(status.clients).toBe(2);
    servicePid = status.pid;
    await probe!.close();
    child.stdin.end();
    expect(await exited).toBe(0);
    await waitForExit(servicePid);
  } finally {
    child.kill();
    if (servicePid) { try { process.kill(servicePid, "SIGTERM"); } catch { /* already stopped */ } }
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("index_project on a directory that is not an SFDX project leaves no watcher", async () => {
  const home = mkdtempSync(join(tmpdir(), "spindle-nowatch-"));
  const client = await connectService(join(home, "graph.db"));
  try {
    const plain = join(home, "plain");
    mkdirSync(plain);
    await expect(client.request("call", { name: "index_project", arguments: { project_root: plain } })).rejects.toThrow("sfdx-project.json");
    await expect(client.request("call", { name: "index_project", arguments: {} })).rejects.toThrow("absolute path");
    await expect(client.request("call", { name: "index_project", arguments: { project_root: "." } })).rejects.toThrow("absolute path");
    expect((await client.request("status") as { watchers: number }).watchers).toBe(0);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

test("a project indexed through a symlink is watched and stored under its real path", async () => {
  const home = mkdtempSync(join(tmpdir(), "spindle-link-"));
  const client = await connectService(join(home, "graph.db"));
  try {
    const fixture = join(import.meta.dir, "../fixtures/sample-sfdx-project");
    const link = join(home, "link");
    symlinkSync(fixture, link);
    await client.request("call", { name: "index_project", arguments: { project_root: link } });
    await client.request("call", { name: "index_project", arguments: { project_root: `${fixture}/` } });
    const { projects } = await client.request("call", { name: "list_projects", arguments: {} }) as { projects: { rootPath: string }[] };
    expect(projects.map(p => p.rootPath)).toEqual([realpathSync(fixture)]);
    expect((await client.request("status") as { watchers: number }).watchers).toBe(1);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

test("an MCP adapter connects again after its service stops", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const home = mkdtempSync(join(tmpdir(), "spindle-reconnect-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env["SFDX_GRAPH_HOME"] = home;
  const mcp = new Client({ name: "reconnect", version: "1" });
  let servicePid: number | undefined;
  try {
    await mcp.connect(new StdioClientTransport({
      command: process.env["SPINDLE_TEST_BINARY"] ?? process.execPath,
      args: process.env["SPINDLE_TEST_BINARY"] ? [] : [join(import.meta.dir, "../../src/cli.ts")], env, stderr: "pipe",
    }));
    const probe = await connectService(join(home, "graph.db"), false);
    const { pid } = await probe.request("status") as { pid: number };
    await probe.close();
    process.kill(pid, "SIGKILL");
    await waitForExit(pid);
    const result = await mcp.callTool({ name: "list_projects", arguments: {} });
    expect(result.isError).not.toBe(true);
    const again = await connectService(join(home, "graph.db"), false);
    servicePid = (await again.request("status") as { pid: number }).pid;
    await again.close();
    expect(servicePid).not.toBe(pid);
    await mcp.close();
    await waitForExit(servicePid);
  } finally {
    await mcp.close();
    if (servicePid) { try { process.kill(servicePid, "SIGTERM"); } catch { /* already stopped */ } }
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

test("a service that replaces a killed service watches the same projects", async () => {
  const home = mkdtempSync(join(tmpdir(), "spindle-rewatch-"));
  const dbPath = join(home, "graph.db");
  const first = await connectService(dbPath);
  let second: Awaited<ReturnType<typeof connectService>> | undefined;
  try {
    const fixture = join(import.meta.dir, "../fixtures/sample-sfdx-project");
    await first.request("call", { name: "index_project", arguments: { project_root: fixture } });
    const { pid } = await first.request("status") as { pid: number };
    process.kill(pid, "SIGKILL");
    await waitForExit(pid);
    second = await connectService(dbPath);
    const status = await second.request("status") as { pid: number; watchers: number };
    expect(status.pid).not.toBe(pid);
    expect(status.watchers).toBe(1);
    await second.close();
    await waitForExit(status.pid);
    // A clean stop leaves no record, so the next service starts without watchers.
    const third = await connectService(dbPath);
    second = third;
    expect((await third.request("status") as { watchers: number }).watchers).toBe(0);
  } finally {
    await first.close();
    await second?.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);
