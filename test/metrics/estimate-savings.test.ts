import { test, expect } from "bun:test";
import { estimateSavings, collectFilePaths } from "../../src/metrics/estimate-savings.ts";

test("collectFilePaths walks nested file_path values, deduped", () => {
  const result = {
    apex_methods: [{ file_path: "/a/Foo.cls" }, { file_path: "/a/Foo.cls" }],
    lwc_bundles: [{ file_path: "/b/bar.js" }, { file_path: null }],
    nested: { deep: [{ file_path: "/c/baz.html" }] },
  };
  const paths = collectFilePaths(result).sort();
  expect(paths).toEqual(["/a/Foo.cls", "/b/bar.js", "/c/baz.html"]);
});

test("result-aware: sums file bytes / 4 plus a per-file grep allowance", () => {
  const result = { hits: [{ file_path: "/x/A.cls" }, { file_path: "/y/B.cls" }] };
  const json = JSON.stringify(result);
  const est = estimateSavings("get_field_usage", json, {
    fileSize: (p) => (p === "/x/A.cls" ? 4000 : 8000),
  });
  expect(est.method).toBe("result-aware");
  // resultTokens = ceil(byteLength(json)/4)
  expect(est.resultTokens).toBe(Math.ceil(Buffer.byteLength(json, "utf8") / 4));
  // baseline = ceil((4000+8000)/4) + 2 files * 50 allowance = 3000 + 100 = 3100
  expect(est.baselineTokens).toBe(3100);
  expect(est.tokensSaved).toBe(Math.max(0, 3100 - est.resultTokens));
});

test("multiplier fallback when result has no file paths", () => {
  const json = JSON.stringify({ count: 3 });
  const est = estimateSavings("search_graph", json, { multipliers: { search_graph: 10 } });
  expect(est.method).toBe("multiplier");
  expect(est.baselineTokens).toBe(est.resultTokens * 10);
});

test("tokensSaved floors at 0", () => {
  const json = JSON.stringify({ file_path: "/tiny.cls" });
  const est = estimateSavings("get_field_usage", json, { fileSize: () => 1 });
  expect(est.tokensSaved).toBeGreaterThanOrEqual(0);
});

test('search and trace camelCase file paths contribute to the baseline',()=>{
 expect(collectFilePaths({nodes:[{filePath:'/a/A.cls'}],nested:{file_path:'/a/A.cls'}})).toEqual(['/a/A.cls']);
 expect(estimateSavings('search_graph',JSON.stringify({nodes:[{filePath:'/a/A.cls'}]}),{fileSize:()=>4000}).baselineTokens).toBe(1050);
});
