# Hawk Security IDE build

`prepare-code-oss.mjs` produces a separate, branded Code-OSS source tree. It
keeps the upstream source untouched, applies the Hawk product
identity and platform icons, and builds the Hawk extension in as a
built-in extension. The icon files are generated from
`branding/generate-brand-assets.mjs`, so Windows, Linux, and server surfaces
receive one consistent product mark. The personal release workflow deliberately
does not build or publish Apple artifacts.
The preparation step also removes the upstream Copilot extension, prevents it
from being fetched as a built-in, disables its built-in AI surfaces and
first-run onboarding, and starts with the upstream secondary sidebar hidden.
Hawk ships its own native AI workspace and `Hawk Obsidian` workbench theme
instead of showing VS Code or Copilot onboarding.
It also creates local Git metadata in the prepared tree because current
Code-OSS dependency setup requires it; the upstream checkout remains unchanged.

The upstream project requires a path without spaces and its current Node.js,
Python, and platform C/C++ prerequisites. See the official Code-OSS build
documentation before provisioning a build machine.

```powershell
git clone https://github.com/microsoft/vscode.git C:\src\vscode
npm run build:extension
node desktop/prepare-code-oss.mjs --source C:\src\vscode --out C:\src\hawk-security-ide
Set-Location C:\src\hawk-security-ide
npm install
npm run watch
.\scripts\code.bat
```

For Linux, launch the prepared source with `./scripts/code.sh` after
`npm run watch`. The prepared tree retains Code-OSS licensing and contains no
Hawk account, billing, cloud-sync, store-publisher, or telemetry service.

## Personal desktop artifacts

`.github/workflows/desktop-release.yml` pins the upstream Code-OSS commit and
Node runtime from `desktop/upstream.json`, runs the full Hawk verification gate,
and produces:

- Windows x64 portable ZIP, Inno Setup EXE, and WiX MSI.
- Linux x64 tar.gz, deb, and AppImage.
- Hawk Browser Companion ZIP and Hawk Burp Companion JAR.
- `SHA256SUMS` for every release asset.

Version tags run the release automatically. A manual run builds the same
artifacts without publishing unless its **publish** input is explicitly
enabled.

Windows Authenticode signing is optional. If
`WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD` are present,
the workflow signs Hawk; otherwise it publishes an explicitly unsigned
personal artifact. Releases are installed or updated manually from the
private GitHub repository.

The NSIS EXE includes a selected **Hawk Local AI runtime (Ollama)** component.
It does not embed the roughly gigabyte-scale third-party runtime. Instead, the
installer runs `desktop/windows/install-ollama.ps1`, which downloads only the
latest official `ollama/ollama` Windows release, verifies its published
SHA-256 digest and Authenticode signer, and performs the per-user installation.
The coding model is chosen later inside Hawk so its additional disk usage is
never accepted implicitly.

For a personal Windows build outside GitHub Actions, the checked-in packaging
scripts accept portable tool directories and do not require a machine-wide
installation:

```powershell
$env:HAWK_NSIS_BIN = 'C:\tools\nsis'
$env:HAWK_WIX_BIN = 'C:\tools\wix314'
.\desktop\windows\package-installer.ps1 -SourceDir C:\build\VSCode-win32-x64 -Version 0.2.1 -Output artifacts\HawkSetup-windows-x64-0.2.1.exe
.\desktop\windows\package-msi.ps1 -SourceDir C:\build\VSCode-win32-x64 -Version 0.2.1 -Output artifacts\Hawk-windows-x64-0.2.1.msi
```
