[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$Artifact,

  [string]$CertificatePath = '',

  [string]$CertificatePassword = '',

  [string]$TimestampUrl = 'http://timestamp.digicert.com',

  [string]$ExpectedSubject = '',

  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Find-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $candidate = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object FullName -Match '\\x64\\signtool\.exe$' |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (!$candidate) { throw 'signtool.exe was not found. Install the Windows SDK signing tools.' }
  return $candidate.FullName
}

function Assert-Artifact([string]$Path) {
  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  $item = Get-Item -LiteralPath $resolved.Path
  if (!$item.PSIsContainer -and $item.Length -gt 0) { return $item.FullName }
  throw "Signing target is missing or empty: $Path"
}

function Assert-SigningCertificate([string]$Path, [string]$Password) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw 'The Windows PFX signing certificate was not found.'
  }
  $flags = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $Path,
    $Password,
    $flags
  )
  if (!$certificate.HasPrivateKey) { throw 'The Windows signing certificate has no private key.' }
  if ($certificate.NotAfter.ToUniversalTime() -lt [DateTime]::UtcNow.AddDays(14)) {
    throw "The Windows signing certificate expires too soon: $($certificate.NotAfter.ToString('u'))"
  }
  if ($certificate.PublicKey.Oid.Value -ne '1.2.840.113549.1.1.1') {
    throw 'Hawk production releases require an RSA code-signing certificate.'
  }
  $codeSigningOid = '1.3.6.1.5.5.7.3.3'
  $hasCodeSigningEku = $false
  foreach ($extension in $certificate.Extensions) {
    if ($extension -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {
      foreach ($usage in $extension.EnhancedKeyUsages) {
        if ($usage.Value -eq $codeSigningOid) { $hasCodeSigningEku = $true }
      }
    }
  }
  if (!$hasCodeSigningEku) { throw 'The PFX is not valid for code signing.' }
  if ($ExpectedSubject -and $certificate.Subject -notlike "*$ExpectedSubject*") {
    throw "Certificate subject '$($certificate.Subject)' does not match '$ExpectedSubject'."
  }
  return $certificate
}

$signTool = Find-SignTool
$targets = @($Artifact | ForEach-Object { Assert-Artifact $_ })
$certificate = $null

if (!$VerifyOnly) {
  if (!$CertificatePath) { throw 'CertificatePath is required when signing.' }
  $certificate = Assert-SigningCertificate $CertificatePath $CertificatePassword
  foreach ($target in $targets) {
    & $signTool sign /fd SHA256 /td SHA256 /tr $TimestampUrl /f $CertificatePath `
      /p $CertificatePassword /d 'Hawk Security IDE' $target
    if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed: $target" }
  }
}

foreach ($target in $targets) {
  & $signTool verify /pa /all /v $target
  if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed: $target" }
  $signature = Get-AuthenticodeSignature -LiteralPath $target
  if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate) {
    throw "Windows does not trust the Authenticode signature on $target ($($signature.Status))."
  }
  if ($ExpectedSubject -and $signature.SignerCertificate.Subject -notlike "*$ExpectedSubject*") {
    throw "Unexpected Authenticode publisher on ${target}: $($signature.SignerCertificate.Subject)"
  }
  if ($certificate -and $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
    throw "The signed artifact does not match the supplied certificate: $target"
  }
  Write-Host "Verified $([IO.Path]::GetFileName($target)) - $($signature.SignerCertificate.Subject)"
}
