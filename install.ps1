# Spindle one-line installer for Windows (PowerShell 5+).
# Downloads the latest release binary for x64 Windows, verifies its SHA256, and installs it.
#
# Quick install:
#   iwr -useb https://raw.githubusercontent.com/Kelley-Austin/Spindle/main/install.ps1 | iex
#
# Options (set as env vars before invoking):
#   $env:SPINDLE_VERSION  pin to a specific tag (default: latest)
#   $env:SPINDLE_PREFIX   install location (default: $HOME\AppData\Local\Programs\spindle)
#   $env:SPINDLE_REPO     override the GitHub repo (default: Kelley-Austin/Spindle)

$ErrorActionPreference = "Stop"

$Repo    = if ($env:SPINDLE_REPO) { $env:SPINDLE_REPO } else { "Kelley-Austin/Spindle" }
$Version = if ($env:SPINDLE_VERSION) { $env:SPINDLE_VERSION } else { "latest" }

# ---------- GitHub auth (needed for private/internal repos) ----------
# Token sources in order: $env:GITHUB_TOKEN, $env:GH_TOKEN, `gh auth token`.
$authToken = $null
if ($env:GITHUB_TOKEN) {
    $authToken = $env:GITHUB_TOKEN
} elseif ($env:GH_TOKEN) {
    $authToken = $env:GH_TOKEN
} elseif (Get-Command gh -ErrorAction SilentlyContinue) {
    try { $authToken = (gh auth token 2>$null).Trim() } catch { $authToken = $null }
}

$headers = @{ "User-Agent" = "spindle-install" }
if ($authToken) { $headers["Authorization"] = "Bearer $authToken" }

# ---------- Detect architecture ----------

$arch = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1).Architecture
# Win32_Processor.Architecture: 0=x86, 5=ARM, 6=Itanium, 9=x64, 12=ARM64
switch ($arch) {
    9       { $archStr = "x64" }
    default {
        if ([Environment]::Is64BitOperatingSystem) { $archStr = "x64" }
        else {
            Write-Error "Spindle: only 64-bit Windows is supported."
            exit 1
        }
    }
}

$binaryName = "sfdx-graph-mcp-windows-$archStr.exe"

# ---------- Resolve release URL ----------

if ($Version -eq "latest") {
    $releaseUrl = "https://api.github.com/repos/$Repo/releases/latest"
} else {
    $releaseUrl = "https://api.github.com/repos/$Repo/releases/tags/$Version"
}

Write-Host "Spindle: resolving release manifest from $releaseUrl"

try {
    $manifest = Invoke-RestMethod -Uri $releaseUrl -UseBasicParsing -Headers $headers
} catch {
    Write-Error "Spindle: failed to fetch release manifest. Repo or tag may not exist yet."
    exit 1
}

$asset = $manifest.assets | Where-Object { $_.name -eq $binaryName }
if (-not $asset) {
    Write-Error "Spindle: could not find an asset named '$binaryName' in the release."
    Write-Host "Available assets:"
    $manifest.assets | ForEach-Object { Write-Host "  $($_.name)" }
    exit 1
}

$sumsAsset = $manifest.assets | Where-Object { $_.name -eq "SHA256SUMS" }

# ---------- Pick install prefix ----------

if ($env:SPINDLE_PREFIX) {
    $prefix = $env:SPINDLE_PREFIX
} else {
    $prefix = Join-Path $env:LOCALAPPDATA "Programs\spindle"
}

if (-not (Test-Path $prefix)) {
    New-Item -ItemType Directory -Path $prefix -Force | Out-Null
}

$target = Join-Path $prefix "sfdx-graph-mcp.exe"

# ---------- Download to a temp file ----------

$tmpDir = New-Item -ItemType Directory -Path ([System.IO.Path]::GetTempPath()) -Name ("spindle-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
$downloadPath = Join-Path $tmpDir.FullName $binaryName

try {
    Write-Host "Spindle: downloading $($asset.browser_download_url)"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $downloadPath -UseBasicParsing -Headers $headers

    # ---------- Verify SHA256 ----------

    if ($sumsAsset) {
        Write-Host "Spindle: verifying SHA256"
        $sumsPath = Join-Path $tmpDir.FullName "SHA256SUMS"
        Invoke-WebRequest -Uri $sumsAsset.browser_download_url -OutFile $sumsPath -UseBasicParsing -Headers $headers

        $sumsContent = Get-Content $sumsPath
        $expectedLine = $sumsContent | Where-Object { $_ -match "\s$([regex]::Escape($binaryName))$" }
        if (-not $expectedLine) {
            Write-Error "Spindle: SHA256SUMS does not list '$binaryName'. Aborting."
            exit 1
        }
        $expected = ($expectedLine -split "\s+")[0]
        $actual = (Get-FileHash -Algorithm SHA256 -Path $downloadPath).Hash.ToLower()

        if ($expected.ToLower() -ne $actual) {
            Write-Error "Spindle: SHA256 mismatch. Expected $expected, got $actual. Aborting."
            exit 1
        }
        Write-Host "Spindle: checksum verified"
    } else {
        Write-Warning "Spindle: no SHA256SUMS file in release. Skipping checksum verification."
    }

    # ---------- Install ----------

    Move-Item -Path $downloadPath -Destination $target -Force
} finally {
    Remove-Item -Path $tmpDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Spindle: installed sfdx-graph-mcp to $target"
Write-Host ""

# ---------- Register Claude Code SessionStart hook ----------
# Auto-runs an incremental index whenever a Claude Code session starts inside an SFDX
# project. Skip by setting $env:SPINDLE_SKIP_HOOK = "1".

if ($env:SPINDLE_SKIP_HOOK -ne "1") {
    try {
        & $target register-hook | Out-Null
    } catch {
        Write-Warning "Spindle: register-hook failed (non-fatal). Run '$target register-hook' manually to enable the SessionStart hook."
    }
}

# Check PATH
$pathEntries = $env:PATH -split ";"
if (-not ($pathEntries -contains $prefix)) {
    Write-Host "Note: $prefix is not on your PATH."
    Write-Host "Add it for the current session with:"
    Write-Host "  `$env:PATH = `"$prefix;`$env:PATH`""
    Write-Host "Or persistently:"
    Write-Host "  [Environment]::SetEnvironmentVariable('PATH', `"$prefix;`" + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')"
    Write-Host ""
}

Write-Host "Verify with:"
Write-Host "  sfdx-graph-mcp --version"
Write-Host ""
Write-Host "To use with Claude Code, add to .mcp.json or ~/.claude/settings.json:"
Write-Host "  {"
Write-Host "    `"mcpServers`": {"
Write-Host "      `"sfdx-graph`": { `"type`": `"stdio`", `"command`": `"$($target -replace '\\', '\\')`" }"
Write-Host "    }"
Write-Host "  }"
