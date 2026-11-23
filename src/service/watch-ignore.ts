// Decides which paths the shared watcher skips. chokidar 4 has no glob support: a string
// in `ignored` matches only that exact path, so directory names need a function.
import { relative } from "node:path";

const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build"]);

// Only the part of the path below the project root counts. A project that is itself in a
// dot directory (for example a worktree in `.claude/worktrees`) must still be watched.
export function isWatchIgnored(root: string, path: string): boolean {
  const below = relative(root, path);
  if (below === "" || below.startsWith("..")) return false;
  return below.split(/[/\\]/).some((segment) => segment.startsWith(".") || IGNORED_DIRECTORIES.has(segment));
}
