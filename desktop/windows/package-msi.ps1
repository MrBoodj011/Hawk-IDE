param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Output,
  [string]$WixBin = $env:HAWK_WIX_BIN
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceDir).Path
if ($source -notmatch 'VSCode-win32-x64$') {
  throw "Refusing to package an unexpected directory: $source"
}

$wixRoots = @(
  $WixBin,
  "${env:ProgramFiles(x86)}\WiX Toolset v3.14\bin",
  "${env:ProgramFiles(x86)}\WiX Toolset v3.11\bin",
  "$env:ChocolateyInstall\bin"
) | Where-Object { $_ }
$heat = $null
$candle = $null
$light = $null
foreach ($root in $wixRoots) {
  if (!$heat -and (Test-Path (Join-Path $root 'heat.exe'))) {
    $heat = Join-Path $root 'heat.exe'
    $candle = Join-Path $root 'candle.exe'
    $light = Join-Path $root 'light.exe'
  }
}
if (!$heat) {
  throw 'WiX Toolset 3.x was not found. Install it before building the Hawk MSI.'
}

$normalizedVersion = if ($Version -match '^(\d+)\.(\d+)\.(\d+)') {
  "$($Matches[1]).$($Matches[2]).$($Matches[3])"
} else {
  throw "Invalid MSI version: $Version"
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$work = Join-Path $tempRoot 'hawk-msi'
New-Item -ItemType Directory -Force $work | Out-Null
$filesWxs = Join-Path $work 'files.wxs'
$productWxs = Join-Path $work 'product.wxs'

& $heat dir $source -cg HawkFiles -dr INSTALLFOLDER -srd -sreg -gg -var var.SourceDir -out $filesWxs
if ($LASTEXITCODE -ne 0) { throw "WiX heat failed with exit code $LASTEXITCODE" }

$product = @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="Hawk Security IDE" Language="1033" Version="$normalizedVersion"
           Manufacturer="Hawk Security" UpgradeCode="A956453E-0748-4387-9194-1C86A69606E4">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine"
             Description="Hawk Security IDE" />
    <MajorUpgrade DowngradeErrorMessage="A newer Hawk Security IDE is already installed." />
    <MediaTemplate EmbedCab="yes" CompressionLevel="high" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="Hawk" />
      </Directory>
    </Directory>
    <Feature Id="HawkProduct" Title="Hawk Security IDE" Level="1">
      <ComponentGroupRef Id="HawkFiles" />
    </Feature>
  </Product>
</Wix>
"@
[System.IO.File]::WriteAllText($productWxs, $product, [System.Text.UTF8Encoding]::new($false))

& $candle -nologo "-dSourceDir=$source" -arch x64 -out "$work\" $productWxs $filesWxs
if ($LASTEXITCODE -ne 0) { throw "WiX candle failed with exit code $LASTEXITCODE" }
New-Item -ItemType Directory -Force (Split-Path -Parent $Output) | Out-Null
& $light -nologo -sice:ICE61 -out $Output (Join-Path $work 'product.wixobj') (Join-Path $work 'files.wixobj')
if ($LASTEXITCODE -ne 0) { throw "WiX light failed with exit code $LASTEXITCODE" }
if (!(Test-Path -LiteralPath $Output) -or (Get-Item -LiteralPath $Output).Length -eq 0) {
  throw 'Hawk MSI was not created.'
}
