// Logger configured to write to stderr only. Stdout is reserved for the MCP transport;
// any write to stdout outside the MCP SDK corrupts the framed message stream.

import pino from "pino";

const level = process.env["SFDX_GRAPH_LOG_LEVEL"] ?? "info";

export const logger = pino(
  { level, base: null },
  pino.destination({ dest: 2, sync: false }),
);

export type Logger = typeof logger;
