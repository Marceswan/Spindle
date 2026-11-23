import { expect, test } from "bun:test";
import { isSourceRun } from "../../src/util/runtime.ts";

test("a module on disk is a source run", () => {
  expect(isSourceRun("file:///Volumes/Dev/Spindle-main/src/cli.ts")).toBe(true);
  expect(isSourceRun(import.meta.url)).toBe(true);
});

test("a module in a compiled executable is not a source run", () => {
  expect(isSourceRun("file:///$bunfs/root/sfdx-graph-mcp")).toBe(false);
  expect(isSourceRun("file:///B:/~BUN/root/sfdx-graph-mcp.exe")).toBe(false);
});
