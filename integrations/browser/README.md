# Hawk Browser Companion

The companion captures explicitly scoped browser request metadata and streams it
to the loopback-only, token-protected Hawk evidence plane. Capture is disabled
by default. Request bodies, browser storage, and structural UI interactions each
require a separate opt-in. Interaction capture records a bounded structural
fingerprint, tag, role, input type, timestamps, and tab identifier; it never
records button text, field values, or query-string values.

## Pairing

1. In Hawk, run **Hawk: Pair Browser / Burp Capture**.
2. Load this directory as an unpacked extension during development.
3. Open the companion settings and paste the copied pairing JSON.
4. Set the narrowest scope expression for the authorized target.
5. Save, test the connection, and then enable capture.
6. Enable **Capture UI interactions** only when you want Hawk Interaction Chaos
   to correlate normal testing clicks/submits with mutation requests.

Release builds package this directory as `hawk-browser-companion.zip`.
