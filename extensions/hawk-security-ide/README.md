# Hawk Security IDE extension

This is the Code-OSS-compatible client for the Hawk local agent. It adds a
full-width Mission Control and responsive activity-bar view with route
indexing, passive local audit, approved workspace scans, redacted HAR import,
source-to-request correlation, source navigation, signal retest, automatic
offline sandbox reproduction, governed scan templates, portable evidence
packs, Smart MCP mission planning, and MCP setup.
Its native Hawk AI room streams model output and tool
activity inside the editor, carries active-file, selection, open-tab, git-diff,
diagnostics, automatic redacted terminal output, and semantic-index context,
and keeps durable session history. Terminal capture uses VS Code shell
integration from command start, accepts only trusted-workspace working
directories, strips control sequences, redacts secret-shaped values, and keeps
only a bounded memory-only tail. The operator can inspect or clear the exact
captured context from the Command Palette.
Active governed project, organization, and run memory is automatically queried
per agent turn, filtered for the current branch, redacted, bounded, and injected
as read-only evidence into native, resumed, and Docker sessions.
Generic security reproduction is also available for findings without a static
rule adapter: provide direct-argv control and reproduction commands, and Hawk
executes them in the same read-only, dropped-capability, zero-network sandbox
with hash-bound expected exit codes and no-shell validation.
Hawk Tab adds inline completion, cached confidence-filtered multiline Next
Edit, and an approval-gated coordinated Multi-File Next Edit. The multi-file
flow selects related bounded documents, requires unique exact replacements,
previews every hunk, rejects SHA-256 drift, and applies all accepted files in
one atomic VS Code workspace edit. Hawk also provides a privacy-safe per-model
acceptance/latency scorecard and natural-language code search. Every agent edit
runs in an isolated git worktree. The exact diff can be checkpointed,
previewed, tested, applied, rejected, or safely reverted; an optional task
terminal streams inside that isolated worktree. Auto Verify runs detected safe
project gates, sends bounded failure evidence back to the isolated agent, and
retries a configurable number of repairs while keeping Apply manual.
Three-lane coding runs keep architecture, implementation, and verification
candidates separate and independently verified. It imports the
separate Hawk GitHub App's `health.json` as a sanitized local supply-chain
summary and can optionally sync a GitHub raw/Contents API URL; an optional
token stays in Hawk's encrypted local secret storage. **Hawk: Issue → Branch →
PR Automation** creates a GitHub issue, creates a scoped feature branch,
commits and pushes only after approval, opens the pull request, and posts a
bounded static-review comment. Existing PRs can be reviewed with **Hawk:
Review GitHub Pull Request**; **Hawk: Open Pull Request from Current Branch**
resumes the PR step after an AI patch is applied. GitHub authentication uses
VS Code's built-in session or encrypted local SecretStorage, and final merge
approval remains human-controlled.

**Hawk: Set Up Local AI with Ollama** discovers an existing local runtime or
downloads the latest official Windows release. Hawk requires the GitHub
release SHA-256 digest and a valid Ollama Authenticode signer before launch,
then offers a RAM-sized coding model with its approximate download size.
Model installation remains explicitly approved and the selected provider is
configured on `http://127.0.0.1:11434`.

**Hawk: Configure AI Provider and API Key** supports Ollama, LM Studio,
OpenAI, Anthropic, Gemini, OpenRouter, Groq, DeepSeek, Kimi, and custom
OpenAI-compatible endpoints. Hosted keys are stored in OS-backed VS Code
SecretStorage, injected only into the local daemon, and never written to
settings or workspace files. Remote custom endpoints require HTTPS; local HTTP
is restricted to loopback.

The production updater reads the Stable or Beta channel from Hawk's HTTPS
update service and falls back to the official GitHub Releases API. Installer
size, SHA-256 manifest, trusted redirect host, Windows Authenticode chain, and
optional publisher pin are verified before explicit install approval.

The extension bundles its MCP server and copies a self-contained configuration
that launches it through the Hawk/Code-OSS executable, so no global
`hawk-ide-mcp` install is required. It exposes bounded Docker worker
orchestration: Docker Desktop lifecycle controls, background dependency
graphs, up to 32 isolated workers, immutable local image identities, non-root
execution, cross-run CPU/RAM governance, artifact quotas, retries,
cancellation, orphan cleanup, and per-task artifacts under
`.hawk/orchestrations/`.

## Development

From the repository root:

```sh
npm install
npm run check:extension
npm run build:extension
```

Set `hawk.daemonPath` to an absolute daemon binary path when the
binary is not on `PATH`. The extension launches the daemon for the active
workspace, holds its token only in the extension host, and never sends it to
the dashboard webview. When no path is configured, the extension uses its
bundled daemon so the portable IDE works without a separate daemon binary on
`PATH`. **Hawk: Open AI Agent** uses the same model/provider configuration as
the Hawk CLI in `~/.hawk/config.json`.

Open the complete product surface with **Hawk: Open Mission Control** or
`Ctrl+Shift+H` (`Cmd+Shift+H` on macOS).

**Hawk: Run Approved Passive Workspace Scan** opens the governed template
picker and binds approval to the exact plan hash. **Hawk: Build Sanitized
Evidence Pack** writes Markdown, HTML, JSON, SARIF, and a SHA-256 manifest.
**Hawk: Plan Governed Smart MCP Mission** persists a reviewable goal, policy,
and DAG but never executes it.

The static audit parses source text only. Its results are suspected signals,
not confirmed vulnerabilities. **Reproduce** creates an expiring, hash-bound
plan and runs supported signals through baseline, safe-control, and
reproduction gates in a read-only, zero-network Docker sandbox. A reproduced
signal remains unverified until the separate identity, impact, scope, evidence,
and review gates pass. HAR import remains local and retains only a redacted
request inventory; it does not replay traffic or retain bodies, cookies, or
authorization headers. For authorized differential testing, **Hawk: Plan
Identity Replay** binds two to eight named credential sets to one exact
captured host and port, requires a second explicit approval, rate-limits each
request, disables redirects, and returns only bounded response fingerprints.
Credentials and response bodies remain memory-only.
