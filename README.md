# PentesterFlow IDE

PentesterFlow IDE is a security-native AI development environment for
evidence-driven code review, authorized pentesting, and verified fixes.

Its product loop is:

```text
Understand code -> observe runtime traffic -> prove a finding -> fix it -> retest it
```

The project starts from the proven PentesterFlow Agent runtime and evolves it
into a local-first IDE backend plus a future Code-OSS desktop client.

## Current foundation

- Existing PentesterFlow CLI, tools, skills, permissions, sessions, and Burp bridge.
- A local IDE daemon that binds to loopback and requires a random token.
- Static route inventory for Express, Fastify, and common Next.js API layouts.
- Shared protocol contracts for the future desktop client.
- Tests for route discovery and daemon authentication.

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

See [architecture documentation](docs/architecture.md) for the intended
Code-OSS client, security graph, MCP boundary, and first vertical slice.

## Roadmap

1. Code-OSS client with an agent and findings sidebar.
2. Burp traffic import and source-to-request correlation.
3. IDOR/BOLA validation with multiple identities.
4. Patch, regression-test, and exploit-replay workflow.
5. Runtime digital twin, attack graph, and collaborative security workspace.

## License and attribution

This project includes and builds on [PentesterFlow Agent](https://github.com/PentesterFlow/agent)
under Apache-2.0. See [NOTICE](NOTICE) and [LICENSE](LICENSE).
