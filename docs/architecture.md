# PentesterFlow IDE architecture

PentesterFlow IDE is a security-native development environment that joins
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
5. Offer a read-only local MCP server for route and audit context.

## Runtime layout

```text
Code-OSS-compatible extension
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
process-scoped token; webview UI code never receives this token. HAR import
has a bounded body size and stores only a redacted request inventory, not
cookies, authorization headers, or request/response bodies.

## Security graph

The long-term graph connects `Route`, `Source symbol`, `Identity`, `Request`,
`Response`, `Finding`, `Evidence`, `Patch`, `Test`, and `Commit` records.
The graph lets the IDE navigate in both directions:

```text
HTTP request -> route -> source code -> patch -> regression test
```

## Extension and MCP boundary

The desktop client owns editor UX, diffs, panels, and user approvals. The
daemon owns route analysis, audit signals, redacted traffic, and local
persistence. The extension launches the existing terminal agent only in a
trusted workspace. MCP is read-only for the implemented IDE tools; editor
internals stay native for performance and least privilege. Remote testing and
active scanner actions remain subject to the existing agent permission and
authorization workflow.
