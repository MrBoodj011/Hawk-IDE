# Hawk Security IDE build

`prepare-code-oss.mjs` produces a separate, branded Code-OSS source tree. It
keeps the upstream source untouched, applies the Hawk product
identity and platform icons, and builds the Hawk extension in as a
built-in extension. The icon files are generated from
`branding/generate-brand-assets.mjs`, so Windows, Linux, macOS and server
surfaces receive one consistent product mark.
The preparation step also removes the upstream Copilot extension, prevents it
from being fetched as a built-in, disables its built-in AI surfaces and
first-run onboarding, and starts with the upstream secondary sidebar hidden.
Hawk ships its own native AI workspace and `Hawk Carbon` workbench theme
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

For Linux and macOS, launch the prepared source with `./scripts/code.sh` after
`npm run watch`. The prepared tree retains Code-OSS licensing; do not add
third-party product branding, marketplace credentials, or proprietary
telemetry.

## Production desktop artifacts

`.github/workflows/desktop-release.yml` pins the upstream Code-OSS commit and
Node runtime from `desktop/upstream.json`, runs the full Hawk verification gate,
and produces:

- Windows x64 portable ZIP, Inno Setup EXE, and WiX MSI.
- Linux x64 tar.gz, deb, and AppImage.
- macOS Intel and Apple Silicon ZIP and DMG.
- Hawk Browser Companion ZIP and Hawk Burp Companion JAR.
- `SHA256SUMS` and `update.json` for every release asset.

Version tags run the release automatically. A manual run builds the same
artifacts without publishing unless its **publish** input is explicitly
enabled.

Windows Authenticode signing uses `WINDOWS_CERTIFICATE_BASE64` and
`WINDOWS_CERTIFICATE_PASSWORD`. macOS signing/notarization uses
`APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_PASSWORD`, and
`APPLE_TEAM_ID`. Missing credentials produce an unsigned verification artifact
and are never silently represented as signed.

The native Code-OSS updater is enabled when `HAWK_UPDATE_URL` points at the
deployed worker in `deploy/update-worker`. That worker keeps the private GitHub
release token server-side and proxies only assets declared in the release
manifest.
