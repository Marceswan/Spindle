# Security policy

Spindle is a local-first MCP server. It reads SFDX source on disk and writes a SQLite database to your project's `.sfdx-graph/` directory. It does not make outbound network calls at runtime — see [Privacy stance](#privacy-stance) below.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email **marc.swan@kelleyaustin.com** with:

- A description of the issue and which Spindle subsystem is affected
- Reproduction steps and (if possible) a minimal proof of concept
- The Spindle version (`sfdx-graph-mcp --version`) and your platform
- Your name + GitHub handle if you'd like credit in the release notes (optional)

You will receive an acknowledgement within 5 business days. We'll work toward a fix and coordinate a disclosure timeline with you.

## Threat model

### In scope
- **Parser memory safety / crash bugs.** Malformed SFDX source (Apex, LWC, Aura, VF, XML metadata) should never crash the indexer or the MCP server. If you find input that does, that's a bug we want to fix.
- **MCP transport hygiene.** The stdio server must not leak stderr noise into stdout (which would break framed message parsing).
- **Update flow integrity** (when implemented in v1.1+). The self-update command verifies SHA256 before atomic-replacing the binary. Signature verification via GPG is planned for v1.1.
- **Distribution integrity.** Release artifacts on GitHub are produced by the public `release.yml` workflow on tagged commits. The `SHA256SUMS` file accompanies every release; the install scripts verify each downloaded binary against it.

### Out of scope
- **Untrusted SFDX projects.** Spindle assumes the SFDX source it's pointed at is trusted code from the user's own org. Parsing untrusted source is generally safe (parsers are pure functions that don't `eval`, shell out, or make network calls), but Spindle is not designed as a sandbox for hostile input. If you need to analyze untrusted Salesforce code, do it inside a container or VM.
- **The SQLite database file.** It's stored in your project's `.sfdx-graph/` directory and inherits filesystem permissions. Don't share it.
- **Code injection via crafted file paths.** Spindle uses `child_process.spawn` (not `exec`) in the bench's grep baseline, and never shell-interprets user input in the indexer. Path traversal is contained to the project root by `discover.ts` walking only documented subdirectories.

## Privacy stance

Spindle makes **no outbound network calls at runtime**. Specifically:

- No telemetry, analytics, error reporting, or "phone home" of any kind.
- No automatic update checks unless explicitly invoked (`sfdx-graph-mcp update` — v1.1+).
- The MCP server only speaks the MCP stdio protocol on the parent process's stdin/stdout. It does not open any network sockets.

Exceptions:
- The install script (`install.sh` / `install.ps1`) reaches out to `api.github.com` once to resolve the latest release manifest and once to download the binary. This is invoked by the user, not by Spindle itself.
- The `bench --compare` subcommand runs `grep` against your corpus to compute the baseline; no network traffic.

This is a deliberate design choice — see design doc §15.8.

## Dependency policy

- **No new top-level dependencies without justification.** Every dep ships inside the Bun-compiled binary; smaller is better. PRs adding deps must explain why.
- **`@lwc/metadata` is pinned to an exact version** because it's published "as-is with no support" per its upstream license. Major bumps require a coordinated change to `src/parsers/lwc/parse.ts` and a full test pass.
- **Transitive dependencies inherited via `@lwc/metadata`** (Babel, postcss, etc.) are kept current via Renovate or Dependabot once the repo is set up for it. Until then, they update with the pinned `@lwc/metadata` version.
