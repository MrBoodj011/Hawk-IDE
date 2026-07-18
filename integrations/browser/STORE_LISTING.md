# Hawk Live Capture — store listing

## Short description

Streams explicitly authorized browser traffic to your local Hawk Security IDE.

## Full description

Hawk Live Capture connects Chromium request metadata to the loopback-only,
token-protected evidence plane inside Hawk Security IDE.

Capture is disabled until the operator pairs the extension with a running Hawk
window, supplies an authorized URL scope, and enables collection. Credentials
in common HTTP headers are redacted before forwarding. Request bodies and
session-storage snapshots are separate opt-ins. The extension has no cloud
backend, analytics, advertising, account, or remote execution capability.

Use it only on applications that you own or are explicitly authorized to test.

## Category

Developer Tools

## Support and privacy

- Support: private Hawk repository issue tracker.
- Privacy disclosure: `PRIVACY.md` in this directory.
- Responsible use: `RESPONSIBLE_USE.md` in the Hawk repository.

## Reviewer setup

1. Install Hawk Security IDE and run **Hawk: Pair Browser / Burp Capture**.
2. Paste the one-time local pairing JSON into the extension settings.
3. Use a narrow test scope such as `^https://example\.test/`.
4. Save, test the loopback connection, and explicitly enable capture.

Without a running, paired Hawk instance the extension sends no data.
