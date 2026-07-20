# Hawk governed identity replay

Identity replay is an authorized differential-testing workflow for a request
already captured by Hawk Browser or Burp companions. It is deliberately
separate from HAR import and passive traffic correlation.

## Safety contract

- The plan binds to one captured request and its exact host **and port**.
- The operator supplies two to eight named identity credential sets. Hawk
  accepts only credential material such as `Authorization`, `Cookie`, API-key,
  auth-token, or CSRF headers; hop-by-hop headers and host/content-length
  overrides are rejected.
- Creating a plan does not send traffic. Execution requires `approved: true`
  and the exact plan `approvalHash` returned by the plan step.
- Requests are rate-limited to 0.1–5 per second, never follow redirects, and
  use a 15-second timeout. Request bodies are capped at 64 KiB.
- Responses are consumed as a maximum 128 KiB prefix and returned only as
  status, timing, content type, sanitized location, byte count, and a SHA-256
  prefix fingerprint. Raw credentials, request bodies, and response bodies are
  not persisted or returned.
- A difference is an evidence lead. Hawk does not label it an authorization
  vulnerability automatically; identity, object ownership, impact, scope,
  side effects, and analyst review remain mandatory.

## Local daemon API

The token-gated loopback daemon exposes:

- `POST /v1/traffic/replay/plan` with `requestId`, `allowedHost`, and
  `identities`;
- `POST /v1/traffic/replay/execute` with `planId`, `approvalHash`, and
  `approved: true`.

Plans expire after ten minutes and are held in memory only. The endpoint is
loopback-only and requires the daemon’s `X-Hawk-Token` header.
