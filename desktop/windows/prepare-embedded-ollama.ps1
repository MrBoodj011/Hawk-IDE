param(
  [Parameter(Mandatory = $true)][string]$PortableDir,
  [string]$CacheDir = '',
  [string]$ReleaseApi = 'https://api.github.com/repos/ollama/ollama/releases/latest',
  [switch]$MetadataOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$portable = (Resolve-Path -LiteralPath $PortableDir).Path
if (!(Test-Path -LiteralPath (Join-Path $portable 'Hawk.exe'))) {
  throw 'Hawk.exe was not found in the portable source directory.'
}

$headers = @{
  Accept = 'application/vnd.github+json'
  'User-Agent' = 'Hawk-Security-IDE-Build'
  'X-GitHub-Api-Version' = '2022-11-28'
}
$release = Invoke-RestMethod `
  -UseBasicParsing `
  -Headers $headers `
  -TimeoutSec 30 `
  -Uri $ReleaseApi
$asset = @($release.assets | Where-Object { $_.name -eq 'ollama-windows-amd64.zip' })[0]
if (!$asset) { throw 'The official Ollama release has no Windows AMD64 standalone archive.' }

$downloadUri = [Uri]$asset.browser_download_url
if (
  $downloadUri.Scheme -ne 'https' -or
  $downloadUri.Host -ne 'github.com' -or
  !$downloadUri.AbsolutePath.StartsWith('/ollama/ollama/releases/download/')
) {
  throw 'Ollama archive URL is outside the official GitHub release path.'
}
$assetSize = [Int64]$asset.size
if ($assetSize -lt 104857600 -or $assetSize -gt 2621440000) {
  throw "Ollama archive size is outside Hawk safety limits: $assetSize"
}
$digest = [string]$asset.digest
if ($digest -notmatch '^sha256:([a-fA-F0-9]{64})$') {
  throw 'The official Ollama release is missing a SHA-256 digest.'
}
$expectedHash = $Matches[1].ToLowerInvariant()
$releaseTag = [string]$release.tag_name
if (!$releaseTag) { throw 'The official Ollama release tag is missing.' }
Write-Output "Validated embedded Ollama $releaseTag metadata: $assetSize bytes / $expectedHash"
if ($MetadataOnly) { exit 0 }

$cache = if ($CacheDir) { [IO.Path]::GetFullPath($CacheDir) } else { Join-Path $env:TEMP 'Hawk-Ollama-Cache' }
New-Item -ItemType Directory -Force $cache | Out-Null
$archive = Join-Path $cache "ollama-windows-amd64-$releaseTag.zip"
$cached = Test-Path -LiteralPath $archive
if ($cached) {
  $cachedFile = Get-Item -LiteralPath $archive
  $cached = $cachedFile.Length -eq $assetSize -and `
    (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expectedHash
}
if (!$cached) {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  Write-Output "Downloading official embedded Ollama runtime $releaseTag..."
  Invoke-WebRequest `
    -UseBasicParsing `
    -Headers @{ 'User-Agent' = 'Hawk-Security-IDE-Build' } `
    -TimeoutSec 1800 `
    -Uri $downloadUri.AbsoluteUri `
    -OutFile $archive
}

$file = Get-Item -LiteralPath $archive
if ($file.Length -ne $assetSize) {
  throw "Ollama archive size mismatch: $($file.Length) of $assetSize bytes."
}
$actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) { throw 'Ollama archive failed SHA-256 verification.' }

$runtimeRoot = Join-Path $portable 'resources\hawk-local-ai'
$target = Join-Path $runtimeRoot 'ollama'
$staging = Join-Path $runtimeRoot 'ollama-staging'
Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $staging | Out-Null
Expand-Archive -LiteralPath $archive -DestinationPath $staging -Force
$executable = Join-Path $staging 'ollama.exe'
if (!(Test-Path -LiteralPath $executable)) {
  throw 'The verified Ollama archive did not contain ollama.exe at its expected path.'
}
$signature = Get-AuthenticodeSignature -LiteralPath $executable
$signer = [string]$signature.SignerCertificate.Subject
if ($signature.Status -ne 'Valid' -or $signer -notmatch 'Ollama') {
  throw "Embedded Ollama Authenticode verification failed: $($signature.Status) / $signer"
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'OLLAMA-LICENSE.txt') -Destination $staging
$manifest = [ordered]@{
  schemaVersion = 1
  runtime = 'ollama'
  version = $releaseTag
  platform = 'windows-amd64'
  source = $downloadUri.AbsoluteUri
  archiveBytes = $assetSize
  archiveSha256 = $expectedHash
  executable = 'ollama.exe'
  signer = $signer
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staging 'hawk-runtime.json') -Encoding UTF8
Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
Move-Item -LiteralPath $staging -Destination $target
Write-Output "Embedded verified Ollama $releaseTag into $target"
