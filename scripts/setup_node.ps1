# ==============================================================================
# CheckYourMorpho - Automated Node.js Environment Bootstrapper
# ==============================================================================
# Ensures an appropriate Node.js environment (>= v22) is ready on any Windows PC.
# If Node is not installed or outdated, automatically downloads the official
# portable Node.js LTS distribution from nodejs.org into .node/
# ==============================================================================

[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [switch]$ForceDownload
)

$ErrorActionPreference = "Stop"

# 1. Determine Project Root directory
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $ProjectRoot = Split-Path -Parent $scriptDir
}

$reqFile = Join-Path $ProjectRoot "requirements.txt"
$nodeDir = Join-Path $ProjectRoot ".node"

# 2. Defaults from requirements
$nodeVersion = "22.14.0"
$minNodeVersion = 22

if (Test-Path $reqFile) {
    Get-Content $reqFile | ForEach-Object {
        $line = $_.Trim()
        if ($line.StartsWith("#") -or [string]::IsNullOrWhiteSpace($line)) { return }
        if ($line -match "^\s*NODE_VERSION\s*=\s*([0-9.]+)") {
            $nodeVersion = $matches[1]
        } elseif ($line -match "^\s*MIN_NODE_VERSION\s*=\s*([0-9]+)") {
            $minNodeVersion = [int]$matches[1]
        }
    }
}

# 3. Check existing local portable Node (.node/node.exe)
$localNodeExe = Join-Path $nodeDir "node.exe"
if (-not $ForceDownload -and (Test-Path $localNodeExe)) {
    try {
        $localVerStr = (& $localNodeExe -v 2>$null).Trim()
        if ($localVerStr -match "^v([0-9]+)") {
            $localMajor = [int]$matches[1]
            if ($localMajor -ge $minNodeVersion) {
                Write-Host "[CheckYourMorpho] Using local portable Node.js $localVerStr ($localNodeExe)" -ForegroundColor Green
                exit 0
            }
        }
    } catch {}
}

# 4. Check system-wide Node.js (if not forced to download)
if (-not $ForceDownload) {
    $systemNode = Get-Command node -ErrorAction SilentlyContinue
    if ($systemNode) {
        try {
            $sysVerStr = (& $systemNode.Source -v 2>$null).Trim()
            if ($sysVerStr -match "^v([0-9]+)") {
                $sysMajor = [int]$matches[1]
                if ($sysMajor -ge $minNodeVersion) {
                    Write-Host "[CheckYourMorpho] System Node.js $sysVerStr is compatible (requires >= v$minNodeVersion)." -ForegroundColor Green
                    exit 0
                } else {
                    Write-Host "[CheckYourMorpho] System Node.js is $sysVerStr, but v$minNodeVersion+ is required for node:sqlite." -ForegroundColor Yellow
                }
            }
        } catch {}
    }
}

# 5. Architecture detection
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'ARM64' { 'win-arm64' }
    'x86'   { if ($env:PROCESSOR_ARCHITEW6432) { 'win-x64' } else { 'win-x86' } }
    default { 'win-x64' }
}

$zipName = "node-v$nodeVersion-$arch.zip"
$downloadUrl = "https://nodejs.org/dist/v$nodeVersion/$zipName"
$tempZip = Join-Path $env:TEMP $zipName
$tempExtractDir = Join-Path $env:TEMP ("node_extract_" + [System.Guid]::NewGuid().ToString("N"))

Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host "  CheckYourMorpho: Automatic Environment Setup" -ForegroundColor Cyan
Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host "[1/3] Node.js >= v$minNodeVersion required. Preparing to download portable runtime..." -ForegroundColor Cyan
Write-Host "      Version : v$nodeVersion ($arch)"
Write-Host "      Source  : $downloadUrl"
Write-Host "      Target  : $nodeDir"

# Enable modern TLS protocols (TLS 1.2 / 1.3)
try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
} catch {}

# 6. Download portable Node.js zip archive
Write-Host "[2/3] Downloading Node.js archive from nodejs.org..." -ForegroundColor Cyan
$downloadSuccess = $false

# Attempt 1: curl.exe if available (fast and shows download progress bar)
$curlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curlCmd) {
    try {
        & $curlCmd.Source -# -L -f -o "$tempZip" "$downloadUrl"
        if ($LASTEXITCODE -eq 0 -and (Test-Path $tempZip) -and (Get-Item $tempZip).Length -gt 1000000) {
            $downloadSuccess = $true
        }
    } catch {
        $downloadSuccess = $false
    }
}

# Attempt 2: System.Net.WebClient (available across all Windows versions)
if (-not $downloadSuccess) {
    try {
        Write-Host "      Downloading via .NET WebClient..." -ForegroundColor Gray
        $webClient = New-Object System.Net.WebClient
        $webClient.DownloadFile($downloadUrl, $tempZip)
        if ((Test-Path $tempZip) -and (Get-Item $tempZip).Length -gt 1000000) {
            $downloadSuccess = $true
        }
    } catch {
        Write-Error "Failed to download Node.js archive from $downloadUrl. Details: $_"
        exit 1
    }
}

if (-not $downloadSuccess) {
    Write-Error "Downloaded archive is missing or corrupted."
    exit 1
}

# 7. Extract archive
Write-Host "[3/3] Extracting Node.js into .node directory..." -ForegroundColor Cyan
try {
    if (Test-Path $tempExtractDir) { Remove-Item -Recurse -Force $tempExtractDir }
    New-Item -ItemType Directory -Path $tempExtractDir -Force | Out-Null

    $extracted = $false

    # Try tar.exe first (built into Windows 10/11)
    $tarCmd = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tarCmd) {
        try {
            & $tarCmd.Source -xf "$tempZip" -C "$tempExtractDir"
            if ($LASTEXITCODE -eq 0) { $extracted = $true }
        } catch {}
    }

    # Fallback to .NET ZipFile / Expand-Archive
    if (-not $extracted) {
        try {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [System.IO.Compression.ZipFile]::ExtractToDirectory($tempZip, $tempExtractDir)
            $extracted = $true
        } catch {
            Expand-Archive -Path $tempZip -DestinationPath $tempExtractDir -Force
            $extracted = $true
        }
    }

    # Move files from extracted nested root folder (e.g., node-v22.14.0-win-x64) into $nodeDir
    if (-not (Test-Path $nodeDir)) {
        New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
    }

    $innerFolder = Get-ChildItem -Path $tempExtractDir -Directory | Select-Object -First 1
    if ($innerFolder) {
        Get-ChildItem -Path $innerFolder.FullName | ForEach-Object {
            Move-Item -Path $_.FullName -Destination $nodeDir -Force
        }
    } else {
        Get-ChildItem -Path $tempExtractDir | ForEach-Object {
            Move-Item -Path $_.FullName -Destination $nodeDir -Force
        }
    }
} finally {
    # Cleanup temporary download files
    Remove-Item -Force $tempZip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $tempExtractDir -ErrorAction SilentlyContinue
}

# 8. Verify installed portable Node.js
if (Test-Path $localNodeExe) {
    $verifiedVer = (& $localNodeExe -v 2>$null).Trim()
    Write-Host "===============================================================================" -ForegroundColor Green
    Write-Host "  Node.js $verifiedVer setup completed successfully in .node\" -ForegroundColor Green
    Write-Host "===============================================================================" -ForegroundColor Green
    exit 0
} else {
    Write-Error "[ERROR] Node.js binary was not found at $localNodeExe after extraction."
    exit 1
}
