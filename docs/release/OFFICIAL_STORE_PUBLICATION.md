# Hawk official store publication

Hawk packages Chrome Web Store, Visual Studio Marketplace, and PortSwigger
BApp artifacts in `.github/workflows/store-publication.yml`. Publication is
fail-closed: selecting **publish** fails when the owner account or credential is
missing. A successful package job is not represented as store approval.

## Chrome Web Store

Create the listing in the owner account, complete its privacy and listing
information, and enable two-step verification. Configure these GitHub values in
the protected `official-stores` environment:

- variables: `CHROME_WEBSTORE_PUBLISHER_ID`, `CHROME_WEBSTORE_EXTENSION_ID`
- secrets: `CHROME_WEBSTORE_CLIENT_ID`, `CHROME_WEBSTORE_CLIENT_SECRET`,
  `CHROME_WEBSTORE_REFRESH_TOKEN`

The workflow obtains a short-lived access token, uploads the ZIP through the
Chrome Web Store v2 API, then submits it for review only when `publish=true`.

## Visual Studio Marketplace

Create a Marketplace publisher and set the extension manifest's `publisher` to
that exact identifier. Configure `HAWK_VSCE_PUBLISHER` as an environment
variable. Authentication can use either:

- `VSCE_PAT` while that authentication method remains accepted; or
- `VSCE_AZURE_CLIENT_ID`, `VSCE_AZURE_TENANT_ID`, and
  `VSCE_AZURE_CLIENT_SECRET` for Microsoft Entra ID.

The publisher identity is checked before `vsce publish` runs. Hawk never places
the credential inside a VSIX or repository file.

## PortSwigger BApp Store

PortSwigger's official process requires a reviewer-accessible source repository,
an extension-portal submission, and human review. Hawk builds the JAR, hashes it,
and generates `bapp-submission.json` with the official submission URL. The owner
must submit that pack; automation cannot truthfully mark it published or
approved.

After all three reviews are complete, record their real listing URLs with:

```powershell
npm run stores:record -- `
  --chrome <chrome-web-store-url> `
  --vscode <visual-studio-marketplace-url> `
  --burp <portswigger-bapp-url>
```

The local ledger is gitignored and consumed by the production readiness gate.
