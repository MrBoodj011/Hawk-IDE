# Hawk production release runbook

## External accounts and credentials

Hawk cannot create or purchase these identities automatically:

- organization-validated Windows Authenticode certificate exported as PFX
- Apple Developer ID Application certificate, signing identity, team ID, Apple
  ID, and app-specific password
- Cloudflare account/API token and D1 database
- GitHub OAuth app
- Stripe account, webhook, and Price IDs
- Chrome Web Store publisher/service account
- public Burp companion source repository and PortSwigger submission token

## GitHub secrets

Desktop: `WINDOWS_CERTIFICATE_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD`,
`APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID`,
and `HAWK_UPDATE_URL`.

Update service: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
`HAWK_RELEASES_TOKEN`.

Control plane: see `deploy/control-plane/README.md`.

Store publishing: `CHROME_SERVICE_ACCOUNT_JSON`, `CHROME_PUBLISHER_ID`,
`CHROME_EXTENSION_ID`, and `BAPP_SUBMISSION_TOKEN`.

Monitoring: `HAWK_UPDATE_URL` and `HAWK_CONTROL_PLANE_URL`.

## Required repository variables

Configure the control-plane origins and Stripe prices listed in
`deploy/control-plane/README.md`, plus `HAWK_LEGAL_ENTITY`,
`HAWK_LEGAL_CONTACT`, `HAWK_PRIVACY_URL`, and `HAWK_TERMS_URL`.

Set `HAWK_PRODUCTION_MONITORING_ENABLED=true` only after both production
health URLs are live. Private repositories also require GitHub Advanced
Security and `HAWK_CODEQL_ENABLED=true` before the CodeQL job is enabled;
dependency and deployment security checks run regardless.

## Sequence

1. Obtain legal review and publish Privacy, Terms, EULA, and Responsible Use.
2. Deploy staging control/update services and apply D1 migrations.
3. Complete the independent security assessment and retest.
4. Run a signed Beta tag and the real-user Beta program.
5. Publish the browser listing once manually, then enable API updates.
6. Submit the public Burp companion repository for PortSwigger review.
7. Resolve every Stable release gate and push the numbered Stable tag.
8. Verify signatures, notarization, checksums, update channels, monitoring,
   billing, account deletion, and store status from clean devices.

The official GitHub Release is created only by `desktop-release.yml`. Dry runs
remain unsigned and can never publish.
