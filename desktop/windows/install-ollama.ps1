param(
  [switch]$Quiet,
  [switch]$MetadataOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$hawkRoot = Join-Path $env:LOCALAPPDATA 'Hawk'
$logRoot = Join-Path $hawkRoot 'logs'
New-Item -ItemType Directory -Force $logRoot | Out-Null
$logPath = Join-Path $logRoot 'ollama-bootstrap.log'

function Write-HawkLog {
  param([string]$Message)
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  if (!$Quiet) { Write-Host $Message }
}

function Find-OllamaExecutable {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
    (Join-Path $env:LOCALAPPDATA 'Ollama\ollama.exe'),
    (Join-Path $env:ProgramFiles 'Ollama\ollama.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $command = Get-Command ollama.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

try {
  $existing = Find-OllamaExecutable
  if ($existing -and !$MetadataOnly) {
    Write-HawkLog "Ollama already installed at $existing"
    exit 0
  }
  if ($existing) { Write-HawkLog "Ollama already installed at $existing; validating release metadata." }

  Write-HawkLog 'Reading the latest official Ollama release metadata.'
  $headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'Hawk-Security-IDE'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  $release = Invoke-RestMethod `
    -UseBasicParsing `
    -Headers $headers `
    -Uri 'https://api.github.com/repos/ollama/ollama/releases/latest'
  $asset = @($release.assets | Where-Object { $_.name -eq 'OllamaSetup.exe' })[0]
  if (!$asset) { throw 'The official Ollama release has no OllamaSetup.exe asset.' }

  $downloadUri = [Uri]$asset.browser_download_url
  if (
    $downloadUri.Scheme -ne 'https' -or
    $downloadUri.Host -ne 'github.com' -or
    !$downloadUri.AbsolutePath.StartsWith('/ollama/ollama/releases/download/')
  ) {
    throw 'Ollama installer URL is outside the official GitHub release path.'
  }
  $assetSize = [Int64]$asset.size
  if ($assetSize -lt 104857600 -or $assetSize -gt 2621440000) {
    throw "Ollama installer size is outside Hawk safety limits: $assetSize"
  }
  $digest = [string]$asset.digest
  if ($digest -notmatch '^sha256:([a-fA-F0-9]{64})$') {
    throw 'The official Ollama release is missing a SHA-256 digest.'
  }
  $expectedHash = $Matches[1].ToLowerInvariant()
  if ($MetadataOnly) {
    Write-HawkLog "Validated Ollama $($release.tag_name) metadata: $assetSize bytes / $expectedHash"
    exit 0
  }

  $downloadRoot = Join-Path $env:TEMP 'Hawk-Ollama'
  New-Item -ItemType Directory -Force $downloadRoot | Out-Null
  $installer = Join-Path $downloadRoot 'OllamaSetup.exe'
  Write-HawkLog "Downloading Ollama $($release.tag_name) ($assetSize bytes)."
  Invoke-WebRequest `
    -UseBasicParsing `
    -Headers @{ 'User-Agent' = 'Hawk-Security-IDE' } `
    -Uri $downloadUri.AbsoluteUri `
    -OutFile $installer

  $file = Get-Item -LiteralPath $installer
  if ($file.Length -ne $assetSize) {
    throw "Ollama installer size mismatch: $($file.Length) of $assetSize bytes."
  }
  $actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw 'Ollama installer failed SHA-256 verification.'
  }
  Write-HawkLog 'Ollama SHA-256 digest verified.'

  $signature = Get-AuthenticodeSignature -LiteralPath $installer
  $signer = [string]$signature.SignerCertificate.Subject
  if ($signature.Status -ne 'Valid' -or $signer -notmatch 'Ollama') {
    throw "Ollama Authenticode verification failed: $($signature.Status) / $signer"
  }
  Write-HawkLog "Ollama Windows signature verified: $signer"

  $process = Start-Process `
    -FilePath $installer `
    -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-') `
    -Wait `
    -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Ollama installer exited with code $($process.ExitCode)."
  }
  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue

  $installed = Find-OllamaExecutable
  if (!$installed) { throw 'Ollama installation finished, but ollama.exe was not found.' }
  $marker = [ordered]@{
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    release = [string]$release.tag_name
    executable = $installed
    source = 'official-github-release'
    sha256 = $expectedHash
  }
  $marker | ConvertTo-Json | Set-Content `
    -LiteralPath (Join-Path $hawkRoot 'local-ai-bootstrap.json') `
    -Encoding UTF8
  Write-HawkLog "Ollama installed successfully at $installed"
  exit 0
} catch {
  Write-HawkLog "ERROR: $($_.Exception.Message)"
  exit 1
}
