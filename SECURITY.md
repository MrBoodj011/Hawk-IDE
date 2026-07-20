# Security Policy

## Supported versions

The current Stable release receives security fixes. The current Beta release
is supported for evaluation and may receive fixes before promotion.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use GitHub's private security
advisory flow for this repository. Include the affected version, impact,
reproduction steps, required privileges, and a minimal redacted proof.

This is a private, single-operator project. Critical vulnerabilities should be
fixed before the affected build is used again.

## Scope

Hawk desktop, its local daemon/MCP runtime, Browser and Burp companions, and
the private release pipeline are in scope. Hawk has no account service,
billing system, cloud synchronization, telemetry collector, Apple release, or
store-publishing pipeline. Third-party LLM providers, GitHub, and the operating
system remain outside Hawk's control.

Never access another user's data, degrade service, use social engineering, or
retain sensitive data. Stop after proving impact with the minimum evidence.

For the independent assessment procedure, lab fault matrix, release-chain
checks, and retest gate, see
[`docs/audit/EXTERNAL_PENTEST_RUNBOOK.md`](docs/audit/EXTERNAL_PENTEST_RUNBOOK.md).
