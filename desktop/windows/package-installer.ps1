param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Output,
  [string]$NsisBin = $env:HAWK_NSIS_BIN,
  [string]$OllamaBootstrap = ''
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceDir).Path
if ($source -notmatch 'VSCode-win32-x64$') {
  throw "Refusing to package an unexpected directory: $source"
}
if (!(Test-Path -LiteralPath (Join-Path $source 'Hawk.exe'))) {
  throw 'Hawk.exe was not found in the portable source directory.'
}
if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)') {
  throw "Invalid installer version: $Version"
}
$numericVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"
$bootstrapInput = if ($OllamaBootstrap) {
  $OllamaBootstrap
} else {
  Join-Path $PSScriptRoot 'install-ollama.ps1'
}
$ollamaBootstrapPath = (Resolve-Path -LiteralPath $bootstrapInput).Path

$makensis = @(
  if ($NsisBin) { Join-Path $NsisBin 'makensis.exe' }
  if ($NsisBin) { Join-Path $NsisBin 'Bin\makensis.exe' }
  "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
  "$env:ProgramFiles\NSIS\makensis.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (!$makensis) {
  throw 'NSIS was not found. Set HAWK_NSIS_BIN to a portable NSIS directory.'
}

$outputPath = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force (Split-Path -Parent $outputPath) | Out-Null
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$work = Join-Path $tempRoot 'hawk-nsis'
New-Item -ItemType Directory -Force $work | Out-Null
$scriptPath = Join-Path $work 'hawk-installer.nsi'
$icon = Join-Path $source 'resources\app\resources\win32\code.ico'

$template = @'
Unicode true
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "Sections.nsh"

Name "Hawk Security IDE"
OutFile "__OUTPUT__"
InstallDir "$PROGRAMFILES64\Hawk"
InstallDirRegKey HKLM "Software\Hawk Security IDE" "InstallDir"
Icon "__ICON__"
!define MUI_ICON "__ICON__"
!define MUI_UNICON "__ICON__"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Hawk.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Hawk Security IDE"

VIProductVersion "__NUMERIC_VERSION__"
VIAddVersionKey /LANG=1033 "ProductName" "Hawk Security IDE"
VIAddVersionKey /LANG=1033 "CompanyName" "Hawk Security"
VIAddVersionKey /LANG=1033 "FileDescription" "Hawk Security IDE Installer"
VIAddVersionKey /LANG=1033 "FileVersion" "__VERSION__"
VIAddVersionKey /LANG=1033 "ProductVersion" "__VERSION__"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Hawk Security IDE" SEC_MAIN
  SectionIn RO
  SetShellVarContext all
  SetOutPath "$INSTDIR"
  File /r "__SOURCE__\*.*"
  WriteUninstaller "$INSTDIR\Uninstall Hawk.exe"
  WriteRegStr HKLM "Software\Hawk Security IDE" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hawk Security IDE" "DisplayName" "Hawk Security IDE"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hawk Security IDE" "DisplayIcon" "$INSTDIR\Hawk.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hawk Security IDE" "DisplayVersion" "__VERSION__"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hawk Security IDE" "Publisher" "Hawk Security"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hawk Security IDE" "UninstallString" '"$INSTDIR\Uninstall Hawk.exe"'
  CreateDirectory "$SMPROGRAMS\Hawk Security IDE"
  CreateShortcut "$SMPROGRAMS\Hawk Security IDE\Hawk Security IDE.lnk" "$INSTDIR\Hawk.exe"
  CreateShortcut "$SMPROGRAMS\Hawk Security IDE\Uninstall Hawk.lnk" "$INSTDIR\Uninstall Hawk.exe"
  CreateShortcut "$DESKTOP\Hawk Security IDE.lnk" "$INSTDIR\Hawk.exe"
SectionEnd

Section "Hawk Local AI runtime (Ollama)" SEC_OLLAMA
  SetOutPath "$PLUGINSDIR"
  File /oname=Hawk-Ollama-Bootstrap.ps1 "__OLLAMA_BOOTSTRAP__"
  DetailPrint "Downloading and verifying the official Ollama runtime..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\Hawk-Ollama-Bootstrap.ps1" -Quiet'
  Pop $0
  Delete "$PLUGINSDIR\Hawk-Ollama-Bootstrap.ps1"
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "Hawk Security IDE installed successfully, but Ollama setup did not finish. Open Hawk and choose 'Set up local AI' to retry securely."
  ${EndIf}
SectionEnd

Function .onInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/NOLOCALAI" $R1
  ${IfNot} ${Errors}
    SectionSetFlags ${SEC_OLLAMA} 0
  ${EndIf}
FunctionEnd

LangString DESC_SEC_MAIN ${LANG_ENGLISH} "The complete Hawk Security IDE desktop application."
LangString DESC_SEC_OLLAMA ${LANG_ENGLISH} "Recommended: install the official verified Ollama runtime for private local AI. The coding model is chosen inside Hawk."
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MAIN} $(DESC_SEC_MAIN)
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_OLLAMA} $(DESC_SEC_OLLAMA)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  SetShellVarContext all
  Delete "$DESKTOP\Hawk Security IDE.lnk"
  RMDir /r "$SMPROGRAMS\Hawk Security IDE"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hawk Security IDE"
  DeleteRegKey HKLM "Software\Hawk Security IDE"
  RMDir /r "$INSTDIR"
SectionEnd
'@

$escaped = {
  param([string]$Value)
  $Value.Replace('$', '$$')
}
$script = $template.
  Replace('__SOURCE__', (& $escaped $source)).
  Replace('__OUTPUT__', (& $escaped $outputPath)).
  Replace('__ICON__', (& $escaped $icon)).
  Replace('__OLLAMA_BOOTSTRAP__', (& $escaped $ollamaBootstrapPath)).
  Replace('__NUMERIC_VERSION__', $numericVersion).
  Replace('__VERSION__', $Version)
[IO.File]::WriteAllText($scriptPath, $script, [Text.UTF8Encoding]::new($false))

& $makensis /V2 $scriptPath
if ($LASTEXITCODE -ne 0) {
  throw "NSIS failed with exit code $LASTEXITCODE"
}
if (!(Test-Path -LiteralPath $outputPath) -or (Get-Item -LiteralPath $outputPath).Length -eq 0) {
  throw 'Hawk EXE installer was not created.'
}
