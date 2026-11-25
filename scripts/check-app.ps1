<#
.SYNOPSIS
  Scoped check for one app: typecheck, lint and tests for src/apps/<id>/, plus
  the core tests when core code has uncommitted changes.

.EXAMPLE
  npm run check:app -- my-app

  Run this while working on an app. Run the full `npm run verify` once before
  committing; CI always runs the full verify.
#>
param([Parameter(Position = 0)][string]$Id)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Id) {
  Write-Host 'usage: npm run check:app -- <id>' -ForegroundColor Red
  exit 2
}
$appDir = "src/apps/$Id"
if (-not (Test-Path -LiteralPath $appDir -PathType Container)) {
  Write-Host "no app folder at $appDir" -ForegroundColor Red
  exit 2
}

function Step([string]$name, [scriptblock]$cmd) {
  Write-Host "`n== $name" -ForegroundColor Cyan
  & $cmd
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED: $name" -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

# Core counts as touched when anything outside src/apps/ under src/, eslint/
# or test/ differs from HEAD (staged, unstaged or untracked).
$changed = @(git diff --name-only HEAD) + @(git ls-files --others --exclude-standard)
$coreTouched = @($changed | Where-Object { $_ -match '^(src/(?!apps/)|eslint/|test/)' }).Count -gt 0

Step 'typecheck' { npx.cmd tsc --noEmit }
Step "lint $appDir" { npx.cmd eslint $appDir }
Step "tests $appDir" { npx.cmd vitest run "$appDir/" --passWithNoTests }
if ($coreTouched) {
  Step 'lint core' { npx.cmd eslint src/core src/server.ts src/index.ts src/config.ts eslint test }
  Step 'core tests (test/)' { npx.cmd vitest run test/ }
} else {
  Write-Host "`n(core untouched: skipping core tests)"
}

Write-Host "`ncheck:app $Id passed. Run 'npm run verify' once before committing." -ForegroundColor Green
