# Hawk real-user beta program

Hawk's beta gate accepts measured sessions from real projects only. Synthetic
unit tests, generated identities, and an owner marking their own run as an
external user's session do not satisfy the gate.

## Onboarding

Give each tester the exact signed candidate hash, the responsible-use policy,
the allowed target/workspace scope, and a unique cohort label. Never collect
API keys, pairing tokens, captured credentials, source files, or raw HTTP
bodies. A tester can use Ollama or their own provider key through Hawk's local
secret vault.

## Session acceptance

A session is accepted only when the tester completes the relevant scenarios in
`BETA_TEST_PLAN.md`, supplies sanitized evidence, reports no manual recovery,
has no open Critical/High finding, stays below 500 MB RSS, and records search
p95 below 50 ms. The release gate requires five passing sessions across at
least three cohorts.

The owner records each returned session with `npm run beta:record`. Evidence is
kept under `.hawk/validation/`, which is gitignored. Run
`npm run release:readiness:enforce` before a production release. Hawk validates
the ledger but cannot recruit people or invent their results.
