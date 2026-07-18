# Hawk production threat model

## Trust boundaries

1. Desktop and local daemon: trusted user device; untrusted workspace, traffic,
   tool output, extension content, and MCP servers.
2. LLM providers: user-selected third parties receiving only selected context.
3. Hawk Cloud: identity, RBAC, preferences, licensing, billing metadata, and
   opt-in code-free telemetry.
4. Release plane: GitHub Actions, signing identities, notarization, update
   manifests, and store publisher accounts.
5. Capture companions: untrusted HTTP messages crossing a rotating local
   pairing-token boundary.

## Highest-risk scenarios and controls

| Threat | Primary controls |
| --- | --- |
| Malicious update or artifact substitution | signed Windows/macOS artifacts, notarization, SHA-256 manifest, release gate, private update token |
| Cross-tenant data access | membership checks on every organization/workspace route, role hierarchy, D1 foreign keys, audit log |
| Workspace sync overwrite | monotonic revisions, compare-and-swap update, conflict response, 256 KiB limit |
| Account/session theft | GitHub identity verification, seven-day signed sessions, SecretStorage, TLS-only API settings |
| Billing forgery | Stripe signature verification, five-minute tolerance, server-owned price IDs |
| License sharing | seat count, hashed device IDs, recent-device window, 24-hour signed grants |
| Prompt/tool injection | permission gates, scoped missions, untrusted-output handling, MCP isolation, diff review |
| Secret or code telemetry leak | opt-in only, allowlisted event names/properties, blocked content keys, crash fingerprinting |
| Malicious capture content | localhost pairing token, size limits, sanitization, evidence redaction |
| CI credential compromise | GitHub environments, least-privilege permissions, secret preflight, no secret values in artifacts |

## Mandatory external validation

Before public launch, commission an independent review of desktop update
integrity, OAuth/session handling, RBAC/tenant isolation, Stripe webhooks,
workspace conflict behavior, extension boundaries, and MCP container escape
resistance. Retest every critical/high finding before release.
