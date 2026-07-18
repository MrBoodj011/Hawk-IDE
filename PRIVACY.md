# Hawk Security IDE Privacy Notice

Effective date: July 18, 2026

Hawk is local-first security software. By default, telemetry and crash
reporting are disabled, source code stays on the user's machine, and Hawk does
not operate a hosted account for the user.

The legal entity, postal address, privacy contact, and jurisdiction of the
production operator must be published on the official Hawk website before a
public production release. The release pipeline deliberately blocks public
artifacts until the production privacy and terms URLs are configured.

## Data Hawk processes

### Local-only use

Hawk may process source files, editor state, Git metadata, local HTTP captures,
security findings, evidence, prompts, model responses, and tool output on the
user's device. These data are not sent to Hawk Cloud by the local product.

If the user configures an external LLM provider, the context selected for that
request is sent directly to that provider under the user's provider account and
terms. API keys remain on the device and are never included in cloud sync.

### Optional Hawk Cloud

When a user signs in, Hawk Cloud stores:

- GitHub account ID, login, verified email, and avatar URL
- organizations, memberships, roles, invitations, and audit records
- subscription/customer identifiers, plan, status, seats, and billing period
- synchronized Hawk preferences and revision history
- hashed device identifiers and recent license activity

Cloud sync is restricted to Hawk preferences. It does not accept source code,
prompts, model responses, captured HTTP traffic, evidence, or LLM API keys.

### Optional telemetry and crash reports

Telemetry and crash reporting are separate opt-ins and are disabled by
default. Allowed events contain product version, operating system, coarse
operation status, duration/count values, and an anonymous installation hash.
Crash reports contain an error type and a normalized fingerprint. Hawk removes
paths and does not transmit stack traces, error messages, code, prompts,
responses, URLs, headers, cookies, tokens, secrets, or email addresses.

## Service providers

Production deployments may use Cloudflare for API/database hosting, GitHub for
identity and releases, and Stripe for payments. Users independently choose any
LLM provider they configure. Store distribution may use Microsoft, Google,
Apple, or PortSwigger. The production operator must publish its current
subprocessor list and data locations on the official privacy page.

## Retention and deletion

- session tokens expire after seven days
- device licenses expire after 24 hours and are refreshed while active
- inactive device records may be removed after 35 days
- telemetry retention follows the plan's published retention window and the
  production deletion schedule
- billing records are retained where legally required

Users may request account export, correction, or deletion through the
production privacy contact. Deleting an organization removes its memberships,
workspace preferences, invitations, license activations, and organization
audit data, subject to legally required billing retention.

## Security

Hawk uses scoped bearer sessions, role-based authorization, encrypted
transport, short-lived device licenses, hashed invitation/device identifiers,
signed Stripe webhooks, audit logs, and secret storage on the client. No system
is risk-free. Security reports must follow [SECURITY.md](SECURITY.md).

## Changes

Material changes are dated in this notice and disclosed in release notes.
Where required, users will be asked for renewed consent before newly collected
data is processed.
