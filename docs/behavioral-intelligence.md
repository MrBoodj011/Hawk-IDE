# Hawk Behavioral Intelligence

Behavioral Intelligence turns static routes and sanitized runtime observations
into a reviewable model of how the application is expected to behave. It is a
local-first analysis layer, not an autonomous attack engine.

## What it builds

The engine exposes 12 explicit capabilities:

1. Behavioral State Machine Explorer
2. Invariant Engine
3. Controlled Race Lab
4. Deterministic Browser Replay
5. Governed Agent Hooks
6. Specialist Agent Swarm
7. Evidence-gated PR Review
8. Accessibility Chaos
9. Client State Corruption Lab
10. Fix Mutation Testing
11. Failure Timeline
12. Project Digital Twin

The report contains:

- page and API states plus observed transitions;
- workflows derived from static routes and trusted structural interactions;
- side-effect, outcome, integrity, authorization, workflow, and domain
  invariants;
- repeat, skip, reorder, multi-tab, logout-reuse, concurrency, offline,
  stale-cache, expired-session, storage-corruption, service-worker drift, and
  keyboard experiments;
- replay bundles that reference sanitized interactions and request IDs;
- isolated fix-mutation plans that specify the regression test expected to
  fail;
- one ordered interaction/request/failure/signal timeline;
- actors, assets, trust boundaries, workflow IDs, invariant IDs, and a stable
  learning fingerprint.

## Safety and authority

`captured-only` and `offline` capabilities generate no target traffic.
`approval-gated` experiments are plans only. An authorized-active plan requires:

- a concrete objective;
- exact allowed hosts;
- bounded concurrency;
- a bounded request budget;
- a 15-minute expiry;
- an approval hash over the complete plan.

Creating the plan does not approve or execute it. Actual active execution must
go through Hawk's separate scope, policy, and worker approval boundary.

## Mission Control

The **Behavioral Intelligence** card shows states, workflows, invariants,
experiments, replay bundles, signals, active invariant signals, and all 12
capabilities.

- **Analyze model** refreshes captured-and-static analysis.
- **Plan experiment** creates either a zero-request passive plan or a restricted
  authorized-active plan and copies the exact JSON to the clipboard.
- **Plan specialist swarm** creates a dependency graph for eight scoped roles
  and copies it without starting workers.

## Daemon API

| Method | Endpoint | Result |
| --- | --- | --- |
| `GET` | `/v1/security/behavioral-lab` | Complete Behavioral Intelligence report. |
| `POST` | `/v1/security/behavioral/experiment-plan` | Exact-hash experiment plan. |
| `POST` | `/v1/security/hooks/evaluate` | Deterministic lifecycle/tool policy decision. |
| `POST` | `/v1/security/specialist-swarm/plan` | Eight-role dependency plan. |
| `POST` | `/v1/security/pr/evidence-review` | Diff analysis plus mandatory evidence gates. |

## Smart MCP

- `hawk_behavioral_lab_analyze`
- `hawk_agent_hook_evaluate`
- `hawk_specialist_swarm_plan`

All three tools are low-risk planning or analysis surfaces. They receive
explicit bounded data, return typed JSON text, and do not start workers or send
network traffic.

## Evidence and Security Graph

Behavioral signals flow into Markdown, HTML, JSON, and SARIF evidence packs.
The Security Graph adds behavioral state and invariant nodes, transition edges,
digital-twin trust boundaries, and finding nodes whose provenance is
`hawk-behavioral-intelligence`.

The product statement remains strict: a behavioral signal is not a confirmed
vulnerability. It requires approved reproduction, impact validation, tests,
semantic review, independent review, and evidence provenance before a fix can
pass the PR security gate.
