import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { SERVICE_PORT, getRuntimePath } from "./location.ts";

export type ServiceConnection = {
  port: number;
  token: string;
  dbPath: string;
  pid: number;
};
export type ConnectOptions = {
  dbPath?: string;
  runtimePath?: string;
  port?: number;
  command?: string[];
};
export function readConnection(
  runtimePath = getRuntimePath(),
): ServiceConnection | null {
  try {
    const record = JSON.parse(
      readFileSync(runtimePath, "utf8"),
    ) as ServiceConnection & { protocol: number };
    if (
      record.protocol !== 1 ||
      !Number.isInteger(record.port) ||
      typeof record.token !== "string" ||
      typeof record.dbPath !== "string"
    )
      return null;
    return record;
  } catch {
    return null;
  }
}
export async function serviceRequest<T>(
  connection: ServiceConnection,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(value.error ?? `Service returned ${response.status}`);
  return value;
}
export async function existingService(
  options: ConnectOptions = {},
): Promise<ServiceConnection | null> {
  const connection = readConnection(options.runtimePath);
  if (!connection || connection.port !== (options.port ?? SERVICE_PORT))
    return null;
  try {
    const response = await fetch(
      `http://127.0.0.1:${connection.port}/service/status`,
      {
        headers: { authorization: `Bearer ${connection.token}` },
        signal: AbortSignal.timeout(1000),
      },
    );
    if (!response.ok) return null;
    const status = (await response.json()) as { protocol: number; pid: number };
    if (status.protocol !== 1 || status.pid !== connection.pid) return null;
  } catch {
    return null;
  }
  if (options.dbPath && resolve(options.dbPath) !== connection.dbPath)
    throw new Error(
      `Spindle already owns ${connection.dbPath}. Stop the service before selecting a different database.`,
    );
  return connection;
}
export async function ensureService(
  options: ConnectOptions = {},
): Promise<ServiceConnection> {
  const existing = await existingService(options);
  if (existing) return existing;
  // A stale discovery file never authorizes killing a PID. The listener, not a PID file,
  // decides ownership. Concurrent candidate launches exit if they lose the bind race.
  const source = /^bun(?:\.exe)?$/.test(basename(process.execPath));
  const command = options.command ?? [
    process.execPath,
    ...(source ? [resolve(import.meta.dir, "../cli.ts")] : []),
    "service",
    ...(options.dbPath ? ["--db-path", resolve(options.dbPath)] : []),
  ];
  const child = spawn(command[0]!, command.slice(1), {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();
  for (let attempt = 0; attempt < 100; attempt++) {
    await Bun.sleep(50);
    const owner = await existingService(options);
    if (owner) return owner;
    if (spawnError) throw spawnError;
  }
  throw new Error(
    `Cannot start the shared Spindle service on port ${options.port ?? SERVICE_PORT}. Another application or user may own the port; no alternate instance was started.`,
  );
}
export async function callService(
  name: string,
  args: Record<string, unknown>,
  options: ConnectOptions = {},
): Promise<unknown> {
  const connection = await ensureService(options);
  return serviceRequest(connection, "/service/call", { name, arguments: args });
}
