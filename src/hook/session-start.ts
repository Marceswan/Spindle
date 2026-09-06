// SessionStart hook implementation. Detects an SFDX project at the resolved working
// directory and requests an incremental index from the shared service so the MCP
// server's read tools see fresh data on the first query.
//
// Contract per https://code.claude.com/docs/en/hooks:
//   - Stdin: JSON `{ session_id, transcript_path, cwd, hook_event_name, source, model }`.
//     Reads non-blocking; falls back to env / process.cwd() if stdin is empty.
//   - Stdout: JSON `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }`
//     so Claude Code injects the message into the model's context cleanly. Plain stdout
//     also works but JSON is the documented modern shape.
//   - Always exits 0. Indexer errors are logged and surfaced through the diagnostic log
//     but do not block session start.
//   - Diagnostic log at `<db-dir>/hook.log` is appended on EVERY invocation regardless
//     of detection outcome — that's the user-visible proof the hook fired. `tail` it.

import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { connectService } from "../service/client.ts";
import { getDefaultDbDir, getDefaultDbPath } from "../util/db-path.ts";
import { logger } from "../util/logger.ts";


const SFDX_SOURCE_EXTENSIONS = new Set([".cls", ".trigger", ".cmp", ".app", ".page", ".vfp"]);
const SHALLOW_PROBE_MAX_DEPTH = 4;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);

const STDIN_READ_TIMEOUT_MS = 200;

export type HookOptions = {
  /** Override cwd resolution (used by tests and the --cwd CLI flag). */
  cwd?: string | undefined;
  /** SessionStart subtype, when known: startup | resume | clear | compact. */
  source?: string | undefined;
  /** Skip the stdin read (used by tests). */
  skipStdin?: boolean;
};

export type HookResult =
  | { status: "skipped"; reason: string }
  | {
      status: "indexed";
      projectRoot: string;
      filesParsed: number;
      nodesWritten: number;
      edgesWritten: number;
      durationMs: number;
      watcherPid: number | null;
    };

type StdinPayload = {
  session_id?: string;
  cwd?: string;
  source?: string;
  hook_event_name?: string;
};

export async function runSessionStartHook(opts: HookOptions = {}): Promise<HookResult> {
  const stdin = opts.skipStdin ? null : await readStdinJson();
  const cwdRaw = opts.cwd ?? stdin?.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
  const cwd = resolve(cwdRaw);
  const source = opts.source ?? stdin?.source ?? "unknown";

  const result = await runInner(cwd, source);
  writeDiagnosticLog({ cwd, source, result });
  emitHookOutput(result);
  return result;
}

async function runInner(cwd: string, _source: string): Promise<HookResult> {
  const detection = await detectSfdxProject(cwd);
  if (!detection.isSfdx) {
    logger.debug({ cwd }, "session-start-hook: not an SFDX project");
    return { status: "skipped", reason: "not-an-sfdx-project" };
  }

  const projectRoot = detection.projectRoot;
  const client = await connectService(getDefaultDbPath());
  try {
    const result = await client.request("call", { name: "index_project", arguments: { project_root: projectRoot } }) as {
      files_parsed: number; nodes_written: number; edges_written: number; duration_ms: number;
    };
    const status = await client.request("status") as { pid: number };
    return { status: "indexed", projectRoot, filesParsed: result.files_parsed,
      nodesWritten: result.nodes_written, edgesWritten: result.edges_written,
      durationMs: result.duration_ms, watcherPid: status.pid };
  } catch (err) {
    logger.warn({ err, projectRoot }, "session-start-hook: index failed, skipping");
    return { status: "skipped", reason: `index-failed: ${(err as Error).message}` };
  } finally { await client.close(); }
}

/**
 * Emit Claude Code's modern JSON SessionStart hook output. Per the docs, the
 * `additionalContext` string is injected into Claude's context window at conversation
 * start. The string is visible to the model for decision-making but does NOT appear as
 * a chat message in the user UI; users wanting visible proof should tail the hook log.
 */
function emitHookOutput(result: HookResult): void {
  if (result.status === "skipped") {
    // Skipped runs produce no context — empty additionalContext is fine but emit a
    // valid JSON envelope so Claude Code's parser is happy.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "",
        },
      }) + "\n",
    );
    return;
  }

  const watchNote = result.watcherPid !== null ? `, shared service pid ${result.watcherPid}` : "";
  const message =
    `Spindle: graph indexed at ${result.projectRoot} ` +
    `(${result.filesParsed} files, ${result.durationMs}ms${watchNote}). ` +
    `Prefer Spindle MCP tools (search_graph, trace_references, get_field_usage, ` +
    `get_permission_access, query_graph, get_source_snippet) over Grep/Read for ` +
    `structural questions in this SFDX project.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: message,
      },
    }) + "\n",
  );
}

/** Append a JSON line to <db-dir>/hook.log on every invocation. User-visible proof. */
function writeDiagnosticLog(args: { cwd: string; source: string; result: HookResult }): void {
  try {
    const dir = getDefaultDbDir();
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "hook.log");
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      cwd: args.cwd,
      source: args.source,
      result: args.result,
    }) + "\n";
    appendFileSync(logPath, line);
  } catch (err) {
    logger.warn({ err }, "session-start-hook: failed to write diagnostic log");
  }
}

/**
 * Read JSON payload from stdin with a short timeout. Claude Code pipes a single JSON
 * object on stdin and closes the pipe. If stdin is empty (e.g., manual invocation from
 * a shell with no pipe), we time out fast and fall back to env / cwd.
 */
async function readStdinJson(): Promise<StdinPayload | null> {
  if (process.stdin.isTTY) return null; // interactive shell — no piped input expected

  return new Promise<StdinPayload | null>((resolveP) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (payload: StdinPayload | null): void => {
      if (settled) return;
      settled = true;
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
      resolveP(payload);
    };

    const timeout = setTimeout(() => {
      finish(null);
    }, STDIN_READ_TIMEOUT_MS);

    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") return finish(null);
      try {
        const parsed = JSON.parse(raw) as StdinPayload;
        finish(parsed);
      } catch (err) {
        logger.warn({ err, raw }, "session-start-hook: stdin JSON parse failed");
        finish(null);
      }
    });
    process.stdin.on("error", () => {
      clearTimeout(timeout);
      finish(null);
    });
  });
}

type Detection = { isSfdx: true; projectRoot: string } | { isSfdx: false };

async function detectSfdxProject(cwd: string): Promise<Detection> {
  const anchor = walkUpForSfdxAnchor(cwd);
  if (anchor !== null) {
    return { isSfdx: true, projectRoot: anchor };
  }

  const foundShallow = await shallowProbeForSalesforceSource(cwd, 0);
  if (foundShallow) {
    return { isSfdx: true, projectRoot: cwd };
  }

  return { isSfdx: false };
}

function walkUpForSfdxAnchor(start: string): string | null {
  let current = start;
  for (let i = 0; i < 8; i++) {
    if (hasSfdxAnchor(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function hasSfdxAnchor(dir: string): boolean {
  try {
    if (existsSync(join(dir, "sfdx-project.json"))) return true;
    const forceApp = join(dir, "force-app");
    if (existsSync(forceApp) && statSync(forceApp).isDirectory()) return true;
    return false;
  } catch {
    return false;
  }
}

async function shallowProbeForSalesforceSource(dir: string, depth: number): Promise<boolean> {
  if (depth > SHALLOW_PROBE_MAX_DEPTH) return false;

  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = entry.name.slice(dot).toLowerCase();
    if (SFDX_SOURCE_EXTENSIONS.has(ext)) return true;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const sub = join(dir, entry.name);
    if (await shallowProbeForSalesforceSource(sub, depth + 1)) return true;
  }

  return false;
}

