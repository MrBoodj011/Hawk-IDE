# Hawk Live Capture privacy disclosure

Hawk Live Capture processes browser request metadata only after the operator
pairs it with Hawk Security IDE, defines an authorized URL scope, and enables
capture.

- Data is sent only to the paired loopback address (`localhost` / `127.0.0.1`).
- Hawk has no cloud capture service and the extension contains no analytics or ads.
- Authorization, cookie, API-key, and related credential headers are redacted.
- Request-body capture is disabled by default and requires a separate opt-in.
- Session-storage capture is disabled by default and requires a separate opt-in.
- Pairing settings stay in the browser extension's local storage.
- Disabling capture or removing the extension stops processing immediately.

The operator controls any evidence retained locally by Hawk and is responsible
for using the extension only within an explicitly authorized scope.
