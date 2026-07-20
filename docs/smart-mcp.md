# Hawk Smart MCP Brain

Hawk Smart MCP turns the local MCP server from a flat bag of tools into a
governed security-agent control plane. It is local-first, evidence-driven, and
safe by default.

```text
Objective
  -> GoalSpec and explicit scope
  -> policy and budgets
  -> immutable agent DAG and model routes
  -> exact-plan approval when required
  -> intelligent distributed Docker scheduling
  -> durable Security Graph artifacts
  -> independent verification
  -> patch and regression decision
```

## Goal and policy contract

`hawk_plan_create` compiles natural language into a typed GoalSpec:

- authorized repositories, hosts, routes, and identities;
- allowed and forbidden actions;
- parallelism, time, token, cost, and request-rate budgets;
- local-only or hosted-model data policy;
- preferred provider models by role or model class;
- approval mode, retention, and success criteria.

An approval cannot repair missing authority. If a plan needs an action absent
from `allowed_actions`, policy denies it. High-risk active security testing
always requires approval even if an input attempts to disable risk approvals.
`hawk_plan_approve` binds the operator, expiry, goal, plan id, and exact
SHA-256 plan hash. The plan also embeds the full GoalSpec hash, and policy is
recomputed before execution. Any plan, scope, authority, or budget change
invalidates that approval.

Mission Control can persist the same compatible goal/plan/policy records
through review, remediation, and authorized-validation profiles. This desktop
action writes a readable DAG under `.hawk/plans/`; it deliberately does not
approve the hash or start a run.

## Semantic capability and model routing

`hawk_capabilities_search` ranks a small relevant subset of the capability
registry by id, title, description, evidence type, reliability, and
determinism. The current registry covers context, route mapping, static audit,
traffic correlation, supply-chain posture, ProofGraph, independent evidence
verification, authorized runtime validation, patch candidates, and
regression/security retesting.

Every plan node records:

- specialized agent role;
- deterministic, local-small, local-code, hosted-code, or hosted-reasoning
  model class;
- provider model override when declared;
- local-only or hosted data policy;
- independent verifier model class where required;
- dependencies, parallel group, timeout, retry, risk, and expected evidence.

Deterministic analysis wins over an LLM whenever it can do the job. Hosted
models are selected only when the GoalSpec explicitly allows hosted data.

## Durable runs and distributed scheduling

`hawk_run_start` creates an idempotent local run under `.hawk/brain/`. The
engine supports:

- dependency-aware parallel scheduling;
- atomic snapshots and append-only JSONL events;
- SHA-256 event hash chains;
- process leases and heartbeats;
- bounded retries and timeouts;
- pause, resume, cancel, and abort propagation;
- restart recovery for incomplete passive nodes;
- structured, redacted artifacts addressed by `hawk://` URIs.

Docker task graphs add capability-aware agent instances. Ready nodes are
ranked by priority and remaining critical path. Placement then scores hard
capability/CPU/RAM fit, preferred capability affinity, active load, failure
rate, and observed duration under `balanced`, `latency`, or `throughput`
strategy. Each assignment receives a renewable lease; retryable work may move
to another healthy compatible instance. `hawk_scheduler_status` exposes this
state without mutating it.

`hawk_run_execute_task` exposes the same engine through the experimental MCP
Tasks protocol. MCP task state is also durable instead of using the SDK's
demonstration-only in-memory store.

Docker runs additionally persist their validated spec. After MCP restart Hawk
reattaches to a retained worker container, recovers its logs and exit code,
and resumes downstream nodes. A missing container is never silently rerun
unless an explicit retry remains.

Before launch, a local image tag is resolved to its immutable Docker image ID.
Workers run non-root with read-only source/root filesystems, quota-limited
artifact tmpfs, and cross-run CPU/RAM/worker ceilings. Startup removes orphaned
Hawk containers only when their workspace label matches this workspace.

## Security Graph and verification

`hawk://workspace/graph` and the native `/v1/security/graph` endpoint link
repositories, files, symbols, routes,
identities, requests, responses, findings, evidence, patches, tests, runs,
agents, tools, and models.

The native builder records provenance and confidence for every deterministic
relationship. It correlates redacted HTTP observations to route patterns,
links routes and findings only through explicit route/source context, attaches
sanitized evidence snippets and exported evidence packs, and records agent
patch/test lineage. Context links never auto-promote a signal to a verified
finding.

`hawk_evidence_verify` applies nine mandatory gates:

1. baseline or control observation;
2. successful reproduction;
3. independent reproduction;
4. valid test identity;
5. demonstrated impact;
6. declared scope;
7. no unsafe side effects;
8. redacted secrets;
9. at least one evidence URI.

Finding lifecycle is `signal -> hypothesis -> reproduced -> verified -> fixed
-> retested`. A failed gate keeps the finding below verified.

## Governed memory and MCP Sentinel

`hawk_memory` supports run, project, and organization layers. Project and
organization entries require verified evidence, a source URI, evidence URIs,
confidence, reviewer, expiry, and a content hash. Secret-like values and
prompt-injection patterns are rejected before persistence. The `verified`
flag alone is not trusted: long-term writes must reference evidence already
present in a successful Hawk verification record.

`hawk_mcp_security_audit`:

- computes a canonical server-manifest fingerprint;
- scans tool text for instruction override and secret-exfiltration patterns;
- compares the current manifest with its trusted fingerprint;
- reports post-trust changes as possible rug pulls;
- redacts or blocks Smart capability results and imported A2A envelopes before
  they enter Hawk agent context.

The Sentinel is a defense layer, not a claim that arbitrary third-party MCP
servers are safe. Tool calls still need least privilege and operator review.

## MCP surface

The Smart MCP layer provides structured output schemas and risk annotations
for:

- `hawk_capabilities_search`
- `hawk_context_snapshot`
- `hawk_plan_create`
- `hawk_plan_approve`
- `hawk_run_start`
- `hawk_run_observe`
- `hawk_run_control`
- `hawk_run_execute_task`
- `hawk_evidence_verify`
- `hawk_memory`
- `hawk_mcp_security_audit`
- `hawk_patch_tournament`
- `hawk_eval_lab`
- `hawk_a2a_bridge`
- `hawk_mission_control`

Resources:

- `hawk://workspace/graph`
- `hawk://run/{runId}/events`
- `hawk://run/{runId}/artifact/{nodeId}`
- `hawk://finding/{findingId}/proof`
- `hawk://policy/{planId}`
- `hawk://interop/a2a-profile`
- `ui://hawk/mission-control.html`

Prompts cover secure PR review, scoped IDOR/BOLA matrices, finding
verification, and fix/retest tournaments.

The MCP App uses the stable `ui://` plus
`text/html;profile=mcp-app` contract, has a deny-all external CSP, and uses
only sandboxed host-mediated JSON-RPC. It displays run progress and the live
event chain and can refresh, pause, resume, cancel, and request fullscreen.

## Patch tournament, A2A, and Eval Lab

`hawk_patch_tournament` creates parallel isolated candidate lanes, required
tests and evidence, independent judging, disqualification rules, and a final
human Apply/Reject decision. It intentionally does not edit the workspace.
Native diff Apply/Reject/Revert remains an editor workflow.

`hawk_a2a_bridge` imports text-only A2A-compatible task envelopes into passive
Hawk plans and exports Hawk runs as task status plus artifact URIs. It is a
local MCP bridge, not a public network A2A endpoint.

`hawk_eval_lab` records Hawk and baseline outcomes and compares only runs with
the same scenario, model, token budget, and cost budget. Metrics include task
success, false-positive rate, verified findings, over-scope actions,
regressions, cost per verified finding, and time per verified finding.

## Design sources

The implementation follows current primary references:

- [MCP tools and structured output](https://modelcontextprotocol.io/specification/draft/server/tools)
- [MCP resources](https://modelcontextprotocol.io/specification/draft/server/resources)
- [MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
- [MCP security guidance](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/)
- [A2A protocol](https://github.com/a2aproject/A2A)
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Temporal AI reference architecture](https://go.temporal.io/platform-hub/ai-engineering/ai-reference-architecture)
- [Semgrep security workflows](https://semgrep.dev/docs/workflows/overview)
- [XBOW platform](https://xbow.com/platform)

## Deliberate limits

- The local stdio MCP server remains a single-workspace, single-operator
  security boundary. Hawk has no account, RBAC, billing, licensing, preference
  sync, or remotely reachable multi-tenant service.
- Docker bridge networking is not a host allowlist. Hawk requires exact scope,
  active-test authority, plan approval, and an extra bridge acknowledgement;
  a restricted egress proxy is still required for production active testing.
- The MCP App controls Hawk runs, not arbitrary host processes.
- Sentinel audits do not transparently intercept arbitrary calls made by other
  MCP clients or third-party servers.
- Static detections remain signals. Only the verifier can promote lifecycle
  state.
- Personal Windows signing is optional. Release credentials, when used, must
  never be committed.
