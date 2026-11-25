[CmdletBinding()]
param([string]$NodePath = 'node')

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeExecutable = (Get-Command $NodePath -ErrorAction Stop).Source
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/health' -TimeoutSec 5
if ($health.service -ne 'poros') { throw 'Start the dedicated Poros service before publishing its private entry' }
$status = tailscale status --json | ConvertFrom-Json -AsHashtable
$ip = @($status.TailscaleIPs | Where-Object { $_ -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$' })[0]
if ($status.BackendState -ne 'Running' -or -not $ip) { throw 'A connected Tailscale device is required' }
$name = $status.Self.DNSName.TrimEnd('.')
$serve = tailscale serve status --json | ConvertFrom-Json -AsHashtable
$httpsName = $name + ':8443'
$httpName = $name + ':8788'
$tcp = $serve.TCP ?? @{}
$web = $serve.Web ?? @{}
$currentHttpsProxy = $web[$httpsName]?.Handlers?.Item('/')
if ($tcp['8443'] -and $tcp['8443'].TCPForward -ne '127.0.0.1:8791' -and
  $currentHttpsProxy.Proxy -ne 'http://127.0.0.1:8790') {
  throw 'Port 8443 belongs to another service'
}
if ($tcp['8788'] -and $tcp['8788'].TCPForward -notin '127.0.0.1:8790','127.0.0.1:8792') {
  throw 'Port 8788 belongs to another service'
}
if ($serve.AllowFunnel -and ($serve.AllowFunnel[$httpsName] -or $serve.AllowFunnel[$httpName])) {
  throw 'A public Funnel already owns one of the requested ports'
}

function Assert-Command([string]$Action) {
  if ($LASTEXITCODE -ne 0) { throw ('Failed: ' + $Action) }
}
if ($status.CertDomains -contains $name) {
  if ($tcp['8443'].TCPForward -eq '127.0.0.1:8791') {
    tailscale serve --tcp=8443 off | Out-Null
    Assert-Command 'remove Poros TCP mapping'
  }
  tailscale serve --bg --https=8443 'http://127.0.0.1:8790'
  Assert-Command 'publish private Tailscale HTTPS'
  return
}

# The local signing key is used once and removed after the certificate verifies.
$state = Join-Path $env:LOCALAPPDATA 'Poros\mobile'
$tls = Join-Path $state 'tls'
New-Item -Force -ItemType Directory -Path $tls | Out-Null
. (Join-Path $PSScriptRoot 'private-state.ps1')
Protect-PorosState $state
$ca = Join-Path $tls 'ca.crt'
$cert = Join-Path $tls 'server.crt'
$key = Join-Path $tls 'server.key'
$trust = Join-Path $tls 'poros-mobile-ca.cer'
if (-not ((Test-Path -LiteralPath $cert) -and (Test-Path -LiteralPath $key) -and (Test-Path -LiteralPath $trust))) {
  $signer = Join-Path $tls 'one-time-signer.key'
  $csr = Join-Path $tls 'poros-request.csr'
  $requestConfig = Join-Path $tls 'request.cnf'
  $extensions = Join-Path $tls 'server-extensions.cnf'
  @('[req]', 'distinguished_name = dn', '[dn]') | Set-Content -LiteralPath $requestConfig -Encoding utf8NoBOM
  @(
    'basicConstraints=critical,CA:FALSE'
    'keyUsage=critical,digitalSignature,keyEncipherment'
    'extendedKeyUsage=serverAuth'
    ('subjectAltName=IP:' + $ip)
  ) | Set-Content -LiteralPath $extensions -Encoding utf8NoBOM
  try {
    openssl req -config $requestConfig -x509 -newkey rsa:3072 -noenc -sha256 -days 730 -subj '/CN=Poros Mobile CA' -keyout $signer -out $ca -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign' -addext ('nameConstraints=critical,permitted;IP:' + $ip + '/255.255.255.255') 2>$null
    Assert-Command 'create private mobile CA'
    openssl req -config $requestConfig -new -newkey rsa:2048 -noenc -subj ('/CN=' + $ip) -keyout $key -out $csr 2>$null
    Assert-Command 'create mobile TLS key and request'
    openssl x509 -req -in $csr -CA $ca -CAkey $signer -set_serial ('0x' + [guid]::NewGuid().ToString('N')) -days 365 -sha256 -extfile $extensions -out $cert 2>$null
    Assert-Command 'sign mobile TLS certificate'
    openssl verify -CAfile $ca -purpose sslserver -verify_ip $ip $cert
    Assert-Command 'verify private certificate chain and IP'
    openssl x509 -in $ca -outform DER -out $trust
    Assert-Command 'export mobile trust certificate'
  } finally {
    foreach ($temporary in @($signer, $csr, $extensions, $requestConfig)) {
      if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
  }
}
openssl verify -CAfile $ca -purpose sslserver -verify_ip $ip $cert
Assert-Command 'verify existing certificate still matches this node'

$pidFile = Join-Path $state 'ingress.pid'
$current = $null
if (Test-Path -LiteralPath $pidFile) {
  $stored = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($stored -match '^\d+$') {
    $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $stored)
    if ($candidate.CommandLine -and $candidate.CommandLine.Contains($tls) -and $candidate.CommandLine.Contains('scripts/mobile-ingress.mjs')) { $current = $candidate }
  }
}
if (-not $current) {
  $quote = [char]34
  $process = Start-Process -FilePath $nodeExecutable -WorkingDirectory $root -ArgumentList ('scripts/mobile-ingress.mjs ' + $quote + $tls + $quote) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $state 'ingress.log') -RedirectStandardError (Join-Path $state 'ingress-error.log') -PassThru
  Set-Content -LiteralPath $pidFile -Value $process.Id
}
for ($i = 0; $i -lt 30; $i++) {
  try {
    if ((Invoke-RestMethod -Uri 'http://127.0.0.1:8792/api/health' -TimeoutSec 1).service -eq 'poros') { break }
  } catch {}
  Start-Sleep -Milliseconds 200
}
if ((Invoke-RestMethod -Uri 'http://127.0.0.1:8792/api/health' -TimeoutSec 3).service -ne 'poros') { throw 'Private ingress did not become ready' }
if ($tcp['8443'].HTTPS) {
  tailscale serve --https=8443 off | Out-Null
  Assert-Command 'replace Poros HTTPS mapping'
}
tailscale serve --bg --tcp=8443 'tcp://127.0.0.1:8791' | Out-Null
Assert-Command 'publish Poros TLS TCP mapping'
if ($tcp['8788'].TCPForward -eq '127.0.0.1:8790') {
  tailscale serve --tcp=8788 off | Out-Null
  Assert-Command 'replace Poros HTTP mapping'
}
tailscale serve --bg --tcp=8788 'tcp://127.0.0.1:8792' | Out-Null
Assert-Command 'publish Poros HTTP TCP mapping'
[pscustomobject]@{
  Browser = 'http://' + $ip + ':8788/'
  InstallableApp = 'https://' + $ip + ':8443/'
  TrustCertificate = 'http://' + $ip + ':8788/mobile-trust.cer'
  CA_SHA256 = (Get-FileHash -LiteralPath $trust -Algorithm SHA256).Hash
}
