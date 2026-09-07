import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installVerifiedBinary, rollbackUpdate, verifyChecksum, platformAsset, normalizeVersion, verifySignature, verifyAndInstall, validateManifestVersion } from "../../src/update/update.ts";

describe("signed updater", () => {
  test("validates versions and supports only the five release targets", () => {
    expect(normalizeVersion("1.2.3")).toBe("v1.2.3");
    expect(() => normalizeVersion("v1.2.3/evil")).toThrow();
    expect(platformAsset("win32", "x64")).toBe("sfdx-graph-mcp-windows-x64.exe");
    expect(() => platformAsset("linux", "riscv64")).toThrow();
  });
  test("requires one exact signed manifest entry and matching bytes", () => {
    const bytes = Buffer.from("binary");
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(() => verifyChecksum(bytes, `${hash}  binary\n`, "binary")).not.toThrow();
    expect(() => verifyChecksum(bytes, `${hash}  other\n`, "binary")).toThrow();
    expect(() => verifyChecksum(bytes, `${hash}  binary\n${hash}  binary\n`, "binary")).toThrow();
    expect(() => verifyChecksum(Buffer.from("tampered"), `${hash}  binary\n`, "binary")).toThrow();
  });
  test("binds a signed manifest to exactly one requested release version", () => {
    expect(() => validateManifestVersion("# Spindle release v1.2.3\nhash  binary\n", "1.2.3")).not.toThrow();
    expect(() => validateManifestVersion("hash  binary\n", "1.2.3")).toThrow();
    expect(() => validateManifestVersion("# Spindle release v1.2.2\nhash  binary\n", "1.2.3")).toThrow();
    expect(() => validateManifestVersion("# Spindle release v1.2.3\n# Spindle release v1.2.3\n", "1.2.3")).toThrow();
    expect(() => validateManifestVersion("hash  binary\n# Spindle release v1.2.3\n", "1.2.3")).toThrow();
  });
  test("atomic installation preserves a backup and rollback restores it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spindle-install-"));
    try {
      const target = join(dir, "spindle");
      writeFileSync(target, "old", { mode: 0o755 });
      await installVerifiedBinary(Buffer.from("new"), target);
      expect(readFileSync(target, "utf8")).toBe("new");
      await rollbackUpdate(target);
      expect(readFileSync(target, "utf8")).toBe("old");
      expect(readFileSync(`${target}.backup`, "utf8")).toBe("new");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("fails closed without a release public key", async () => {
    await expect(verifySignature("manifest", "signature", "")).rejects.toThrow("public key");
  });
  test("refuses concurrent installation and symbolic-link targets without modifying the executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spindle-lock-test-"));
    try {
      const target = join(dir, "spindle");
      writeFileSync(target, "original");
      mkdirSync(`${target}.update-lock`);
      await expect(installVerifiedBinary(Buffer.from("new"), target)).rejects.toThrow("Another update");
      const link = join(dir, "link");
      symlinkSync(target, link);
      await expect(installVerifiedBinary(Buffer.from("new"), link)).rejects.toThrow("regular executable");
      expect(readFileSync(target, "utf8")).toBe("original");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test.skipIf(!Bun.which("gpg"))("verifies a detached signature using an isolated keyring and rejects tampering", async () => {
    const home = mkdtempSync(join(tmpdir(), "spindle-test-signing-"));
    chmodSync(home, 0o700);
    const run = async (args: string[]): Promise<string> => {
      const child = Bun.spawn(["gpg", "--no-options", "--homedir", home, "--batch", "--pinentry-mode", "loopback", "--passphrase", "", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exit !== 0) throw new Error(stderr);
      return stdout;
    };
    try {
      await run(["--quick-generate-key", "Spindle Test Only <test@example.invalid>", "ed25519", "sign", "0"]);
      const publicKey = await run(["--armor", "--export", "test@example.invalid"]);
      const binary = Buffer.from("new verified binary");
      const manifest = `${createHash("sha256").update(binary).digest("hex")}  spindle\n`;
      writeFileSync(join(home, "manifest"), manifest);
      await run(["--armor", "--detach-sign", join(home, "manifest")]);
      const signature = readFileSync(join(home, "manifest.asc"), "utf8");
      const target = join(home, "spindle");
      writeFileSync(target, "original", { mode: 0o755 });
      const keyringsBefore = readdirSync(tmpdir()).filter(name => name.startsWith("spindle-verify-")).sort();
      await expect(verifyAndInstall({ binary: Buffer.from("tampered"), manifest, signature, assetName: "spindle", executablePath: target, trustedPublicKey: publicKey })).rejects.toThrow("checksum mismatch");
      expect(readFileSync(target, "utf8")).toBe("original");
      await expect(verifyAndInstall({ binary, manifest, signature: "bad signature", assetName: "spindle", executablePath: target, trustedPublicKey: publicKey })).rejects.toThrow();
      expect(readFileSync(target, "utf8")).toBe("original");
      expect(readdirSync(tmpdir()).filter(name => name.startsWith("spindle-verify-")).sort()).toEqual(keyringsBefore);
      expect(readdirSync(home).some(name => name.startsWith(".spindle-update-") || name.endsWith(".update-lock") || name.endsWith(".backup"))).toBe(false);
      await verifyAndInstall({ binary, manifest, signature, assetName: "spindle", executablePath: target, trustedPublicKey: publicKey });
      expect(readFileSync(target, "utf8")).toBe("new verified binary");
      await verifySignature(manifest, signature, publicKey);
      await expect(verifySignature(`${manifest}tampered`, signature, publicKey)).rejects.toThrow();
      await expect(verifySignature(manifest, "not a signature", publicKey)).rejects.toThrow();
    } finally {
      const cleanup = Bun.spawn(["gpgconf", "--homedir", home, "--kill", "gpg-agent"], { stdout: "ignore", stderr: "ignore" });
      await cleanup.exited;
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
