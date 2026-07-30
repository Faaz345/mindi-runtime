#Requires -Version 5.1
<#
.SYNOPSIS
  MINDIGENOUS one-line installer for Windows.

.DESCRIPTION
  Run this ONE command in Windows PowerShell - no prerequisites needed:

      irm https://unpkg.com/mindigenous/install.ps1 | iex

  (Served straight from the published npm package via the unpkg CDN.)

  The script automatically:
    1. Checks whether Node.js 22+ is installed (npm comes with Node).
       If not, it installs Node for you - via winget when available,
       otherwise by downloading the official Node.js release directly.
    2. Makes node/npm available in the current session AND permanently.
    3. Runs `npm install -g mindigenous`.
    4. Ensures the global npm bin folder is on PATH so `mindi` works.

  After it finishes, just type:  mindi
#>

$ErrorActionPreference = "Stop"
# PowerShell 5.1 defaults to old TLS; nodejs.org requires TLS 1.2+.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Refresh-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
}
function Add-UserPath([string]$dir) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$dir*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$dir", "User")
    }
    if ($env:Path -notlike "*$dir*") { $env:Path = "$env:Path;$dir" }
}

Write-Host ""
Write-Host "  MINDIGENOUS installer" -ForegroundColor Cyan
Write-Host "  Agentic coding terminal - one command, any model." -ForegroundColor DarkGray

# ---------------------------------------------------------------
# Step 1: Node.js 22+ (npm is bundled with Node)
# ---------------------------------------------------------------
Write-Step "Checking for Node.js 22+ ..."
$haveNode = $false
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    try {
        $major = [int]((node --version).TrimStart("v").Split(".")[0])
        if ($major -ge 22) { $haveNode = $true }
    } catch { $haveNode = $false }
}

if ($haveNode) {
    $nodeVer = node --version
    Write-Host "    Node.js $nodeVer found - skipping install." -ForegroundColor Green
} else {
    Write-Host "    Node.js 22+ not found. Installing it for you (one-time)..." -ForegroundColor Yellow
    Refresh-SessionPath
    $winget = Get-Command winget -ErrorAction SilentlyContinue

    if ($winget) {
        Write-Host "    Using winget (built into Windows)..."
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent --disable-interactivity
        Refresh-SessionPath
    } else {
        Write-Host "    winget unavailable - downloading Node.js directly from nodejs.org ..."
        $releases = Invoke-RestMethod "https://nodejs.org/dist/index.json"
        $lts = ($releases | Where-Object { $_.lts } | Select-Object -First 1).version
        $zip = Join-Path $env:TEMP "node-$lts-win-x64.zip"
        Invoke-WebRequest "https://nodejs.org/dist/$lts/node-$lts-win-x64.zip" -OutFile $zip
        $dest = Join-Path $env:LOCALAPPDATA "Programs\nodejs"
        Expand-Archive -Path $zip -DestinationPath $dest -Force
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Add-UserPath (Join-Path $dest "node-$lts-win-x64")
    }

    Refresh-SessionPath
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Host ""
        Write-Host "    Node was installed but this window cannot see it yet." -ForegroundColor Yellow
        Write-Host "    Close PowerShell, open a NEW window, then run:" -ForegroundColor Yellow
        Write-Host "        npm install -g mindigenous" -ForegroundColor Cyan
        Write-Host "        mindi" -ForegroundColor Cyan
        exit 0
    }
    $nodeVer = node --version
    Write-Host "    Node.js $nodeVer installed." -ForegroundColor Green
}

# ---------------------------------------------------------------
# Step 2: Install MINDIGENOUS globally
# ---------------------------------------------------------------
Write-Step "Installing mindigenous ..."
& npm.cmd install -g mindigenous
if ($LASTEXITCODE -ne 0) { & npm install -g mindigenous }

# ---------------------------------------------------------------
# Step 3: Make sure the global bin folder (where `mindi` lives) is on PATH
# ---------------------------------------------------------------
Write-Step "Checking PATH for the mindi command ..."
try {
    $npmGlobal = (& npm.cmd prefix -g 2>$null).Trim()
    if ($npmGlobal) { Add-UserPath $npmGlobal }
} catch { }

# ---------------------------------------------------------------
# Done
# ---------------------------------------------------------------
Write-Host ""
Write-Host "  --------------------------------------------------------" -ForegroundColor Cyan
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  If this is the SAME window you installed Node in, open a" -ForegroundColor DarkGray
Write-Host "  NEW PowerShell window first (so PATH refreshes), then:" -ForegroundColor DarkGray
Write-Host ""
Write-Host "      mindi" -ForegroundColor Cyan
Write-Host ""
Write-Host "  That is the only command you will ever need." -ForegroundColor DarkGray
Write-Host "  --------------------------------------------------------" -ForegroundColor Cyan
