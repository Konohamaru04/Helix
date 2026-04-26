#requires -Version 5.1
<#
.SYNOPSIS
  Build Helix Windows release artifact and upload to GitHub release V1.5-Testarossa.

.DESCRIPTION
  Steps:
    1. Purge release/ folder.
    2. npm run package:dir_win
    3. Locate release/win-unpacked
    4. Rename to release/Helix
    5. Compress to release/Helix.v1.5.Windows.7z with 7zip settings matching
       screenshot (LZMA2, level 9 Ultra, 64MB dict, 64 word, 16GB solid, 12 threads).
    6. Upload to GitHub release tag V1.5-Testarossa on Konohamaru04/Helix via gh CLI.

  Intended to run from repo root on the designated Windows build machine.
#>

$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $RepoRoot 'release'
$SevenZip   = if ($env:HELIX_SEVENZIP) { $env:HELIX_SEVENZIP } else { 'E:\Softwar\7z\7z.exe' }
$ArtifactName = 'Helix.v1.5.Windows.7z'
$ReleaseTag = 'V1.5-Testarossa'
$Repo       = 'Konohamaru04/Helix'

Set-Location $RepoRoot

Write-Host '==> [1/6] Purge release folder' -ForegroundColor Cyan
if (Test-Path $ReleaseDir) {
    Remove-Item -LiteralPath $ReleaseDir -Recurse -Force
}
New-Item -ItemType Directory -Path $ReleaseDir | Out-Null

Write-Host '==> [2/6] npm run package:dir_win' -ForegroundColor Cyan
& npm.cmd run package:dir_win
if ($LASTEXITCODE -ne 0) { throw "npm run package:dir_win failed ($LASTEXITCODE)" }

Write-Host '==> [3/6] Locate win-unpacked' -ForegroundColor Cyan
$WinUnpacked = Join-Path $ReleaseDir 'win-unpacked'
if (-not (Test-Path $WinUnpacked)) { throw "win-unpacked not found at $WinUnpacked" }

Write-Host '==> [4/6] Rename win-unpacked -> Helix' -ForegroundColor Cyan
$HelixDir = Join-Path $ReleaseDir 'Helix'
if (Test-Path $HelixDir) { Remove-Item -LiteralPath $HelixDir -Recurse -Force }
Rename-Item -LiteralPath $WinUnpacked -NewName 'Helix'

Write-Host '==> [5/6] Compress with 7zip' -ForegroundColor Cyan
if (-not (Test-Path $SevenZip)) { throw "7-Zip not found at $SevenZip" }
$Archive = Join-Path $ReleaseDir $ArtifactName
if (Test-Path $Archive) { Remove-Item -LiteralPath $Archive -Force }

$SevenZipArgs = @(
    'a',
    '-t7z',
    '-mx=9',
    '-m0=lzma2',
    '-md=64m',
    '-mfb=64',
    '-ms=16g',
    '-mmt=12',
    $Archive,
    (Join-Path $ReleaseDir 'Helix')
)
Push-Location $ReleaseDir
try {
    & $SevenZip @SevenZipArgs
    if ($LASTEXITCODE -ne 0) { throw "7z failed ($LASTEXITCODE)" }
}
finally {
    Pop-Location
}

Write-Host '==> [6/6] Upload to GitHub release' -ForegroundColor Cyan
$gh = (Get-Command gh -ErrorAction SilentlyContinue)
if (-not $gh) { throw 'gh CLI not found on PATH' }

& gh release upload $ReleaseTag $Archive --repo $Repo --clobber
if ($LASTEXITCODE -ne 0) { throw "gh release upload failed ($LASTEXITCODE)" }

Write-Host "Done. Uploaded $ArtifactName to $Repo release $ReleaseTag." -ForegroundColor Green
