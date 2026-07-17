# Hawk Security IDE architecture

Hawk Security IDE is a security-native development environment that joins
source-code understanding, live traffic, evidence-backed findings, and verified
fixes in one local-first workflow.

## Implemented vertical slice

The current local-first slice provides:

1. Index routes from a workspace without executing project code.
2. Run passive static-audit rules and retest the same source location after a
   change. Audit signals are not vulnerability confirmations.
3. Expose inventory, audit results, and a redacted HAR traffic inventory from a
   token-gated loopback daemon.
4. Connect the Code-OSS-compatible dashboard without exposing the daemon token
   to the webview.
5. Import a separate Hawk GitHub App `health.json` into a sanitized local
   supply-chain summary: SBOM, governance, dependency, and security-SLA risk.
6. Offer an approved passive workspace scan with an explicit plan, modal
   confirmation, and a local Markdown report.
7. Offer a native Hawk AI task composer that sends approved workspace-context
   prompts to the local terminal agent.
8. Offer a Smart MCP server with structured passive context, governed plans,
   durable native tasks, ProofGraph evidence, verification, security
   inspection, and explicit controls for higher-risk isolated workers.

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
    +-- Durable DAG engine and worker leases
    +-- ProofGraph and evidence verifier
    +-- Governed memory and MCP Sentinel
    +-- MCP App, Tasks, resources, and prompts
```

The daemon binds only to a loopback host. Every endpoint requires a
process-scoped token; webview UI code never receives this token. Hawk report
import contains no GitHub credential and persists only a sanitized summary
under `.hawk/health.json`. Optional GitHub sync is restricted to GitHub raw
and Contents API URLs; its optional token is held in VS Code SecretStorage,
never in settings, the webview, or the daemon. HAR import
has a bounded body size and stores only a redacted request inventory, not
cookies, authorization headers, or request/response bodies.

## ProofGraph

The implemented local ProofGraph connects `Repository`, `Commit`, `File`,
`Symbol`, `Route`, `Identity`, `Request`, `Response`, `Finding`, `Evidence`,
`Patch`, `Test`, `Run`, `Agent`, `Tool`, and `Model` records.
The graph lets the IDE navigate in both directions:

```text
HTTP request -> route -> source code -> patch -> regression test
```

## Extension and MCP boundary

The desktop client owns editor UX, diffs, panels, and user approvals. The
daemon owns route analysis, audit signals, redacted traffic, and local
persistence. The extension launches the existing terminal agent only in a
trusted workspace. A passive workspace scan is local-text-only and requires
an explicit UI approval before it writes a report.

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
