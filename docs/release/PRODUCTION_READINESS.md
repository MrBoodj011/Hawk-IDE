# Hawk production release readiness

Status updated on 2026-07-21. This separates implemented release controls from
owner credentials and third-party approvals that source code cannot create.

## Implemented

- Automatic Windows x64 and Linux x64 Code-OSS builds.
- EXE, MSI, portable ZIP, AppImage, deb, tarball, VSIX, Browser ZIP, and Burp JAR.
- SHA-256 manifest for release assets.
- Stable/beta channel selection in the production updater, a strict feed
  schema, GitHub Releases fallback, and GitHub Pages deployment workflow.
- Real release updater test (`v0.2.0` to `v0.2.1`) with full installer
  download, size validation, PE validation, and SHA-256 verification.
- RSA code-signing validation, RFC 3161 timestamping, and Authenticode trust
  verification for Hawk.exe, the EXE installer, and MSI.
- A hard publication gate: GitHub cannot publish a desktop release without a
  trusted Windows signing configuration (PFX or Azure Artifact Signing) and
  the expected publisher pin.
- Chrome Web Store OAuth refresh, upload, and submission tooling.
- Visual Studio Marketplace identity validation and `vsce` publication tooling.
- PortSwigger BApp Store description, setup, security, hashed artifact, and
  reviewer submission pack.
- External Hawk pentest scope and private beta acceptance plan.
- A machine-readable production-readiness gate for signing configuration,
  current release assets, GitHub CI, five real beta sessions, and independent
  pentest evidence. The gate validates evidence but never fabricates it.
- A secure in-product LLM provider wizard. Hosted API keys are held in the
  OS-backed extension secret vault and injected only into the local daemon;
  keys never enter workspace settings, Git, logs, prompts, or task history.
- A Hawk-only branding gate across product paths, packages, commands, docs,
  installers, and release assets. Required Apache attribution is isolated to
  `NOTICE`.
- A real signed installer upgrade job. The first signed 0.7.x release becomes
  the baseline; every later 0.7.x release installs the previous signed EXE,
  upgrades it, verifies the installed Hawk version/signature/identity, and
  cleans the ephemeral runner.
- Reproducible internal validation against Microsoft TypeScript, Microsoft
  Visual Studio Code, and OWASP Juice Shop, recorded in
  `docs/audit/INTERNAL_VALIDATION_2026-07-18.md`.

## Owner action required

### 1. Repair GitHub Actions billing

The most recent desktop workflow never reached checkout. GitHub returned:

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased.

This is an account-level billing control and cannot be changed by repository
code or a repository token. The owner must repair the payment method or
spending limit under GitHub **Settings → Billing & plans**, then re-run the
desktop workflow.

### 2. Add a trusted Windows code-signing identity

Use either an RSA code-signing certificate from a Windows-trusted provider or
Microsoft Azure Artifact Signing Public Trust.

For a password-protected PFX, add these private repository secrets:

- `WINDOWS_CERTIFICATE_BASE64`
- `WINDOWS_CERTIFICATE_PASSWORD`
- Repository variable `HAWK_WINDOWS_PUBLISHER`, matching the trusted
  certificate subject.

Never commit the PFX or password. The workflow validates the private key,
Code Signing EKU, RSA key type, expiry, timestamp, Windows trust, and final
signer before it can publish.

The historical `v0.2.1` installer is SHA-verified but unsigned. The source is
now version `v0.7.0`, but no official signed `v0.7.0` release exists yet. The
historical installer cannot be
made signed in place: signing changes the binary and its hash, so a new release
must be built after the certificate is configured.

Every published desktop release now runs a post-publication Windows smoke test
against the real private GitHub feed. It downloads the new installer and
verifies the release SHA-256 manifest, exact byte size, PE header, trusted
redirect host, and a `Valid` Authenticode chain without launching it.
When `HAWK_WINDOWS_PUBLISHER` is configured, the smoke test also checks that
the final installer signer matches that trusted subject pin.

The updater checks the HTTPS production feed at startup (and from **Hawk:
Check for Production Updates**), sorts the selected stable/beta channel by semantic
version, downloads only the matching Windows installer, and asks for explicit
install approval. On Windows it independently validates the Authenticode chain
and optional `hawk.updates.expectedPublisher` subject pin before launching the
installer. A malformed or unavailable production feed falls back to the same
official GitHub Releases API. This keeps updates real and
unattended-download capable without silently executing a remote binary.

The `Hawk Production Update Feed` workflow deploys
`https://mrboodj011.github.io/hawk/updates/feed.json` after a published desktop
release. The owner must enable GitHub Pages with **GitHub Actions** as its source
once; `npm run release:readiness:enforce` then checks that the current stable
version is present in the live feed.

For Azure Artifact Signing, create a verified account/profile with the Code
Signing profile signer role and add:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_ARTIFACT_SIGNING_ENDPOINT`
- `AZURE_ARTIFACT_SIGNING_ACCOUNT`
- `AZURE_ARTIFACT_SIGNING_PROFILE`

The workflow uses Microsoft's official `azure/artifact-signing-action@v2`,
then runs the same Windows trust verification. Configure only one signing mode.

### 3. Browser store owner account

Chrome publication requires an owner-controlled Web Store developer account,
two-step verification, listing/privacy completion, an extension item ID,
publisher ID, and OAuth access. Configure these only in the release environment:

- variables `CHROME_WEBSTORE_PUBLISHER_ID`, `CHROME_WEBSTORE_EXTENSION_ID`
- secrets `CHROME_WEBSTORE_CLIENT_ID`, `CHROME_WEBSTORE_CLIENT_SECRET`,
  `CHROME_WEBSTORE_REFRESH_TOKEN`

Run `npm run publish:browser-store -- --file <zip>` to upload without
submission; add `--publish` only after manual listing review.

### 4. Visual Studio Marketplace owner account

Create the publisher identity and set `HAWK_VSCE_PUBLISHER` to the exact value
used in `extensions/hawk-security-ide/package.json`. Supply either the
Marketplace PAT accepted by `vsce` or Microsoft Entra credentials. The
`Hawk Official Store Publication` workflow packages and validates the VSIX;
`publish=true` is fail-closed when identity or authentication is missing.

### 5. PortSwigger review

PortSwigger requires a reviewer-accessible GitHub source link and a submission
through its extension portal. Use `integrations/burp/BAPP_SUBMISSION.md` and
the hashed `bapp-submission.json` generated by the store workflow.
Store acceptance and timing remain PortSwigger decisions.

### 6. Independent pentest and real users

Provide the signed release candidate and
`docs/audit/HAWK_EXTERNAL_PENTEST_SCOPE.md` to an independent assessor. A Hawk
self-test is useful engineering evidence but cannot honestly be called an
external pentest. Complete the scenarios and exit criteria in
`docs/audit/BETA_TEST_PLAN.md` with real projects before public launch.

Record the final assessor report and exact candidate with
`npm run pentest:record`; it writes hashes into the private, gitignored
evidence file. Record each real session with `npm run beta:record`.
Run `npm run release:readiness:enforce` for the final owner-controlled gate.

### 7. Store approvals

After each third party has actually published Hawk, record the three listing
URLs with `npm run stores:record` (the example schema is
`docs/release/STORE_PUBLICATION_EVIDENCE.example.json`). The release gate
accepts only HTTPS URLs on the official Chrome, Microsoft Marketplace, and
PortSwigger hosts.
