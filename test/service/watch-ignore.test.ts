import { expect, test } from "bun:test";
import { isWatchIgnored } from "../../src/service/watch-ignore.ts";

test("skips dependency, build and dot directories below the project root", () => {
  const root = "/work/project";
  expect(isWatchIgnored(root, "/work/project/node_modules/pkg/index.js")).toBe(true);
  expect(isWatchIgnored(root, "/work/project/dist/out.js")).toBe(true);
  expect(isWatchIgnored(root, "/work/project/build")).toBe(true);
  expect(isWatchIgnored(root, "/work/project/.sfdx/cache.json")).toBe(true);
  expect(isWatchIgnored(root, "/work/project/force-app/main/default/.hidden")).toBe(true);
});

test("watches the project root and its source files", () => {
  const root = "/work/project";
  expect(isWatchIgnored(root, root)).toBe(false);
  expect(isWatchIgnored(root, "/work/project/sfdx-project.json")).toBe(false);
  expect(isWatchIgnored(root, "/work/project/force-app/main/default/classes/A.cls")).toBe(false);
  expect(isWatchIgnored(root, "/work/project/force-app/main/default/lwc/distributor/distributor.js")).toBe(false);
});

test("a dot directory above the project root does not hide the project", () => {
  const root = "/home/me/.claude/worktrees/project";
  expect(isWatchIgnored(root, root)).toBe(false);
  expect(isWatchIgnored(root, "/home/me/.claude/worktrees/project/force-app/main/default/classes/A.cls")).toBe(false);
  expect(isWatchIgnored(root, "/home/me/.claude/worktrees/project/node_modules/x")).toBe(true);
});
