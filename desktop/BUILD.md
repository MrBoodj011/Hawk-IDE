# Branded Code-OSS build

`prepare-code-oss.mjs` produces a separate, branded Code-OSS source tree. It
keeps the upstream source untouched, applies only the product identity values
in `product-overrides.json`, and builds the PentesterFlow extension in as a
built-in extension.

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
Microsoft branding, marketplace credentials, or proprietary telemetry.
