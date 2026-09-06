// Thin local RPC connection; the shared process alone owns graph state and watchers.
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDefaultDbPath } from "../util/db-path.ts";
import { canonicalDbPath, serviceFiles, SERVICE_PROTOCOL, MAX_FRAME_BYTES, type ServiceRecord } from "./paths.ts";

export type ServiceClient = {
  request: (method: string, params?: unknown) => Promise<unknown>;
  close: () => Promise<void>;
};

function readRecord(dbPath: string): ServiceRecord | null {
  try {
    const r = JSON.parse(readFileSync(serviceFiles(dbPath).discovery, "utf8")) as ServiceRecord;
    if (r.protocol !== SERVICE_PROTOCOL || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535 || typeof r.token !== "string") return null;
    return r;
  } catch { return null; }
}

async function openConnection(record: ServiceRecord): Promise<ServiceClient> {
  const socket: Socket = connect({ host: "127.0.0.1", port: record.port });
  socket.setEncoding("utf8");
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  let sequence = 0;
  let buffer = "";
  let ended = false;
  const fail = (): void => {
    ended = true;
    for (const p of pending.values()) p.reject(new Error("Shared service disconnected; reconnect before retrying (writes are not replayed)."));
    pending.clear();
  };
  socket.on("error", fail);
  socket.on("close", fail);
  socket.on("data", (data: string) => {
    buffer += data;
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { socket.destroy(); return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const response = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        const p = pending.get(response.id);
        if (!p) continue;
        pending.delete(response.id);
        if (response.error !== undefined) p.reject(new Error(response.error)); else p.resolve(response.result);
      } catch { socket.destroy(); return; }
    }
  });
  const client: ServiceClient = {
    request(method, params) {
      if (ended || socket.destroyed) return Promise.reject(new Error("Shared service connection is closed"));
      const id = ++sequence;
      const frame = JSON.stringify({ id, method, params }) + "\n";
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return Promise.reject(new Error("Service request exceeds frame limit"));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(frame);
      });
    },
    async close() {
      if (socket.destroyed) return;
      await new Promise<void>(resolve => {
        socket.once("close", resolve);
        socket.destroy();
      });
    },
  };
  const timeout = setTimeout(() => socket.destroy(new Error("Service handshake timed out")), 1500);
  try {
    await client.request("hello", { token: record.token, protocol: SERVICE_PROTOCOL });
    return client;
  } catch (err) {
    await client.close();
    throw err;
  } finally { clearTimeout(timeout); }
}

export async function connectService(rawDbPath = getDefaultDbPath(), autoStart = true): Promise<ServiceClient> {
  const dbPath = canonicalDbPath(rawDbPath);
  let spawned = false;
  let spawnError: Error | undefined;
  const deadline = Date.now() + 10000;
  do {
    const record = readRecord(dbPath);
    if (record) {
      try { return await openConnection(record); } catch { /* stale or shutting down */ }
    }
    if (!autoStart) throw new Error("No shared Spindle service is running");
    if (!spawned) {
      // Bun source execution needs the CLI script; compiled executables need only args.
      const source = import.meta.url.startsWith("file:") && !import.meta.url.includes("/$bunfs/");
      const args = [...(source ? [fileURLToPath(new URL("../cli.ts", import.meta.url))] : []), "service", "--db-path", dbPath];
      const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: process.env });
      child.on("error", err => { spawnError = err; });
      child.once("exit", () => { spawned = false; });
      child.unref();
      spawned = true;
    }
    if (spawnError) throw spawnError;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error("Shared Spindle service did not become ready within 10 seconds");
}
