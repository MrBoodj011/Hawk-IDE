# Hawk Browser Companion

The companion captures explicitly scoped browser request metadata and streams it
to the loopback-only, token-protected Hawk evidence plane. Capture is disabled
by default. Request bodies and browser storage each require a separate opt-in.

## Pairing

1. In Hawk, run **Hawk: Pair Browser / Burp Capture**.
2. Load this directory as an unpacked extension during development.
3. Open the companion settings and paste the copied pairing JSON.
4. Set the narrowest scope expression for the authorized target.
5. Save, test the connection, and then enable capture.

Release builds package this directory as `hawk-browser-companion.zip`.
