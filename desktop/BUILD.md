# Branded Code-OSS build

`prepare-code-oss.mjs` produces a separate, branded Code-OSS source tree. It
keeps the upstream source untouched, applies the PentesterFlow product
identity and platform icons, and builds the PentesterFlow extension in as a
built-in extension. The icon files are generated from
`branding/generate-brand-assets.mjs`, so Windows, Linux, macOS and server
surfaces receive one consistent product mark.
It also creates local Git metadata in the prepared tree because current
Code-OSS dependency setup requires it; the upstream checkout remains unchanged.

The upstream project requires a path without spaces and its current Node.js,
Python, and platform C/C++ prerequisites. See the official Code-OSS build
documentation before provisioning a build machine.

```powershell
git clone https://github.com/microsoft/vscode.git C:\src\vscode
npm run build:extension
node desktop/prepare-code-oss.mjs --source C:\src\vscode --out C:\src\pentesterflow-codeoss
Set-Location C:\src\pentesterflow-codeoss
npm install
npm run watch
.\scripts\code.bat
```

For Linux and macOS, launch the prepared source with `./scripts/code.sh` after
`npm run watch`. The prepared tree retains Code-OSS licensing; do not add
third-party product branding, marketplace credentials, or proprietary
telemetry.
