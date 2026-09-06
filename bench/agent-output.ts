// Same-symbol output-size comparison. Bytes are measured; tokens are only a proxy.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/graph/store.ts";
import { indexProject } from "../src/pipeline/index-project.ts";
import { handler } from "../src/tools/search-graph.ts";
import { generateCorpus } from "./corpus.ts";

const dir = mkdtempSync(join(tmpdir(), "spindle-output-"));
const store = new GraphStore(":memory:");
try {
  generateCorpus({ rootDir: dir, classCount: 100, seed: 42 });
  await indexProject(dir, store, { mode: "full" });
  const input = { project_id: 1, label: "ApexClass", limit: 50 };
  const compact = await handler(input, store) as { nodes: { qualifiedName: string }[] };
  const full = await handler({ ...input, detail: "full" }, store) as typeof compact;
  if (JSON.stringify(compact.nodes.map(n => n.qualifiedName)) !== JSON.stringify(full.nodes.map(n => n.qualifiedName))) {
    throw new Error("Output comparison lost symbols");
  }
  const before = Buffer.byteLength(JSON.stringify({ nodes: full.nodes, count: full.nodes.length }, null, 2));
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const after = Buffer.byteLength(JSON.stringify(compact));
  process.stdout.write(JSON.stringify({ symbols: compact.nodes.length, baselinePrettyBytes: before,
    fullCompactJsonBytes: fullBytes, compactEvidenceBytes: after,
    reductionPercent: Math.round((1 - after / before) * 1000) / 10,
    approximateTokensBefore: Math.ceil(before / 4), approximateTokensAfter: Math.ceil(after / 4),
    note: "UTF-8 bytes measured; bytes/4 is a token proxy, not tokenizer output. Same page of 50 Apex classes.",
  }, null, 2) + "\n");
} finally {
  store.close(); rmSync(dir, { recursive: true, force: true });
}
