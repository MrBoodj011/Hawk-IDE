# Hawk Security IDE

Hawk is a security-native AI development environment for evidence-driven code
review, authorized testing, supply-chain intelligence, and verified fixes.

Its product loop is:

```text
Understand code -> observe runtime traffic -> prove a finding -> fix it -> retest it
```

Hawk combines its local agent runtime with a branded, Code-OSS-compatible
security workspace. Product surfaces, commands, storage, installers, companion
extensions, protocols, and release assets use the Hawk identity.

## What works now

- Hawk Mission Control: a full editor surface with a responsive activity-bar
  view, local security signals, a living Security Graph, traffic correlation,
  findings triage, organization posture, evidence actions, and MCP status.
- Native Hawk AI engineering room with active-file, selection, open-tab,
  git-diff, diagnostics, and semantic-index context; durable session history; in-panel model,
  plan, tool, and response streaming; and isolated coding turns powered by the
  existing multi-provider Hawk agent runtime.
- Hawk Coding Core: private inline completion, bounded local symbol-aware
  workspace indexing, natural-language code search, isolated task terminals,
  named patch checkpoints, three-lane parallel coding tournaments, explicit
  BYOK model fallbacks, and built-in latency/RAM benchmarks. The index is now
  persistent and incremental, extracts TypeScript/JavaScript compiler-AST
  declarations and language-aware Python, Java, Kotlin, C#, Go, and Rust
  symbols, parameter/return types, imports, and calls, and can add loopback-only
  Ollama embeddings. Representative structural chunks prevent one generated
  file from consuming the complete bounded index.
- Hawk Next Edit predicts an exact, bounded multiline replacement from recent
  edits, diagnostics, surrounding code, and repository context. The editor
  discards the result unless the model's old text exactly matches the current
  document suffix and its confidence clears the configured threshold. Exact
  requests, concurrent requests, and partially typed insertions reuse a
  bounded in-memory cache. A privacy-safe persistent scorecard compares
  configured models by structured-edit validity, operator acceptance,
  cache reuse, and p50/p95 generation latency without retaining code.
- Hawk Debug Agent reads native Debug Adapter Protocol threads, stack frames,
  scopes, variables, breakpoints, and diagnostics, redacts secret-shaped
  values, and runs a bounded automatic diagnose/edit/approved-test/fix loop.
  Failed gate output and the latest redacted debugger evidence return to the
  same durable agent session; cancellation preserves the isolated patch and
  Apply always remains manual.
- Long native AI tasks support Pause/Resume, restart recovery, optional
  background auto-resume, and AST semantic merge. Hawk scores parallel
  candidates, then deterministically transplants compatible files,
  TypeScript/JavaScript AST symbols, and indentation-bounded Python declarations
  into a clean worktree before the model resolves explicit same-symbol conflicts.
- Hawk Local AI setup: the Windows installer can add the official Ollama
  runtime, while the native first-run wizard verifies the release digest and
  Windows signer, recommends a coding model from available RAM, downloads it
  only after approval, configures the loopback provider, and restarts Hawk.
- Exact patch review with a visual diff, SHA-256-bound Apply, Reject, approved
  typecheck/lint/test/build gates, workspace-drift detection, and Revert that
  refuses to overwrite any file changed after apply.
- A local daemon that binds only to loopback and requires a random,
  process-scoped token held by the extension host. The desktop extension ships
  this daemon bundle, so the portable IDE does not require a separate daemon
  binary on `PATH`.
- Passive route indexing for Express, Fastify, and common Next.js API layouts.
- Passive code audit signals for embedded credentials, disabled TLS checking,
  `eval`, interpolated SQL-looking calls, and risky CORS combinations.
  Signals are explicitly not confirmed vulnerabilities: they require manual
  validation.
- Automatic offline sandbox reproduction for those supported deterministic
  signals. Hawk creates an expiring, exact-hash plan, then runs baseline,
  negative-control, and reproduction gates in a read-only, zero-network,
  capability-dropped Docker worker with bounded CPU, RAM, time, logs, and
  artifacts. Results enter the Security Graph and reproduction history but
  remain unverified until the independent identity, impact, scope, evidence,
  and review gates pass.
- HAR import that stays on-device, redacts sensitive query values, never
  replays requests, and never retains request or response bodies. Imported
  traffic can be combined with a live, redacted Browser/Burp timeline.
- Governed multi-identity replay for an explicitly approved captured request:
  exact host-and-port binding, 2–8 named credential sets, a 0.1–5 request/sec
  ceiling, no redirects, bounded response fingerprints, and memory-only
  credentials/bodies. Response differences are evidence leads, never automatic
  authorization findings.
- Installable Browser and Burp companions with explicit pairing, URL scope,
  request-rate limits, bounded queues, sensitive-header redaction, and capture
  disabled by default. Mission Control polls the local evidence plane and
  correlates observed requests to mapped source routes. The live companions
  retain sensitive request bodies only when an operator separately enables
  that option.
- Hawk `health.json` import and optional GitHub raw/Contents API sync that
  correlate local SBOM, governance, dependency maintenance, and security-SLA
  signals. Optional GitHub tokens remain in Hawk encrypted local secret storage.
- Hawk Smart MCP Brain: typed goals and scope, semantic capability search,
  goal-bound DAG plans, exact-hash approvals, execution-time policy rechecks,
  local/hosted model routing,
  durable runs, worker leases, pause/resume/cancel, crash recovery,
  tamper-evident event chains, governed memory, and structured artifacts.
- Native Security Graph and independent evidence verification. Repository
  files, handler symbols, routes, imported/live requests, signals, evidence
  packs, agent patches, and tests share one durable graph. Links record their
  provenance and confidence, and request-to-finding edges remain explicitly
  contextual instead of being promoted to vulnerability verdicts;
  a signal cannot become verified until every baseline, reproduction,
  identity, impact, scope, side-effect, redaction, and evidence gate passes.
- MCP Security Sentinel fingerprints server manifests and detects tool
  poisoning, prompt injection, secret-like results, allowlist violations, and
  post-trust "rug pull" changes. Hawk Smart capability results and imported
  A2A envelopes pass this guard before entering agent context.
- A sandboxed, zero-egress Hawk Mission Control MCP App plus MCP resources,
  prompts, structured tool output, risk annotations, live log/resource
  notifications, and a durable native MCP Tasks implementation.
- A local A2A-compatible task-envelope bridge and Eval Lab for same-model,
  same-token-budget, same-cost-budget comparisons against a plain-agent
  baseline.
- Approval-aware distributed Docker orchestration in `hawk-ide-mcp`: background
  task graphs, up to 32 bounded agent instances, capability/resource matching,
  priority and critical-path scheduling, balanced/latency/throughput strategies,
  health/load scoring, expiring leases, retry reassignment,
  timeouts, cancellation, capped logs, per-task artifacts, restart history,
  live-container reattachment, immutable local image identities, non-root
  workers, global CPU/RAM governance, artifact disk quotas, workspace-scoped
  orphan cleanup, and optional explicitly approved network/credential access.
- Governed mission planning directly in Mission Control. Review, remediation,
  and authorized-validation profiles compile Smart MCP-compatible goals,
  policy decisions, model-routed DAGs, budgets, and exact plan hashes without
  approving or executing them.
- Three approval-gated scan templates for passive workspace review, captured
  runtime observation, and offline release gates. Each plan declares its
  network policy, request ceiling, checks, and deterministic approval hash.
- A sanitized evidence builder that exports Markdown, portable HTML, JSON,
  SARIF, and a SHA-256 manifest under `.hawk/reports/`.
- Existing Hawk CLI, permissions, sessions, browser/Burp bridge, and
  evidence-backed findings workflow.
- A personal desktop release pipeline for Windows portable ZIP/EXE/MSI and
  Linux deb/AppImage/tar, plus locally installed Browser and Burp companions.
  Releases include SHA-256 checksums; publication now requires a trusted RSA
  Authenticode certificate and verifies timestamp and Windows trust. The desktop
  can check the private GitHub release feed and launch an installer only after
  exact-size, trusted-host, `SHA256SUMS`, and Windows Authenticode verification
  plus explicit approval. A post-release Windows job retests that real feed.
- A measured semantic-index performance contract: AST/type-aware indexing,
  incremental persistence, and search stay below 500 MiB peak process RSS or
  fail the local/CI benchmark gate. Large files, embeddings, resident chunks,
  and persisted data all have explicit memory ceilings.
- A deliberately solo/local architecture: no Hawk account, team system,
  Stripe/billing, licenses, cloud synchronization, telemetry collector, Apple
  build, or hosted Hawk backend. Store listing/submission packs exist, but
  publication still requires the owner's Chrome and PortSwigger accounts.
  Provider keys and engagement data remain on the operator's machine.
- CodeQL-ready static assurance and production dependency auditing without a
  hosted Hawk service.

## Use the Code-OSS extension

Build the project and extension:

```sh
npm install
npm run build
npm run check:extension
npm run build:extension
```

Open the repository's `extensions/hawk-security-ide` folder in the Code-OSS
extension development host, then open the Hawk activity-bar icon. Use
`Ctrl+Shift+H` for the full Mission Control surface.
It can index local routes, run its passive audit, import a HAR file, run an
approved passive workspace scan, sync a health report, and compose a
workspace-aware native AI task without opening a separate agent terminal.
Run **Hawk: Pair Browser / Burp Capture** to copy the short-lived loopback URL
and token used by either capture companion.
Use **Hawk: Plan Governed Smart MCP Mission** to inspect a security DAG before
approval, and **Hawk: Build Sanitized Evidence Pack** for portable reports.
Use **Hawk: Search Workspace Semantically**, **Hawk: Run Coding Core
Benchmark**, **Hawk: Diagnose and Fix Stopped Debugger**, and **Hawk: Check for
Private Release Updates** for the coding layer. `Alt+\` explicitly requests a
Hawk Tab / Next Edit prediction.
Hawk does not require a Hawk login. Optional GitHub health-report tokens remain
in Hawk encrypted local secret storage; LLM keys can be read from local environment
variables and are not synchronized anywhere.

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

See [automatic sandbox reproduction](docs/sandbox-reproduction.md) for the
approval contract, isolation boundary, supported rules, UI and MCP workflow,
and proof limitations.

See [Smart MCP Brain](docs/smart-mcp.md) for the goal, policy, planner,
orchestration, ProofGraph, memory, Sentinel, MCP App, A2A bridge, and Eval Lab
contracts.

See [native Hawk AI sessions](docs/native-ai.md) for the worktree, streaming,
test-gate, Apply/Reject/Revert, persistence, and security contracts.

See the [local threat model](docs/security/THREAT_MODEL.md),
[Security Policy](SECURITY.md), and
[Responsible Use Policy](RESPONSIBLE_USE.md).

## Hawk health report liaison

The separate [Cybrense Hawk](https://github.com/Cybrense-IT-Services/Hawk)
GitHub App publishes `health.json`. Use **Import Hawk health** to load a local
file, or **Configure sync** to connect a `raw.githubusercontent.com` or
GitHub Contents API URL. A private-report token, when needed, is held only in
Hawk encrypted local secret storage; it is never sent to the dashboard webview or daemon.
Hawk IDE persists only a sanitized summary in `.hawk/health.json`; it never
accepts a GitHub App private key, installation token, raw alert payload,
source code, or pull-request body. This is a file-contract integration only:
no GPL-3.0 Hawk code is included here.

## Governed scans and evidence

**Run governed scan** first asks for a passive-workspace, runtime-observe, or
release-gate template. Hawk displays the exact network policy, request ceiling,
checks, and plan hash before a modal approval. These templates never start
project code, contact a target, replay traffic, or attempt exploitation. The
evidence builder uses the same local boundary and writes Markdown, HTML, JSON,
SARIF, and SHA-256 metadata under `.hawk/reports/`. Every static signal still
needs manual validation.

## Remaining roadmap

1. Deeper source-to-data-flow correlation beyond framework route declarations.
2. More offline evaluation fixtures and optional cross-machine worker pools.
   Smart MCP, the A2A bridge, and persistence remain intentionally
   single-operator and local-first.

## License and attribution

Hawk is distributed under Apache-2.0. Required third-party attributions are
kept in [NOTICE](NOTICE) and the complete terms are in [LICENSE](LICENSE).
