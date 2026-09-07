import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// Set by release builds with Bun --define. Runtime environment variables cannot
// replace this trust anchor. Unsigned development builds fail closed.
declare const SPINDLE_RELEASE_PUBLIC_KEY: string;
export const RELEASE_PUBLIC_KEY = typeof SPINDLE_RELEASE_PUBLIC_KEY === "undefined" ? "" : SPINDLE_RELEASE_PUBLIC_KEY;
const REPOSITORY = "Marceswan/Spindle";

export type ReleaseAsset = { name: string; url: string; size: number };
export type UpdateInfo = { version: string; currentVersion: string; available: boolean; assets: ReleaseAsset[]; url: string };

export function normalizeVersion(version: string): string {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Expected a stable version such as v1.2.3");
  return version.startsWith("v") ? version : `v${version}`;
}

function isNewer(candidate: string, current: string): boolean {
  const left = normalizeVersion(candidate).slice(1).split(".").map(BigInt);
  const right = normalizeVersion(current).slice(1).split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]!;
  }
  return false;
}

export function platformAsset(platform: string = process.platform, arch: string = process.arch): string {
  if (!((platform === "darwin" || platform === "linux") && (arch === "arm64" || arch === "x64")) && !(platform === "win32" && arch === "x64")) {
    throw new Error(`Unsupported release platform: ${platform}-${arch}`);
  }
  return `sfdx-graph-mcp-${platform === "win32" ? "windows" : platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

async function fetchBytes(url: string, limit: number): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "User-Agent": "Spindle-self-update", Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`Release download failed: HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Release download has no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Release download exceeds size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

export async function checkUpdate(currentVersion: string, tag?: string): Promise<UpdateInfo> {
  const current = normalizeVersion(currentVersion);
  const requested = tag === undefined ? undefined : normalizeVersion(tag);
  const path = requested === undefined ? "latest" : `tags/${requested}`;
  const raw: unknown = JSON.parse(Buffer.from(await fetchBytes(`https://api.github.com/repos/${REPOSITORY}/releases/${path}`, 2_000_000)).toString());
  if (!raw || typeof raw !== "object") throw new Error("Invalid release metadata");
  const release = raw as Record<string, unknown>;
  if (typeof release.tag_name !== "string" || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error("Expected a published stable release");
  const version = normalizeVersion(release.tag_name);
  if (requested && version !== requested) throw new Error("Release version does not match requested version");
  const prefix = `https://github.com/${REPOSITORY}/releases/download/${version}/`;
  const assets: ReleaseAsset[] = release.assets.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid release asset");
    const asset = item as Record<string, unknown>;
    if (typeof asset.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(asset.name) || asset.browser_download_url !== `${prefix}${asset.name}` || typeof asset.size !== "number") throw new Error("Invalid release asset URL");
    return { name: asset.name, url: asset.browser_download_url as string, size: asset.size };
  });
  return { version, currentVersion: current, available: isNewer(version, current), assets, url: `https://github.com/${REPOSITORY}/releases/tag/${version}` };
}

export function validateManifestVersion(manifest: string, version: string): void {
  const expected = `# Spindle release ${normalizeVersion(version)}`;
  const lines = manifest.split(/\r?\n/);
  const headers = lines.filter(line => line.startsWith("# Spindle release"));
  if (lines[0] !== expected || headers.length !== 1) {
    throw new Error(`Signed checksum manifest must begin with exactly one ${expected} header`);
  }
}

export function verifyChecksum(binary: Uint8Array, manifest: string, assetName: string): void {
  const matches = manifest.split(/\r?\n/).flatMap(line => {
    const entry = /^([a-fA-F0-9]{64}) [ *](\S+)$/.exec(line);
    return entry?.[2] === assetName ? [entry[1]!.toLowerCase()] : [];
  });
  if (matches.length !== 1) throw new Error(`Signed checksum manifest must contain exactly one entry for ${assetName}`);
  if (createHash("sha256").update(binary).digest("hex") !== matches[0]) throw new Error("Release binary checksum mismatch");
}

async function runGpg(home: string, args: string[]): Promise<string> {
  let child;
  try {
    child = Bun.spawn(["gpg", "--no-options", "--homedir", home, "--batch", "--no-tty", "--no-autostart", "--no-auto-key-retrieve", "--auto-key-locate", "clear", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch { throw new Error("GPG is required for signed updates; install gpg and retry"); }
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error("GPG signature verification/import failed");
    return stdout;
  } finally { clearTimeout(timer); }
}

export async function verifySignature(manifest: string, signature: string, trustedPublicKey: string = RELEASE_PUBLIC_KEY): Promise<void> {
  if (!trustedPublicKey.trim()) throw new Error("This build has no trusted release public key; signed self-update is disabled");
  const home = await mkdtemp(join(tmpdir(), "spindle-verify-"));
  try {
    await chmod(home, 0o700);
    await writeFile(join(home, "key.asc"), trustedPublicKey, { mode: 0o600 });
    await writeFile(join(home, "SHA256SUMS"), manifest);
    await writeFile(join(home, "SHA256SUMS.asc"), signature);
    await runGpg(home, ["--import", join(home, "key.asc")]);
    const status = await runGpg(home, ["--status-fd", "1", "--verify", join(home, "SHA256SUMS.asc"), join(home, "SHA256SUMS")]);
    if (!status.includes("[GNUPG:] VALIDSIG ") || /\[GNUPG:\] (?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG) /.test(status)) throw new Error("Release signature is invalid or expired");
  } finally { await rm(home, { recursive: true, force: true }); }
}

async function withInstallLock<T>(executablePath: string, work: () => Promise<T>): Promise<T> {
  const lock = `${executablePath}.update-lock`;
  try { await mkdir(lock); } catch { throw new Error(`Another update may be active, or destination is not writable: ${lock}`); }
  try { return await work(); } finally { await rm(lock, { recursive: true, force: true }); }
}

// Caller must verify the downloaded payload first. Staging beside the executable
// makes the final rename atomic, and preserves existing clients' executable inode.
export async function installVerifiedBinary(binary: Uint8Array, executablePath: string): Promise<{ backupPath: string }> {
  if (process.platform === "win32") throw new Error("Automatic replacement of a running Windows executable is unsupported; verify the release signature and install manually after closing clients");
  return withInstallLock(executablePath, () => replaceBinary(binary, executablePath));
}

async function replaceBinary(binary: Uint8Array, executablePath: string): Promise<{ backupPath: string }> {
    const stat = await lstat(executablePath);
    if (!stat.isFile()) throw new Error("Update target must be a regular executable file, not a symlink");
    const staging = join(dirname(executablePath), `.spindle-update-${randomUUID()}`);
    const backupPath = `${executablePath}.backup`;
    const backupStaging = `${staging}.backup`;
    try {
      await writeFile(staging, binary, { mode: stat.mode & 0o777 });
      await copyFile(executablePath, backupStaging);
      await rename(backupStaging, backupPath);
      await rename(staging, executablePath);
      return { backupPath };
    } finally {
      await rm(staging, { force: true });
      await rm(backupStaging, { force: true });
    }
}

export async function rollbackUpdate(executablePath: string): Promise<{ backupPath: string }> {
  if (process.platform === "win32") throw new Error("Automatic rollback of a running Windows executable is unsupported");
  return withInstallLock(executablePath, async () => {
    const backupPath = `${executablePath}.backup`;
    const stat = await lstat(backupPath);
    if (!stat.isFile()) throw new Error("Rollback backup must be a regular file");
    return replaceBinary(await readFile(backupPath), executablePath);
  });
}

export async function verifyAndInstall(options: {
  binary: Uint8Array; manifest: string; signature: string; assetName: string;
  executablePath: string; trustedPublicKey?: string;
}): Promise<{ backupPath: string }> {
  await verifySignature(options.manifest, options.signature, options.trustedPublicKey ?? RELEASE_PUBLIC_KEY);
  verifyChecksum(options.binary, options.manifest, options.assetName);
  return installVerifiedBinary(options.binary, options.executablePath);
}

export async function performUpdate(options: { currentVersion: string; executablePath: string; version?: string; trustedPublicKey?: string }): Promise<{ version: string; updated: boolean; backupPath?: string }> {
  const key = options.trustedPublicKey ?? RELEASE_PUBLIC_KEY;
  if (!key.trim()) throw new Error("This build has no trusted release public key; signed self-update is disabled");
  if (process.platform === "win32") throw new Error("Automatic replacement of a running Windows executable is unsupported; verify the release signature and install manually after closing clients");
  const release = await checkUpdate(options.currentVersion, options.version);
  if (!release.available && options.version === undefined) return { version: release.version, updated: false };
  const assetName = platformAsset();
  const download = async (name: string, limit: number): Promise<Uint8Array> => {
    const assets = release.assets.filter(asset => asset.name === name);
    if (assets.length !== 1) throw new Error(`Release is missing unique ${name} asset`);
    return fetchBytes(assets[0]!.url, limit);
  };
  const manifest = Buffer.from(await download("SHA256SUMS", 100_000)).toString();
  validateManifestVersion(manifest, release.version);
  const signature = Buffer.from(await download("SHA256SUMS.asc", 100_000)).toString();
  const binary = await download(assetName, 300_000_000);
  const installed = await verifyAndInstall({ binary, manifest, signature, assetName, executablePath: options.executablePath, trustedPublicKey: key });
  return { version: release.version, updated: true, ...installed };
}
