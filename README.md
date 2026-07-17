# PentesterFlow IDE

PentesterFlow IDE is a security-native AI development environment for
evidence-driven code review, authorized pentesting, and verified fixes.

Its product loop is:

```text
Understand code -> observe runtime traffic -> prove a finding -> fix it -> retest it
```

The project starts from the PentesterFlow Agent runtime and adds a local-first
Code-OSS-compatible security workspace.

## What works now

- Code-OSS / VS Code activity-bar dashboard for routes, local audit signals,
  HAR traffic, findings retest, MCP setup, and an integrated AI-agent terminal.
- A local daemon that binds only to loopback and requires a random,
  process-scoped token held by the extension host.
- Passive route indexing for Express, Fastify, and common Next.js API layouts.
- Passive code audit signals for embedded credentials, disabled TLS checking,
  `eval`, interpolated SQL-looking calls, and risky CORS combinations.
  Signals are explicitly not confirmed vulnerabilities: they require manual
  validation.
- HAR import that stays on-device and redacts sensitive query values. It never
  replays imported requests or stores request/response bodies.
- `pentesterflow-ide-mcp`, a read-only MCP server exposing route inventory and
  redacted static-audit results to an MCP-capable assistant.
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
extension development host, then open the PentesterFlow activity-bar icon.
The dashboard can index local routes, run its passive audit, import a HAR file,
and launch the existing `pentesterflow` AI agent in the integrated terminal.

For a branded Code-OSS source tree with the extension built in, follow
[desktop/BUILD.md](desktop/BUILD.md). The preparation script copies a local
Code-OSS checkout into a separate directory, applies only the documented
product identity, and keeps the upstream checkout unchanged.

The extension's **Copy MCP config** button places this local-only server
configuration on the clipboard:

```json
{
  "mcpServers": {
    "pentesterflow-ide": {
      "command": "pentesterflow-ide-mcp",
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
Use that token in `X-Pentesterflow-Token` for every request.

```sh
curl -H "X-Pentesterflow-Token: <token>" http://127.0.0.1:<port>/v1/health
curl -X POST -H "X-Pentesterflow-Token: <token>" http://127.0.0.1:<port>/v1/workspace/index
```

See [architecture documentation](docs/architecture.md) for the current
security boundary and longer-term security graph.

## Roadmap

1. Source-to-request correlation and Burp live-traffic import.
2. Explicit scope/identity management for authorized IDOR/BOLA validation.
3. Patch generation, regression-test orchestration, and replay after fixes.
4. Runtime digital twin, attack graph, and collaborative security workspace.
5. A branded standalone Code-OSS distribution instead of the extension-host
   development workflow used today.

## License and attribution

This project includes and builds on [PentesterFlow Agent](https://github.com/PentesterFlow/agent)
under Apache-2.0. See [NOTICE](NOTICE) and [LICENSE](LICENSE).
