# Signed releases and self-update

Self-update uses public releases from `Marceswan/Spindle`. It verifies a detached GPG
signature on `SHA256SUMS`, then verifies the selected binary's SHA256, before replacing
anything. The trusted public key is embedded at build time. Runtime environment
variables and downloaded public keys cannot override it.

## Configured signing key

The committed public key has fingerprint:

`0B45706D3BC5124FDE991DAC2734AFB0CEF8A235`

It belongs to `marceswan <marc.e.swan@gmail.com>` and has signing capability.
The `B9AD03F84F485E54796DAAE482F32E13A1DC2F80` subkey is encryption-only;
the workflow selects the primary signing key using the fingerprint above.

To provision the two GitHub Actions secrets from your own terminal, run:

```sh
set -o pipefail
gpg --armor --export-secret-keys 0B45706D3BC5124FDE991DAC2734AFB0CEF8A235 | gh secret set RELEASE_GPG_PRIVATE_KEY --repo Marceswan/Spindle
gh secret set RELEASE_GPG_PASSPHRASE --repo Marceswan/Spindle
```

The first command sends the armored private-key export directly into GitHub's secret
storage without a temporary file or terminal output. Enter the key passphrase in the
second command's hidden prompt. Do not paste either value into chat. The revocation
certificate stays private and is not uploaded. Confirm secret names with
`gh secret list --repo Marceswan/Spindle` before creating a release tag.

## One-time maintainer setup

1. Create a dedicated OpenPGP signing key on your trusted machine, using GPG's
   `gpg --full-generate-key`. Keep the primary secret key and revocation certificate
   backed up offline; a dedicated signing subkey is suitable for CI.
2. Export its public key into `.github/release-public-key.asc`:
   `gpg --armor --export YOUR_FINGERPRINT > .github/release-public-key.asc`.
   Review the fingerprint and commit that **public** file. Never commit a private key.
3. Add repository Actions secrets `RELEASE_GPG_PRIVATE_KEY` (armored signing private
   key export) and `RELEASE_GPG_PASSPHRASE`. Use GitHub's secret-entry UI or `gh secret set`
   with input from a local file; do not put secrets in command arguments or issues.
4. Create a version tag matching package.json only when ready to release. The workflow
   requires the public key, embeds it into every target binary, signs `SHA256SUMS`
   with the matching fingerprint, verifies the signature, then publishes the assets.
   Missing keys/secrets fail the release; no unsigned fallback is published.

No production key or secret was created by this implementation. Normal development
builds deliberately have no trust key and refuse installation through self-update.
The first signed build must be installed through a trusted bootstrap path. Compare
the published public-key fingerprint with the committed key through a trusted channel.
The installer downloads over HTTPS and checks SHA256; for independent signature
verification, import the trusted public key and run:

```sh
gpg --verify SHA256SUMS.asc SHA256SUMS
```

Always supply both the detached signature and the original manifest, as described in
[the GnuPG verification documentation](https://www.gnupg.org/documentation/manuals/gnupg/Operational-GPG-Commands.html).
Do not trust a public key merely because it was downloaded alongside a release.

## Commands

```sh
sfdx-graph-mcp update --check
sfdx-graph-mcp update --yes
sfdx-graph-mcp update --yes --to v1.2.0
sfdx-graph-mcp rollback --yes
```

Checking is read-only. An explicit `--to` permits choosing an older stable version;
otherwise only a newer stable release is installed. GPG must be available on PATH
for installation. Verification uses an isolated temporary keyring, never the user's
keyring and never an automatic keyserver lookup. A checksum/signature failure leaves
the installed binary untouched. A same-directory staging rename provides atomic
replacement on macOS/Linux and saves `<executable>.backup` for rollback.

Reconnect running MCP clients after updating; existing processes continue using the
old loaded executable until they exit. The updater does not terminate unrelated
clients. Source-mode execution refuses to replace the Bun runtime. Windows release
checks and asset selection work, but automatic replacement/rollback of a running
Windows executable is rejected: close clients and use the verified release artifact
with the installer. Native Windows replacement automation requires Windows testing.

Key rotation must be deliberate: ship a build that trusts the successor key before
switching signing to it, or bootstrap the new trusted binary manually. The updater
never silently adopts an unsigned trust-key change.
