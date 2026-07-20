# Hawk Security IDE architecture

Hawk Security IDE is a security-native development environment that joins
source-code understanding, live traffic, evidence-backed findings, and verified
fixes in one local-first workflow.

## Implemented vertical slice

The current local-first slice provides:

1. Index routes from a workspace without executing project code.
2. Run passive static-audit rules and retest the same source location after a
   change. Audit signals are not vulnerability confirmations.
3. Expose inventory, audit results, and a merged redacted HAR/Browser/Burp
   traffic inventory from a token-gated loopback daemon.
4. Connect the Code-OSS-compatible dashboard without exposing the daemon token
   to the webview.
5. Import a separate Hawk GitHub App `health.json` into a sanitized local
   supply-chain summary: SBOM, governance, dependency, and security-SLA risk.
6. Offer three approval-hash-bound scan templates plus sanitized Markdown,
   HTML, JSON, SARIF, and SHA-256 evidence packs.
7. Offer a native Hawk AI workbench with durable streaming sessions, isolated
   git worktrees, exact diff review, approved test gates, hash-bound Apply,
   Reject, and drift-safe Revert.
8. Offer a Smart MCP server with structured passive context, governed plans,
   durable native tasks, ProofGraph evidence, verification, security
   inspection, and explicit controls for higher-risk isolated workers.
9. Compile review, remediation, and authorized-validation missions from the
   desktop into persisted Smart MCP goals, DAGs, and policy decisions without
   silently approving or executing them.
10. Build one durable Security Graph that links source files and symbols to
    routes, redacted HTTP observations, findings, evidence packs, agent
    patches, and regression tests.
11. Distribute dependency-ready work across capability-aware Docker agent
    instances using critical-path, health, load, CPU/RAM, and lease signals.

## Runtime layout

```text
Code-OSS-compatible extension
    |
    | local authenticated API
    v
Hawk IDE daemon
    +-- Agent core
    +-- Security graph
    +-- Findings and evidence
    +-- Tool runtime and permissions
    +-- MCP gateway
    +-- Browser and Burp bridge

Hawk Smart MCP Brain
    +-- Intent and scope compiler
    +-- Policy and exact-plan approvals
    +-- Semantic capability registry
    +-- Model and agent router
    +-- Intelligent distributed scheduler and worker leases
    +-- ProofGraph and evidence verifier
    +-- Governed memory and MCP Sentinel
    +-- MCP App, Tasks, resources, and prompts
```

The daemon binds only to a loopback host. Every endpoint requires a
process-scoped token; webview UI code never receives this token. Hawk report
import contains no GitHub credential and persists only a sanitized summary
under `.hawk/health.json`. Optional GitHub sync is restricted to GitHub raw
and Contents API URLs; its optional token is held in Hawk encrypted local secret storage,
never in settings, the webview, or the daemon. HAR import has a bounded body
size and stores only a redacted request inventory, not cookies, authorization
headers, or request/response bodies. Live companions are disabled by default,
use a separate loopback pairing token, enforce explicit scope/rate limits, and
retain sensitive bodies only when the operator separately enables that option.

## Security Graph

The implemented local Security Graph is backed by ProofGraph and connects `Repository`, `Commit`, `File`,
`Symbol`, `Route`, `Identity`, `Request`, `Response`, `Finding`, `Evidence`,
`Patch`, `Test`, `Run`, `Agent`, `Tool`, and `Model` records.
The native daemon and Smart MCP build the same graph. Every edge can carry
confidence and provenance. A runtime request linked to a static signal is
labelled as context, not as proof of exploitability. The graph lets the IDE
navigate in both directions:

```text
HTTP request -> route -> source code -> patch -> regression test
```

## Extension and MCP boundary

The desktop client owns editor UX, diffs, panels, and user approvals. The
daemon owns route analysis, audit signals, redacted traffic, native AI
worktrees, and local persistence. The extension starts native Hawk workers only
for a trusted workspace. A passive workspace scan is local-text-only and
requires an explicit UI approval before it writes a report.

Smart MCP separates read-only context tools from local state changes and
higher-risk actions using tool annotations, typed action permissions, budgets,
host scope, plan hashes, and short-lived approvals. The default goal is
`local-only`, `read-workspace`, and network-denied. A high-risk plan never
inherits authority from a natural-language prompt: required actions must exist
in the GoalSpec, and active testing always requires exact-plan approval.
The plan hash includes the complete GoalSpec hash, and Hawk rechecks plan
integrity plus policy immediately before starting a run.

The embedded MCP App has no network or external resource CSP permissions. It
can observe and control Hawk runs only through the host-mediated MCP channel.
Remote testing and active scanner actions remain subject to the existing
agent permission and authorization workflow.
