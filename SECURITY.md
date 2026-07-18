# Security Policy

## Supported versions

The current Stable release receives security fixes. The current Beta release
is supported for evaluation and may receive fixes before promotion.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use GitHub's private security
advisory flow for this repository. Include the affected version, impact,
reproduction steps, required privileges, and a minimal redacted proof.

The production operator must publish a monitored security email before public
launch. Initial acknowledgment target: two business days. Critical
vulnerabilities are triaged immediately and coordinated disclosure timing is
agreed with the reporter.

## Scope

Hawk desktop, update service, control plane, official companion extensions,
release pipeline, and Hawk-owned cloud endpoints are in scope. Third-party LLM
providers, GitHub, Stripe, Cloudflare, PortSwigger, and operating-system
platforms are not controlled by Hawk; reports showing a Hawk-specific
integration flaw remain welcome.

Never access another user's data, degrade service, use social engineering, or
retain sensitive data. Stop after proving impact with the minimum evidence.
