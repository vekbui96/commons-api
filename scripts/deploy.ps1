<#
.SYNOPSIS
  Deploys the Commons API to D:\services\commons-api as the NSSM service
  `commons-api` (node on the compiled dist\index.js, 127.0.0.1:8790), or rolls
  the last deploy back. Needs an elevated shell. Only Ve asks for a deploy.

.DESCRIPTION
  Deploy: verify + build here, stop the service, swap dist\ (the old one is kept
  as dist.prev\), `npm ci --omit=dev` when the lockfile changed, start, and poll
  http://127.0.0.1:8790/api/health. If health does not come up, it rolls back
  by itself.

  Layout of D:\services\commons-api:
    dist\  dist.prev\  node_modules\  package.json  package-lock.json  DEPLOYED.txt
    data\commons.db      the database (never in the repo; never touched here)
    data\identity.json   owner login cache, written by the service from tailscale status

  -Serve sets this API's two `tailscale serve` handlers on 8445 (tailnet only):
    /     -> D:\services\commons-web (the private front-end build)
    /api  -> http://127.0.0.1:8790/api (the target keeps /api; without it serve strips the mount)
  It never resets serve/funnel and never touches another port.

.EXAMPLE
  npm run deploy                       # verify, build, deploy, health check
  npm run deploy -- -Serve             # also (re)apply the 8445 serve handlers
  npm run deploy -- -Rollback          # put dist.prev back and restart
#>
param(
  [switch]$Rollback,
  [switch]$Serve,
  [switch]$SkipVerify,
  [switch]$AllowDirty,
  [string]$Target = 'D:\services\commons-api'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$service = 'commons-api'
$nssm = 'C:\ProgramData\chocolatey\lib\NSSM\tools\nssm.exe'
$node = 'C:\Program Files\nodejs\node.exe'
$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
$webDir = 'D:\services\commons-web'
$logDir = 'D:\services\logs'
$port = 8790
$healthUrl = "http://127.0.0.1:$port/api/health"

function PrevName([string]$f) { $f -replace '\.(json|txt)$', '.prev.$1' }
function Say([string]$msg) { Write-Host "== $msg" -ForegroundColor Cyan }
function Fail([string]$msg) { Write-Host "FAILED: $msg" -ForegroundColor Red; exit 1 }
function Exec([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { Fail "$what (exit $LASTEXITCODE)" }
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail 'run this from an elevated shell (NSSM needs it)' }

function Wait-Healthy([int]$seconds = 25) {
  for ($i = 0; $i -lt $seconds; $i++) {
    try {
      $r = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
      if ($r.ok -eq $true -and $r.service -eq 'commons') { return $r }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $null
}

function Stop-Api {
  if (Get-Service $service -ErrorAction SilentlyContinue) {
    & $nssm stop $service | Out-Null
    (Get-Service $service).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  }
}

function Sync-Dependencies {
  # node_modules matches package-lock.json; reinstall only when it changed.
  $lock = Join-Path $Target 'package-lock.json'
  $stamp = Join-Path $Target 'node_modules\.deployed-lock'
  $same = (Test-Path $stamp) -and ((Get-FileHash $lock).Hash -eq (Get-Content -Raw $stamp).Trim())
  if ($same) { return }
  Say 'npm ci --omit=dev (lockfile changed)'
  Push-Location $Target
  try { Exec 'npm ci' { npm.cmd ci --omit=dev --no-audit --no-fund --ignore-scripts } } finally { Pop-Location }
  Set-Content -Path $stamp -Value (Get-FileHash $lock).Hash -Encoding ascii
}

function Install-Service {
  $entry = Join-Path $Target 'dist\index.js'
  if (-not (Get-Service $service -ErrorAction SilentlyContinue)) {
    Say "installing NSSM service $service"
    Exec 'nssm install' { & $nssm install $service $node }
  }
  # Idempotent: (re)apply every setting on each deploy so the service matches this script.
  $settings = @(
    @('AppParameters', "--enable-source-maps --max-semi-space-size=1 --max-old-space-size=96 --v8-pool-size=1 `"$entry`""),
    @('AppDirectory', $Target),
    @('DisplayName', 'commons-api (Commons API, tailnet only)'),
    @('Description', 'Commons API: node dist\index.js on 127.0.0.1:8790; tailscale serve :8445 /api (never Funnel)'),
    @('Start', 'SERVICE_AUTO_START'),
    @('ObjectName', 'LocalSystem'),
    @('AppExit', 'Default', 'Restart'),
    @('AppRestartDelay', '5000'),
    @('AppThrottle', '10000'),
    @('AppStdout', (Join-Path $logDir 'commons-api.out.log')),
    @('AppStderr', (Join-Path $logDir 'commons-api.err.log')),
    @('AppRotateFiles', '1'),
    @('AppRotateOnline', '1'),
    @('AppRotateBytes', '10485760')
  )
  foreach ($s in $settings) { Exec "nssm set $($s[0])" { & $nssm set $service @s | Out-Null } }
  Exec 'nssm set AppEnvironmentExtra' {
    & $nssm set $service AppEnvironmentExtra `
      'NODE_ENV=production' "COMMONS_PORT=$port" 'COMMONS_HOST=127.0.0.1' `
      "COMMONS_DB_PATH=$(Join-Path $Target 'data\commons.db')" | Out-Null
  }
}

function Set-Serve {
  Say 'tailscale serve status (before)'
  & $tailscale serve status
  if (-not (Test-Path $webDir)) { New-Item -ItemType Directory -Path $webDir | Out-Null }
  if (-not (Get-ChildItem $webDir -Force | Select-Object -First 1)) {
    Set-Content -Path (Join-Path $webDir 'index.html') -Encoding utf8 -Value @'
<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Commons</title><body style="font-family:system-ui;margin:2rem">
<h1>Commons</h1><p>The private build has not been deployed yet. API health: <a href="/api/health">/api/health</a>.</p></body></html>
'@
  }
  # Only this API's handlers on 8445; never `serve reset` / `funnel reset`, never another port.
  Exec 'tailscale serve /' { & $tailscale serve --bg --https=8445 $webDir | Out-Null }
  Exec 'tailscale serve /api' { & $tailscale serve --bg --https=8445 --set-path=/api "http://127.0.0.1:$port/api" | Out-Null }
  Say 'tailscale serve status (after)'
  & $tailscale serve status
}

function Restart-Api([string]$label) {
  Say "starting $service ($label)"
  Exec 'nssm start' { & $nssm start $service | Out-Null }
  $h = Wait-Healthy
  if ($h) { Say "healthy: schemaVersion $($h.schemaVersion), apps [$($h.apps -join ', ')]" }
  return $h
}

function Invoke-Rollback {
  $prev = Join-Path $Target 'dist.prev'
  if (-not (Test-Path $prev)) { Fail 'no dist.prev to roll back to' }
  Stop-Api
  $cur = Join-Path $Target 'dist'
  $bad = Join-Path $Target 'dist.bad'
  if (Test-Path $bad) { Remove-Item -Recurse -Force $bad }
  if (Test-Path $cur) { Rename-Item $cur 'dist.bad' }
  Rename-Item $prev 'dist'
  foreach ($f in 'package.json', 'package-lock.json', 'DEPLOYED.txt') {
    $p = Join-Path $Target (PrevName $f)
    if (Test-Path $p) { Copy-Item $p (Join-Path $Target $f) -Force }
  }
  Sync-Dependencies
  if (-not (Restart-Api 'rollback')) { Fail "rolled back, but $healthUrl is still not healthy; see $logDir\commons-api.err.log" }
  Say 'rolled back (the failed build is in dist.bad)'
}

if ($Rollback) { Invoke-Rollback; exit 0 }

# ---------------------------------------------------------------- build
Set-Location $repo
$dirty = git status --porcelain
if ($dirty -and -not $AllowDirty) { Fail 'working tree has uncommitted changes (commit first, or pass -AllowDirty)' }
$commit = (git rev-parse --short HEAD).Trim()
if (-not (Test-Path (Join-Path $repo 'node_modules'))) { Exec 'npm install' { npm.cmd install --no-audit --no-fund } }
if (-not $SkipVerify) { Say 'npm run verify'; Exec 'verify' { npm.cmd run verify } }
Say 'npm run build'
Exec 'build' { npm.cmd run build }

# ---------------------------------------------------------------- stage
New-Item -ItemType Directory -Force -Path $Target, (Join-Path $Target 'data'), $logDir | Out-Null
$new = Join-Path $Target 'dist.new'
if (Test-Path $new) { Remove-Item -Recurse -Force $new }
Copy-Item -Recurse (Join-Path $repo 'dist') $new

# ---------------------------------------------------------------- swap
Stop-Api
$cur = Join-Path $Target 'dist'
$prev = Join-Path $Target 'dist.prev'
$hadPrevious = Test-Path $cur
if ($hadPrevious) {
  if (Test-Path $prev) { Remove-Item -Recurse -Force $prev }
  Rename-Item $cur 'dist.prev'
  foreach ($f in 'package.json', 'package-lock.json', 'DEPLOYED.txt') {
    $p = Join-Path $Target $f
    if (Test-Path $p) { Copy-Item $p (Join-Path $Target (PrevName $f)) -Force }
  }
}
Rename-Item $new 'dist'
Copy-Item (Join-Path $repo 'package.json'), (Join-Path $repo 'package-lock.json') $Target -Force
Sync-Dependencies
Set-Content -Path (Join-Path $Target 'DEPLOYED.txt') -Encoding ascii -Value "$commit $(Get-Date -Format o)"
Install-Service
if ($Serve) { Set-Serve }

if (-not (Restart-Api "deploy $commit")) {
  if ($hadPrevious) {
    Write-Host "health did not come up; rolling back" -ForegroundColor Yellow
    Invoke-Rollback
    Fail "deploy of $commit rolled back"
  }
  Fail "first deploy of $commit is not healthy; see $logDir\commons-api.err.log"
}
Get-Service $service | Format-Table Name, Status, StartType
Say "deployed $commit to $Target"
