[CmdletBinding()]
param(
  [string]$NodePath = 'node',
  [string]$ModelBase = '',
  [switch]$RestartApp
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeExecutable = (Get-Command $NodePath -ErrorAction Stop).Source
if ((& $nodeExecutable --version) -notmatch '^v24\.') { throw 'Poros requires Node 24' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'dist/src/server/index.js'))) { throw 'Run npm run build before deploying' }
if ($ModelBase -and $ModelBase -notmatch '^http://127\.0\.0\.1:[1-9][0-9]{1,4}[/a-zA-Z0-9._~-]*$') {
  throw 'ModelBase must be an exact HTTP loopback base URL, including its port'
}

$stateDir = Join-Path $env:LOCALAPPDATA 'Poros\mobile'
New-Item -Force -ItemType Directory -Path $stateDir | Out-Null
. (Join-Path $PSScriptRoot 'private-state.ps1')
Protect-PorosState $stateDir
$settings = Join-Path $stateDir 'deployment.env'
$loginFile = Join-Path $stateDir 'owner-login.txt'
$pidPath = Join-Path $stateDir 'application.pid'
$appPort = 8790
$dbPort = 55433
$s3Port = 59001

function New-PorosSecret([int]$Bytes) {
  return [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)).ToLowerInvariant()
}
function Assert-NativeSuccess([string]$Action) {
  if ($LASTEXITCODE -ne 0) { throw ('Failed: ' + $Action) }
}
if (-not (Test-Path -LiteralPath $settings)) {
  if (Get-NetTCPConnection -State Listen -LocalPort $appPort,$dbPort,$s3Port -ErrorAction SilentlyContinue) {
    throw 'A port required by the independent Poros mobile deployment is already in use'
  }
  $dbPassword = New-PorosSecret 24
  $s3Key = New-PorosSecret 16
  $s3Secret = New-PorosSecret 32
  $jwt = New-PorosSecret 32
  $vault = New-PorosSecret 32
  @(
    ('PORT=' + $appPort)
    ('POROS_DB_PORT=' + $dbPort)
    ('POROS_S3_PORT=' + $s3Port)
    ('POROS_DB_PASSWORD=' + $dbPassword)
    ('DATABASE_URL=postgresql://poros:' + $dbPassword + '@127.0.0.1:' + $dbPort + '/poros?schema=public')
    ('S3_ENDPOINT=http://127.0.0.1:' + $s3Port)
    'S3_REGION=us-east-1'
    'S3_BUCKET=poros-mobile-artifacts'
    ('S3_ACCESS_KEY=' + $s3Key)
    ('S3_SECRET_KEY=' + $s3Secret)
    ('JWT_SECRET=' + $jwt)
    ('POROS_SETTINGS_KEY=' + $vault)
    ('POROS_LOCAL_MODEL_BASES=' + $ModelBase)
    'POROS_RUNTIME=dsh'
    'POROS_PERSONAL_MODEL_ONLY=1'
    'POROS_DSH_MODEL_STUB=0'
  ) | Set-Content -LiteralPath $settings -Encoding utf8NoBOM
}

Push-Location -LiteralPath $root
try {
  if (Test-Path -LiteralPath $pidPath) {
    $savedPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($savedPid -match '^\d+$') {
      $candidate = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $savedPid)
      if ($candidate.CommandLine -and $candidate.CommandLine.Contains($settings) -and $candidate.CommandLine.Contains('scripts/start-production.mjs')) {
        if (-not $RestartApp) {
          $health = Invoke-RestMethod -TimeoutSec 5 -Uri ('http://127.0.0.1:' + $appPort + '/api/health')
          if ($health.service -eq 'poros') {
            [pscustomobject]@{ URL = 'http://127.0.0.1:' + $appPort; OwnerSignIn = $loginFile; PID = [int]$savedPid }
            return
          }
        }
        Stop-Process -Id ([int]$savedPid) -ErrorAction Stop
      }
    }
  }
  docker compose -p poros-mobile --env-file $settings -f deploy/docker-compose.yml up -d --wait db s3
  Assert-NativeSuccess 'start dedicated Postgres and SeaweedFS'
  & $nodeExecutable ('--env-file=' + $settings) 'scripts/wait-infra.mjs'
  Assert-NativeSuccess 'S3 private readiness'
  & $nodeExecutable ('--env-file=' + $settings) 'node_modules/prisma/build/index.js' migrate deploy
  Assert-NativeSuccess 'apply database migrations'
  if (-not (Test-Path -LiteralPath $loginFile)) {
    $newPassword = New-PorosSecret 24
    $newPassword | & $nodeExecutable ('--env-file=' + $settings) 'scripts/provision-member.mjs' --organization poros --name 'Poros' --email owner@poros.local --role ADMIN
    Assert-NativeSuccess 'create initial administrator'
    @('组织 ID: poros', '邮箱: owner@poros.local', ('密码: ' + $newPassword)) |
      Set-Content -LiteralPath $loginFile -Encoding utf8NoBOM
  }
  $quote = [char]34
  $parameters = @{
    FilePath = $nodeExecutable
    ArgumentList = $quote + '--env-file=' + $settings + $quote + ' scripts/start-production.mjs'
    WorkingDirectory = $root
    WindowStyle = 'Hidden'
    PassThru = $true
    RedirectStandardOutput = (Join-Path $stateDir 'application.log')
    RedirectStandardError = (Join-Path $stateDir 'application-error.log')
  }
  $process = Start-Process @parameters
  Set-Content -LiteralPath $pidPath -Value $process.Id
  $health = $null
  for ($i = 0; $i -lt 40; $i++) {
    try { $health = Invoke-RestMethod -TimeoutSec 1 -Uri ('http://127.0.0.1:' + $appPort + '/api/health') } catch {}
    if ($health.service -eq 'poros') { break }
    if ($process.HasExited) { throw ('Poros failed to start. See ' + (Join-Path $stateDir 'application-error.log')) }
    Start-Sleep -Milliseconds 300
  }
  if ($health.service -ne 'poros') { throw 'Poros did not become ready' }
  [pscustomobject]@{ URL = 'http://127.0.0.1:' + $appPort; OwnerSignIn = $loginFile; PID = $process.Id }
} finally {
  Pop-Location
}
