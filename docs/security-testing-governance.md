# Hawk security testing, agent mesh, and governance

Hawk now exposes one bounded control plane for security tests, Docker agents, MCP tools, evidence, and governance. The design is deliberately approval-first: a plan is reviewable and hash-bound before any run is accepted.

## Security-test catalog

The local daemon exposes `GET /v1/security-tests/templates` and `GET /v1/security-tests/plan?templateId=...`. The MCP server exposes the same workflow through `hawk_security_test_templates`, `hawk_security_test_plan`, and `hawk_security_test_run`.

| Template | What it checks | Boundary |
| --- | --- | --- |
| `static-code` | Hawk source rules for dangerous sinks and credential-like assignments | Offline source text; never starts the project |
| `route-coverage` | Correlates statically mapped routes with existing Browser/Burp metadata | Captured-only; never replays or generates requests |
| `dependency-manifest` | Reads manifests, lockfiles, and install-script posture | Offline; never installs or contacts a registry |
| `sandbox-signal` | Creates an approval/evidence hand-off for an isolated reproduction | Plan only; execution remains in the offline reproduction gates |

Every plan contains a deterministic `approvalHash`, `policyHash`, scope hosts, rate limits, checks, and a plain-language safety statement. If the workspace policy changes, the old plan is rejected and must be recreated.

## Governance as code

Hawk reads `.hawk/governance.json` when present. If it is absent, a safe default is used:

- all security-test templates require operator approval;
- only offline and captured-only network policies are allowed;
- host scope is capped at 32 entries;
- captured metadata is capped at 10 requests/second and 1,500 records;
- evidence is required before a signal can be promoted;
- malformed or unsupported policy files fail closed.

Inspect the effective policy with `GET /v1/governance/policy` or the `hawk_governance_policy` MCP tool. The response includes a SHA-256 policy hash for audit and plan binding.

## Docker agent profiles

`GET /v1/docker/agent-profiles`, `hawk_docker_agent_profiles`, and the optional `agent_profile` field on `hawk_parallel_start` provide safe presets:

- `balanced`: four 1 CPU / 768 MB no-network workers;
- `security-sandbox`: three 1 CPU / 1,024 MB offline security workers;
- `throughput`: eight 0.75 CPU / 512 MB deterministic workers.

Explicit `agent_instances` override a preset. All profiles still use the existing read-only workspace bind, per-task artifact directory, dropped capabilities, CPU/RAM/PID/time ceilings, lease recovery, and operator approval for the run.

## MCP registry

`GET /v1/mcp/registry` and `hawk_mcp_registry` publish risk, approval, mutation, and network metadata for sensitive Hawk tools. This registry is descriptive and is intentionally separate from execution: the existing Smart MCP policy engine remains the final authority.

## Evidence provenance

Evidence packs now include a versioned hash chain in `manifest.json`. Each generated artifact records its content SHA-256, the previous chain entry, and its own entry digest. The pack returns `chainRootSha256`, while the manifest itself is listed as a final artifact. This makes tampering or reordering visible without storing raw credentials, cookies, bodies, or secret-shaped values.

These features remain local-first and do not turn Hawk into an autonomous target scanner. Use active validation only for targets and projects where you have explicit authorization.
