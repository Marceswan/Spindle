# Security policy

Spindle is a local-first MCP server. It reads SFDX source on disk and writes a shared SQLite database to `~/.cache/sfdx-graph-mcp/` by default. It does not contact remote services at runtime — see [Privacy stance](#privacy-stance) below.

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
- **Future update flow integrity.** Self-update and signature verification are planned, not implemented.
- **Distribution integrity.** Release artifacts on GitHub are produced by the public `release.yml` workflow on tagged commits. The `SHA256SUMS` file accompanies every release; the install scripts verify each downloaded binary against it.

### Out of scope
- **Untrusted SFDX projects.** Spindle assumes the SFDX source it's pointed at is trusted code from the user's own org. Parsing untrusted source is generally safe (parsers are pure functions that don't `eval`, shell out, or make network calls), but Spindle is not designed as a sandbox for hostile input. If you need to analyze untrusted Salesforce code, do it inside a container or VM.
- **The SQLite database file.** It's stored in the configured service data directory and inherits filesystem permissions. Don't share it.
- **Code injection via crafted file paths.** Spindle uses `child_process.spawn` (not `exec`) in the bench's grep baseline, and never shell-interprets user input in the indexer. Path traversal is contained to the project root by `discover.ts` walking only documented subdirectories.

## Privacy stance

Spindle makes **no remote network calls at runtime**. Local adapters and the Workbench communicate with the shared loopback service. Specifically:

- No telemetry, analytics, error reporting, or "phone home" of any kind.
- No automatic update checks; self-update is not implemented.
- One service binds `127.0.0.1:47839`. APIs and native HTTP MCP require a random bearer token stored in a mode-0600 discovery file. The Workbench receives it in a URL fragment and keeps it in session storage. Host/origin checks reject remote browser origins. Keep the launch URL private. Static UI assets contain no project data and are served without authentication.
- Stdio adapters forward to that service and do not own a database or watcher. Authentication trusts processes running as the same OS user; this is not a multi-user authorization server.
- Local invocation metrics contain counters and allowlisted identifiers. New freeform queries and source text are omitted. Existing historical metric rows are not scrubbed.

Exceptions:
- The install script (`install.sh` / `install.ps1`) reaches out to `api.github.com` once to resolve the latest release manifest and once to download the binary. This is invoked by the user, not by Spindle itself.
- The `bench --compare` subcommand runs `grep` against your corpus to compute the baseline; no network traffic.

This is a deliberate design choice — see design doc §15.8.

## Dependency policy

- **No new top-level dependencies without justification.** Every dep ships inside the Bun-compiled binary; smaller is better. PRs adding deps must explain why.
- **`@lwc/metadata` is pinned to an exact version** because it's published "as-is with no support" per its upstream license. Major bumps require a coordinated change to `src/parsers/lwc/parse.ts` and a full test pass.
- **Transitive dependencies inherited via `@lwc/metadata`** (Babel, postcss, etc.) are kept current via Renovate or Dependabot once the repo is set up for it. Until then, they update with the pinned `@lwc/metadata` version.

GraphQL is a runtime parser dependency; TypeScript is a runtime dependency for symbol resolution. React test renderer is development-only for UI lifecycle regressions.
