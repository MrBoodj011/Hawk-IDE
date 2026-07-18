# Hawk control plane

The control plane is a Cloudflare Worker backed by D1. It provides the
production API for:

- GitHub sign-in with seven-day signed sessions
- organizations, invitations, RBAC, and auditable membership changes
- conflict-safe workspace settings sync (source code and provider secrets are
  deliberately excluded)
- Stripe Checkout, Customer Portal, webhook-driven subscription state, plans,
  seats, and short-lived device-bound licenses
- explicit opt-in, allowlisted, code-free telemetry and crash events

## Required production configuration

Create a Cloudflare D1 database and put its ID in the
`CLOUDFLARE_D1_DATABASE_ID` GitHub secret. The deploy workflow renders
`wrangler.template.toml`, applies every migration, and deploys the Worker.

Secrets:

- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_D1_DATABASE_ID`
- `HAWK_SESSION_SIGNING_KEY` and `HAWK_LICENSE_SIGNING_KEY` (independent,
  randomly generated values of at least 32 characters)
- `HAWK_GITHUB_OAUTH_CLIENT_ID`, `HAWK_GITHUB_OAUTH_CLIENT_SECRET`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

Repository variables:

- `HAWK_CORS_ORIGINS`
- `HAWK_OAUTH_REDIRECT_URIS`
- `HAWK_BILLING_RETURN_ORIGINS`
- `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_ENTERPRISE`

Never put an LLM provider key in D1 or workspace sync. Hawk remains BYOK and
provider credentials stay on the user's machine.
