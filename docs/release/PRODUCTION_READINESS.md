# Hawk production release readiness

Status updated on 2026-07-20. This separates implemented release controls from
owner credentials and third-party approvals that source code cannot create.

## Implemented

- Automatic Windows x64 and Linux x64 Code-OSS builds.
- EXE, MSI, portable ZIP, AppImage, deb, tarball, VSIX, Browser ZIP, and Burp JAR.
- SHA-256 manifest for release assets.
- Stable/beta channel selection in the private updater.
- Real private-feed updater test (`v0.2.0` to `v0.2.1`) with full installer
  download, size validation, PE validation, and SHA-256 verification.
- RSA code-signing validation, RFC 3161 timestamping, and Authenticode trust
  verification for Hawk.exe, the EXE installer, and MSI.
- A hard publication gate: GitHub cannot publish a desktop release without a
  trusted Windows signing configuration (PFX or Azure Artifact Signing) and
  the expected publisher pin.
- Chrome Web Store listing/privacy/permission pack and upload/submission script.
- PortSwigger BApp Store description, setup, security, and submission pack.
- External Hawk pentest scope and private beta acceptance plan.
- A machine-readable production-readiness gate for signing configuration,
  current release assets, GitHub CI, five real beta sessions, and independent
  pentest evidence. The gate validates evidence but never fabricates it.
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

The updater checks the private feed at startup (and from **Hawk: Check for
Private Release Updates**), sorts the selected stable/beta channel by semantic
version, downloads only the matching Windows installer, and asks for explicit
install approval. On Windows it independently validates the Authenticode chain
and optional `hawk.updates.expectedPublisher` subject pin before launching the
installer. This keeps updates real and unattended-download capable without
silently executing a remote binary.

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

- `CHROME_WEBSTORE_PUBLISHER_ID`
- `CHROME_WEBSTORE_EXTENSION_ID`
- `CHROME_WEBSTORE_ACCESS_TOKEN`

Run `npm run publish:browser-store -- --file <zip>` to upload without
submission; add `--publish` only after manual listing review.

### 4. PortSwigger review

PortSwigger requires a reviewer-accessible GitHub source link and a submission
through its extension portal. Use `integrations/burp/BAPP_SUBMISSION.md`.
Store acceptance and timing remain PortSwigger decisions.

### 5. Independent pentest and real users

Provide the signed release candidate and
`docs/audit/HAWK_EXTERNAL_PENTEST_SCOPE.md` to an independent assessor. A Hawk
self-test is useful engineering evidence but cannot honestly be called an
external pentest. Complete the scenarios and exit criteria in
`docs/audit/BETA_TEST_PLAN.md` with real projects before public launch.

Place assessor evidence using
`docs/audit/EXTERNAL_PENTEST_EVIDENCE.example.json` as the schema reference,
then point `HAWK_EXTERNAL_PENTEST_EVIDENCE` at the private evidence file.
Run `npm run release:readiness:enforce` for the final owner-controlled gate.
