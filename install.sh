#!/usr/bin/env sh
# Spindle one-line installer for POSIX systems.
# Downloads the latest release binary for your platform, verifies its SHA256, and installs it.
#
# Quick install:
#   curl -fsSL https://raw.githubusercontent.com/Kelley-Austin/Spindle/main/install.sh | sh
#
# Options (set via env var before the curl):
#   SPINDLE_VERSION   pin to a specific tag (default: latest)
#   SPINDLE_PREFIX    install location (default: /usr/local/bin, falls back to ~/.local/bin)
#   SPINDLE_REPO      override the GitHub repo (default: Kelley-Austin/Spindle)

set -eu

REPO="${SPINDLE_REPO:-Kelley-Austin/Spindle}"
VERSION="${SPINDLE_VERSION:-latest}"

# ---------- GitHub auth (needed for private/internal repos) ----------
# Pick a token from, in order: $GITHUB_TOKEN, $GH_TOKEN, `gh auth token`.
# Public repos work without one; internal repos return 404 to anonymous curl.
auth_token=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
    auth_token="$GITHUB_TOKEN"
elif [ -n "${GH_TOKEN:-}" ]; then
    auth_token="$GH_TOKEN"
elif command -v gh >/dev/null 2>&1; then
    auth_token="$(gh auth token 2>/dev/null || true)"
fi

auth_arg=""
if [ -n "$auth_token" ]; then
    auth_arg="-H Authorization: Bearer $auth_token"
fi

# ---------- Detect platform ----------

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
    Darwin*)  os=darwin ;;
    Linux*)   os=linux ;;
    *)
        echo "Spindle: unsupported OS: $uname_s" >&2
        echo "Supported: macOS, Linux. For Windows, run install.ps1 from PowerShell." >&2
        exit 1
        ;;
esac

case "$uname_m" in
    x86_64|amd64)        arch=x64 ;;
    arm64|aarch64)       arch=arm64 ;;
    *)
        echo "Spindle: unsupported architecture: $uname_m" >&2
        echo "Supported: x86_64, arm64." >&2
        exit 1
        ;;
esac

binary_name="sfdx-graph-mcp-${os}-${arch}"

# ---------- Resolve release URL ----------

if [ "$VERSION" = "latest" ]; then
    release_url="https://api.github.com/repos/${REPO}/releases/latest"
else
    release_url="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
fi

echo "Spindle: resolving release manifest from ${release_url}"

# We use curl if available, else wget. Neither needs JSON parsing for this — we grep the asset URL.
if command -v curl >/dev/null 2>&1; then
    if [ -n "$auth_token" ]; then
        fetch()         { curl -fsSL -H "Authorization: Bearer $auth_token" "$1"; }
        fetch_to_file() { curl -fsSL -H "Authorization: Bearer $auth_token" -o "$2" "$1"; }
    else
        fetch()         { curl -fsSL "$1"; }
        fetch_to_file() { curl -fsSL -o "$2" "$1"; }
    fi
elif command -v wget >/dev/null 2>&1; then
    if [ -n "$auth_token" ]; then
        fetch()         { wget -q --header="Authorization: Bearer $auth_token" -O- "$1"; }
        fetch_to_file() { wget -q --header="Authorization: Bearer $auth_token" -O "$2" "$1"; }
    else
        fetch()         { wget -qO- "$1"; }
        fetch_to_file() { wget -qO "$2" "$1"; }
    fi
else
    echo "Spindle: need curl or wget to download release. Install one and rerun." >&2
    exit 1
fi
unset auth_arg

manifest="$(fetch "$release_url")" || {
    echo "Spindle: failed to fetch release manifest. Repo or tag may not exist yet." >&2
    exit 1
}

# Extract the asset download URL for our binary. GitHub releases manifest is JSON; we use grep
# to avoid a jq dependency. Browser_download_url for the matching asset name.
binary_url="$(printf "%s" "$manifest" \
    | grep -o '"browser_download_url": *"[^"]*"' \
    | sed -e 's/"browser_download_url": *"//' -e 's/"$//' \
    | grep "/$binary_name\$" \
    || true)"

if [ -z "$binary_url" ]; then
    echo "Spindle: could not find an asset named '$binary_name' in the release." >&2
    echo "Available assets:" >&2
    printf "%s" "$manifest" \
        | grep -o '"browser_download_url": *"[^"]*"' \
        | sed -e 's/"browser_download_url": *"//' -e 's/"$//' >&2
    exit 1
fi

# SHA256SUMS file containing the expected hash.
sums_url="$(printf "%s" "$manifest" \
    | grep -o '"browser_download_url": *"[^"]*"' \
    | sed -e 's/"browser_download_url": *"//' -e 's/"$//' \
    | grep '/SHA256SUMS$' \
    || true)"

# ---------- Pick install prefix ----------

if [ -n "${SPINDLE_PREFIX:-}" ]; then
    prefix="$SPINDLE_PREFIX"
elif [ -w "/usr/local/bin" ] || { [ ! -e "/usr/local/bin" ] && [ -w "/usr/local" ]; }; then
    prefix="/usr/local/bin"
else
    prefix="$HOME/.local/bin"
    echo "Spindle: /usr/local/bin not writable, falling back to $prefix"
fi

mkdir -p "$prefix"
target="${prefix}/sfdx-graph-mcp"

# ---------- Download to a temp file ----------

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
download_path="${tmp_dir}/${binary_name}"

# Asset downloads from `browser_download_url` 302-redirect to GitHub's CDN, which strips
# the Authorization header (curl/wget security default). For internal/private repos, prefer
# `gh release download` when available — it handles the redirect with auth natively.
echo "Spindle: downloading $binary_name"
if [ -n "$auth_token" ] && command -v gh >/dev/null 2>&1 && [ "$VERSION" != "latest" ]; then
    (cd "$tmp_dir" && gh release download "$VERSION" --repo "$REPO" --pattern "$binary_name" --pattern "SHA256SUMS" --clobber)
    [ -f "$download_path" ] || {
        echo "Spindle: gh release download did not produce $binary_name" >&2
        exit 1
    }
    sums_via_gh=1
elif [ -n "$auth_token" ] && command -v gh >/dev/null 2>&1; then
    # Resolve "latest" tag via API first so gh can target it.
    resolved_tag="$(printf "%s" "$manifest" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed -e 's/"tag_name": *"//' -e 's/"$//')"
    if [ -z "$resolved_tag" ]; then
        echo "Spindle: could not resolve release tag from manifest" >&2
        exit 1
    fi
    (cd "$tmp_dir" && gh release download "$resolved_tag" --repo "$REPO" --pattern "$binary_name" --pattern "SHA256SUMS" --clobber)
    [ -f "$download_path" ] || {
        echo "Spindle: gh release download did not produce $binary_name" >&2
        exit 1
    }
    sums_via_gh=1
else
    fetch_to_file "$binary_url" "$download_path"
    sums_via_gh=0
fi

# ---------- Verify SHA256 ----------

if [ -n "$sums_url" ] || [ "${sums_via_gh:-0}" = "1" ]; then
    echo "Spindle: verifying SHA256"
    sums_path="${tmp_dir}/SHA256SUMS"
    if [ "${sums_via_gh:-0}" = "0" ]; then
        fetch_to_file "$sums_url" "$sums_path"
    fi

    expected="$(grep " $binary_name\$" "$sums_path" | awk '{print $1}')"
    if [ -z "$expected" ]; then
        echo "Spindle: SHA256SUMS does not list '$binary_name'. Aborting." >&2
        exit 1
    fi

    if command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "$download_path" | awk '{print $1}')"
    elif command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$download_path" | awk '{print $1}')"
    else
        echo "Spindle: no shasum or sha256sum available; skipping verification." >&2
        actual="$expected"
    fi

    if [ "$expected" != "$actual" ]; then
        echo "Spindle: SHA256 mismatch. Expected $expected, got $actual. Aborting." >&2
        exit 1
    fi
    echo "Spindle: checksum verified"
else
    echo "Spindle: WARNING - no SHA256SUMS file in release. Skipping checksum verification."
fi

# ---------- Install ----------

chmod +x "$download_path"
mv "$download_path" "$target"

echo ""
echo "Spindle: installed sfdx-graph-mcp to $target"
echo ""

# ---------- Register Claude Code SessionStart hook ----------
# Auto-runs an incremental index whenever a Claude Code session starts inside an SFDX
# project. Skip by setting SPINDLE_SKIP_HOOK=1.

if [ "${SPINDLE_SKIP_HOOK:-0}" = "0" ]; then
    if "$target" register-hook 2>/dev/null; then
        :
    else
        echo "Spindle: register-hook failed (non-fatal). Run '$target register-hook' manually to enable the SessionStart hook." >&2
    fi
fi

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$prefix"; then
    echo "Note: $prefix is not on your PATH."
    echo "Add it with:"
    case "$prefix" in
        "$HOME/.local/bin")  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc  # or ~/.zshrc" ;;
        *)                   echo "  export PATH=\"$prefix:\$PATH\"" ;;
    esac
    echo ""
fi

echo "Verify with:"
echo "  sfdx-graph-mcp --version"
echo ""
echo "To use with Claude Code, add to .mcp.json or ~/.claude/settings.json:"
echo "  {"
echo "    \"mcpServers\": {"
echo "      \"sfdx-graph\": { \"type\": \"stdio\", \"command\": \"$target\" }"
echo "    }"
echo "  }"
