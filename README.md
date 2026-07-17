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

- Hawk activity-bar control plane for routes, local audit signals, HAR traffic,
  approved passive workspace scans, Hawk health intelligence, findings retest,
  MCP setup, and a native AI task composer.
- A local daemon that binds only to loopback and requires a random,
  process-scoped token held by the extension host. The desktop extension ships
  this daemon bundle, so the portable IDE does not require a separate daemon
  binary on `PATH`.
- Passive route indexing for Express, Fastify, and common Next.js API layouts.
- Passive code audit signals for embedded credentials, disabled TLS checking,
  `eval`, interpolated SQL-looking calls, and risky CORS combinations.
  Signals are explicitly not confirmed vulnerabilities: they require manual
  validation.
- HAR import that stays on-device and redacts sensitive query values. It never
  replays imported requests or stores request/response bodies.
- Hawk `health.json` import and optional GitHub raw/Contents API sync that
  correlate local SBOM, governance, dependency maintenance, and security-SLA
  signals. Optional GitHub tokens remain in VS Code SecretStorage.
- `hawk-ide-mcp`, a read-only MCP server exposing route inventory, redacted
  static-audit results, and a sanitized Hawk health summary to an assistant.
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
extension development host, then open the Hawk activity-bar icon.
The dashboard can index local routes, run its passive audit, import a HAR file,
run an approved passive workspace scan, sync a health report, and compose an
AI task for the existing `hawk` agent in the integrated terminal.

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

1. Source-to-request correlation and Burp live-traffic import.
2. Explicit scope/identity management for authorized IDOR/BOLA validation.
3. Patch generation, regression-test orchestration, and replay after fixes.
4. Runtime digital twin, attack graph, and collaborative security workspace.
5. Full source-to-request correlation, approved patches, regression tests, and
   active validation inside explicitly authorized scopes.

## License and attribution

This project includes and builds on [PentesterFlow Agent](https://github.com/PentesterFlow/agent)
under Apache-2.0. See [NOTICE](NOTICE) and [LICENSE](LICENSE).
