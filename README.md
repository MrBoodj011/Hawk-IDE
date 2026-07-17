# Hawk Security IDE

Hawk is a security-native AI development environment for evidence-driven code
review, authorized testing, supply-chain intelligence, and verified fixes.

Its product loop is:

```text
Understand code -> observe runtime traffic -> prove a finding -> fix it -> retest it
```

The project builds on the original PentesterFlow Agent runtime and adds a
local-first Code-OSS-compatible Hawk security workspace.

## What works now

- Hawk Mission Control: a full editor surface with a responsive activity-bar
  view, security telemetry, a living route graph, traffic correlation,
  findings triage, organization posture, evidence actions, and MCP status.
- Hawk AI investigation room with active-file, selection, open-tab, git-diff,
  and diagnostics context; session task history; plan-first safety guidance;
  and a direct change-review handoff to the native source-control diff.
- A local daemon that binds only to loopback and requires a random,
  process-scoped token held by the extension host. The desktop extension ships
  this daemon bundle, so the portable IDE does not require a separate daemon
  binary on `PATH`.
- Passive route indexing for Express, Fastify, and common Next.js API layouts.
- Passive code audit signals for embedded credentials, disabled TLS checking,
  `eval`, interpolated SQL-looking calls, and risky CORS combinations.
  Signals are explicitly not confirmed vulnerabilities: they require manual
  validation.
- HAR import that stays on-device and redacts sensitive query values. Imported
  paths are correlated with indexed source routes and marked live in Mission
  Control. Hawk never replays imported requests or stores request/response
  bodies.
- Hawk `health.json` import and optional GitHub raw/Contents API sync that
  correlate local SBOM, governance, dependency maintenance, and security-SLA
  signals. Optional GitHub tokens remain in VS Code SecretStorage.
- `hawk-ide-mcp`, an MCP server exposing passive route inventory, redacted
  static-audit results, and a sanitized Hawk health summary to an assistant.
- Approval-aware Docker orchestration in `hawk-ide-mcp`: background task
  graphs, up to 32 bounded parallel workers, dependency scheduling, retries,
  timeouts, cancellation, capped logs, per-task artifacts, and optional
  explicitly approved network/credential access.
- Existing PentesterFlow CLI, permissions, sessions, browser/Burp bridge, and
  evidence-backed findings workflow.

## Use the Code-OSS extension

Build the project and extension:

```sh
npm install
npm run build
npm run check:extension
npm run build:extension
```

Open the repository's `extensions/pentesterflow-ide` folder in the Code-OSS
extension development host, then open the Hawk activity-bar icon. Use
`Ctrl+Shift+H` (`Cmd+Shift+H` on macOS) for the full Mission Control surface.
It can index local routes, run its passive audit, import a HAR file, run an
approved passive workspace scan, sync a health report, and compose a
workspace-aware AI task for the existing `hawk` agent.

For a branded Code-OSS source tree with the extension built in, follow
[desktop/BUILD.md](desktop/BUILD.md). The preparation script copies a local
Code-OSS checkout into a separate directory, applies only the documented
product identity, and keeps the upstream checkout unchanged.

The extension's **Copy MCP config** button places this local-only server
configuration on the clipboard:

```json
{
  "mcpServers": {
    "hawk": {
      "command": "hawk-ide-mcp",
      "args": ["--workspace", "${workspaceFolder}"]
    }
  }
}
```

## Run the IDE daemon

```sh
npm install
npm run dev:ide-daemon -- --workspace /path/to/project
```

The command prints one JSON line with a local URL and a process-scoped token.
Use that token in `X-Hawk-Token` for every request.

```sh
curl -H "X-Hawk-Token: <token>" http://127.0.0.1:<port>/v1/health
curl -X POST -H "X-Hawk-Token: <token>" http://127.0.0.1:<port>/v1/workspace/index
```

See [architecture documentation](docs/architecture.md) for the current
security boundary and longer-term security graph.

See [parallel Docker orchestration](docs/parallel-orchestration.md) for worker
isolation, the MCP tools, image setup, and long-running task examples.

## Hawk health report liaison

The separate [Cybrense Hawk](https://github.com/Cybrense-IT-Services/Hawk)
GitHub App publishes `health.json`. Use **Import Hawk health** to load a local
file, or **Configure sync** to connect a `raw.githubusercontent.com` or
GitHub Contents API URL. A private-report token, when needed, is held only in
VS Code SecretStorage; it is never sent to the dashboard webview or daemon.
Hawk IDE persists only a sanitized summary in `.hawk/health.json`; it never
accepts a GitHub App private key, installation token, raw alert payload,
source code, or pull-request body. This is a file-contract integration only:
no GPL-3.0 Hawk code is included here.

## Approved passive workspace scan

**Run approved workspace scan** displays its exact plan and requires a modal
approval. Its scope is deliberately limited to local source text, the local
route index, and already-imported metadata. It never starts project code,
contacts a target, replays HAR traffic, or attempts exploitation. The result
is written to `.hawk/reports/` and every signal still needs manual validation.

## Roadmap

1. Native captured-response streaming in the AI panel with structured tool
   events and approval cards.
2. Staged patch generation with Apply, Reject, and one-click Revert snapshots.
3. Burp live-traffic streaming and richer request-to-data-flow correlation.
4. Explicit scope/identity management for authorized IDOR/BOLA validation.
5. Runtime digital twin, regression-test orchestration, and collaborative
   evidence workspaces.

## License and attribution

This project includes and builds on [PentesterFlow Agent](https://github.com/PentesterFlow/agent)
under Apache-2.0. See [NOTICE](NOTICE) and [LICENSE](LICENSE).
