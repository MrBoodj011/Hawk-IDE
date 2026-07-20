param(
  [Parameter(Mandatory = $true)][string]$PreviousInstaller,
  [Parameter(Mandatory = $true)][string]$PreviousVersion,
  [Parameter(Mandatory = $true)][string]$CandidateInstaller,
  [Parameter(Mandatory = $true)][string]$CandidateVersion,
  [Parameter(Mandatory = $true)][string]$ExpectedPublisher,
  [string]$Result = '.tmp/windows-upgrade-smoke.json'
)

$ErrorActionPreference = 'Stop'
if ($env:HAWK_ALLOW_INSTALLER_EXECUTION -ne '1') {
  throw 'Installer execution is disabled. Set HAWK_ALLOW_INSTALLER_EXECUTION=1 only inside an ephemeral Windows CI runner.'
}
if (!$env:CI -or !$env:RUNNER_TEMP) {
  throw 'The real upgrade smoke test is restricted to an ephemeral CI runner.'
}

$previous = (Resolve-Path -LiteralPath $PreviousInstaller).Path
$candidate = (Resolve-Path -LiteralPath $CandidateInstaller).Path
$installRoot = Join-Path $env:ProgramFiles 'Hawk'
$executable = Join-Path $installRoot 'Hawk.exe'
$uninstaller = Join-Path $installRoot 'Uninstall Hawk.exe'
$startedAt = [DateTimeOffset]::UtcNow
$previousHash = $null
$candidateHash = $null

function Assert-Signed {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedPublisher
  )
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne 'Valid') {
    throw "Authenticode is not valid for ${Path}: $($signature.Status)"
  }
  $subject = [string]$signature.SignerCertificate.Subject
  if (!$subject.ToLowerInvariant().Contains($ExpectedPublisher.ToLowerInvariant())) {
    throw "Signer '$subject' does not match '$ExpectedPublisher'."
  }
}

function Invoke-HawkInstaller {
  param([Parameter(Mandatory = $true)][string]$Path)
  $process = Start-Process -FilePath $Path -ArgumentList '/S', '/NOLOCALAI' -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    throw "Hawk installer returned exit code $($process.ExitCode): $Path"
  }
}

function Assert-InstalledVersion {
  param([Parameter(Mandatory = $true)][string]$ExpectedVersion)
  if (!(Test-Path -LiteralPath $executable)) {
    throw "Hawk.exe was not installed at $executable"
  }
  Assert-Signed -Path $executable -ExpectedPublisher $ExpectedPublisher
  $version = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
  if (!$version -or !$version.StartsWith($ExpectedVersion, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Installed Hawk version '$version' does not match '$ExpectedVersion'."
  }
  $productName = (Get-Item -LiteralPath $executable).VersionInfo.ProductName
  if ($productName -notmatch '^Hawk') {
    throw "Installed product identity is not Hawk: '$productName'."
  }
}

if (Test-Path -LiteralPath $installRoot) {
  throw "The ephemeral runner is not clean: $installRoot already exists."
}

Assert-Signed -Path $previous -ExpectedPublisher $ExpectedPublisher
Assert-Signed -Path $candidate -ExpectedPublisher $ExpectedPublisher

try {
  Invoke-HawkInstaller -Path $previous
  Assert-InstalledVersion -ExpectedVersion $PreviousVersion
  $previousHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash

  Invoke-HawkInstaller -Path $candidate
  Assert-InstalledVersion -ExpectedVersion $CandidateVersion
  $candidateHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash
  if ($candidateHash -eq $previousHash) {
    throw 'The candidate installer did not replace Hawk.exe.'
  }

  $legacyBrand = 'pente' + 'sterflow'
  $legacyPaths = @(
    Get-ChildItem -LiteralPath $installRoot -Recurse -Force |
      Where-Object { $_.Name -match $legacyBrand } |
      ForEach-Object FullName
  )
  if ($legacyPaths.Count -gt 0) {
    throw "The installed product contains legacy-branded paths: $($legacyPaths -join ', ')"
  }

  $resultPath = [IO.Path]::GetFullPath($Result)
  New-Item -ItemType Directory -Force (Split-Path -Parent $resultPath) | Out-Null
  [pscustomobject]@{
    ok = $true
    previousVersion = $PreviousVersion
    candidateVersion = $CandidateVersion
    previousExecutableSha256 = $previousHash
    candidateExecutableSha256 = $candidateHash
    publisher = $ExpectedPublisher
    installRoot = $installRoot
    startedAt = $startedAt.ToString('o')
    completedAt = [DateTimeOffset]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $resultPath -Encoding utf8
  Get-Content -LiteralPath $resultPath
} finally {
  if (Test-Path -LiteralPath $uninstaller) {
    $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
      Write-Warning "Hawk uninstaller returned $($process.ExitCode)."
    }
  }
}
