# Hawk Burp Companion — BApp submission pack

## Name

Hawk Burp Companion

## One-line summary

Streams explicitly scoped, redacted Burp traffic to a paired local Hawk
Security IDE evidence timeline.

## What it does

The Java 21 Montoya extension adds a Hawk tab to Burp Suite. It forwards
authorized request/response metadata to a loopback-only Hawk capture bridge.
Capture is disabled by default, pairing uses a high-entropy local token, common
credential headers are redacted, forwarding is rate-limited, and slow work runs
on a bounded background queue rather than Swing's event thread.

## Setup

1. Run **Hawk: Pair Browser / Burp Capture** in Hawk Security IDE.
2. Paste the generated pairing JSON into the Hawk tab in Burp.
3. Keep **Capture only requests in Burp Suite scope** enabled.
4. Add the authorized target to Burp scope and explicitly enable capture.

## Security and privacy

- No Hawk cloud service, account, analytics, or advertising.
- The bridge URL validator accepts loopback HTTP only.
- Capture is disabled until explicit pairing, scope, and enablement.
- The queue and per-second forwarding rate are bounded.
- Credential headers are redacted before local forwarding.

## Submission prerequisite

PortSwigger requires a GitHub link containing the relevant source and reviews
the extension for security and quality. The owner must provide a reviewer-
accessible repository URL and submit this text through PortSwigger's extension
portal. A private repository that reviewers cannot access cannot be submitted.
