// True when this code runs from Bun source files, false inside a `bun build --compile`
// executable. A compiled executable serves its modules from a virtual drive:
// `/$bunfs/` on macOS and Linux, `B:/~BUN/` on Windows.
export function isSourceRun(moduleUrl: string): boolean {
  if (!moduleUrl.startsWith("file:")) return false;
  return !moduleUrl.includes("/$bunfs/") && !moduleUrl.includes("/~BUN/");
}
