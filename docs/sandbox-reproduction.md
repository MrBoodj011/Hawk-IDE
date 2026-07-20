# Automatic sandbox reproduction

Hawk can automatically reproduce supported deterministic audit signals in a
local Docker sandbox. This workflow confirms that the exact detector still
observes the exact source location under a controlled baseline and negative
control. It does not, by itself, prove exploitability or user impact.

## Trust contract

1. Hawk rescans the trusted workspace and selects a current finding with a
   supported static rule and an in-workspace source location.
2. Planning creates a ten-minute contract containing the finding identity,
   source location and source SHA-256, existing local Docker image, isolation
   limits, and three gates. A second SHA-256 binds the complete internal plan.
3. The extension displays the image, source, limits, isolation mode, and hash.
   Execution starts only after the operator approves that exact plan.
4. Hawk rejects expired plans, changed hashes, changed findings, changed source
   locations or bytes, unsupported rules, and path traversal before Docker
   starts.
5. The result is persisted under `.hawk/brain/reproductions/` and linked to the
   finding as `reproduces-signal` or `attempted-reproduction` in the Security
   Graph.

## Sandbox stages

- **Baseline** reads the exact source file from the read-only workspace mount,
  validates the source line, and emits only a SHA-256 digest.
- **Negative control** proves the same rule remains negative against a
  known-safe synthetic value.
- **Reproduction** applies the deterministic rule to the exact source location
  and emits only bounded JSON metadata and a digest. Source and secret values
  are never printed.

The orchestrator uses `networkMode: none`, a read-only root filesystem,
read-only workspace mount, a non-root user, dropped Linux capabilities,
`no-new-privileges`, 0.5 CPU, 256 MB RAM, 30 seconds per gate, and a 32 MB
artifact ceiling. The image must already exist locally; Hawk never pulls it.

Build the included worker once:

```sh
docker build -t hawk-worker:local docker/hawk-worker
```

The desktop image setting is `hawk.reproduction.image`.

## Mission Control

Run a local audit, open the prioritized security queue, and choose
**Reproduce** on a supported finding. The modal shows the complete public plan
before approval. Mission Control then displays the latest result beside the
finding and counts reproduced signals in the operational scoreline.

## MCP

- `ide_static_audit` returns current finding IDs.
- `hawk_reproduction_plan` creates the expiring plan.
- `hawk_reproduction_execute` requires `approved: true`, the exact `plan_id`,
  and its 64-character `plan_hash`.
- `hawk_reproductions_list` returns persisted attempts.

## Verification boundary

Even when every sandbox gate passes, Hawk sets `promotedToVerified: false`.
Independent reproduction, valid test identity, demonstrated impact, declared
authorization scope, and reviewed evidence remain missing. Use Hawk's governed
authorized-validation and `hawk_evidence_verify` workflows for those separate
proof obligations.
