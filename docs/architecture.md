# PentesterFlow IDE architecture

PentesterFlow IDE is a security-native development environment that joins
source-code understanding, live traffic, evidence-backed findings, and verified
fixes in one local-first workflow.

## First vertical slice

The first deliverable is deliberately narrow and complete:

1. Index routes from a workspace without executing project code.
2. Expose that inventory from a token-gated loopback daemon.
3. Connect a future Code-OSS client to the daemon.
4. Import captured traffic and associate it with routes.
5. Validate one IDOR/BOLA finding, propose a patch, and replay it after the fix.

## Runtime layout

```text
Code-OSS client
    |
    | local authenticated API
    v
PentesterFlow IDE daemon
    +-- Agent core
    +-- Security graph
    +-- Findings and evidence
    +-- Tool runtime and permissions
    +-- MCP gateway
    +-- Browser and Burp bridge
```

The daemon binds only to a loopback host. Every endpoint requires a
process-scoped token; desktop UI code must never make the daemon remotely
reachable.

## Security graph

The long-term graph connects `Route`, `Source symbol`, `Identity`, `Request`,
`Response`, `Finding`, `Evidence`, `Patch`, `Test`, and `Commit` records.
The graph lets the IDE navigate in both directions:

```text
HTTP request -> route -> source code -> patch -> regression test
```

## Extension boundary

The desktop client owns editor UX, diffs, panels, and user approvals. The
daemon owns agent execution, route analysis, tool calls, secrets, traffic,
evidence, and local persistence. MCP is reserved for external integrations;
editor internals stay native for performance and least privilege.
