# Hawk internal validation - 2026-07-28

This report records reproducible engineering evidence for the current source
tree. It is not an external pentest certificate and does not replace real-user
beta evidence or owner-controlled release credentials.

## Result

The internal engineering gates pass.

| Check | Result |
| --- | --- |
| Branding audit | PASS across 595 working files |
| TypeScript and Biome | PASS |
| Test suite | 120 files, 839 passed, 16 skipped |
| Chaos recovery | 4/4 scenarios pass |
| Coverage | 68.01% statements, 60.51% branches, 70.05% functions, 70.78% lines |
| Root and extension builds | PASS |
| Browser and Burp contracts | PASS |
| Packaged daemon and MCP runtime E2E | PASS |
| Full dependency audit | 0 vulnerabilities |
| Production dependency audit | 0 vulnerabilities |

## Memory and indexing

The semantic index no longer keeps the normalized source a second time in
memory. Changed files are parsed in small bounded waves and integrated
immediately, preventing the cold build from retaining every intermediate AST
result until the final file completes.

The Windows x64 benchmark used Node.js 24.18.0:

| Metric | Measured result | Gate |
| --- | ---: | ---: |
| Indexed source | 646 files / 2,100 chunks | bounded |
| Cold build | 1.96 s | under 5 s |
| Search p95 | 10.1 ms | under 50 ms |
| Estimated resident index | 45.6 MiB | under 320 MiB |
| Process peak RSS | 450 MiB | under 500 MiB |

`npm run benchmark:index-memory` now runs in Hawk CI so the 500 MiB product
contract is enforced continuously.

## Governed project learning

The project-learning ledger now:

- upgrades a reviewed fix from neutral to positive after the operator applies
  it;
- preserves the stable identity and original creation time of a repeated
  signal;
- records an update time;
- enforces real deletion-based retention in both project and cross-project
  stores;
- keeps global test state isolated instead of writing into the user's home
  directory.

The retention and applied-fix lifecycle are covered by an automated regression
test.

## Dependency assurance

The vulnerable transitive `brace-expansion` package used by extension
packaging is pinned to 5.0.8. Both the full dependency graph and the
production-only graph report zero vulnerabilities. Hawk Security Assurance
now runs both audits so development and release tooling remain covered.

## Commands

```powershell
npm run ci
npm run benchmark:index-memory
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm run release:readiness
```

## External release gates

The online readiness check correctly remains blocked on evidence that source
code cannot create honestly:

- a trusted Windows signing identity;
- five passing real-project beta sessions across three cohorts;
- an independent external pentest;
- owner-verified Chrome Web Store, Visual Studio Marketplace, and PortSwigger
  BApp Store listings;
- an official signed v0.7.0 GitHub Release;
- a signed v0.7.0 entry in the live production feed and a staged update
  rehearsal.

The repository contains workflows, runbooks, evidence schemas, and validation
logic for these gates. They must be completed with the owner's accounts,
credentials, signed artifacts, real users, and independent assessor.
