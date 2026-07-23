# Native Hawk AI sessions

Hawk AI runs the existing multi-provider Hawk agent directly behind the local
IDE daemon. The editor panel receives durable events for model identity,
planning, streamed assistant text, file-tool calls, tool results, test output,
errors, and the final review state.

## Change boundary

Each new session:

1. locates the workspace git repository;
2. creates a detached temporary worktree;
3. snapshots tracked changes and regular untracked workspace files into a
   temporary commit;
4. starts a separate Hawk worker process with that worktree as its current
   directory; and
5. exposes only root-bounded file read, write, edit, single-file delete, glob,
   and grep tools.

The native worker has no shell, browser, HTTP, or target-access tool. Sensitive
file gates remain active, symlinks are resolved before access, and paths or
glob patterns that escape the isolated root are rejected.

## Local model bootstrap

**Hawk: Set Up Local AI with Ollama** provides a Windows-native setup path for
operators without an API provider. It detects the per-user Ollama install and
loopback API, or downloads the latest official `OllamaSetup.exe` after checking
its GitHub SHA-256 digest, bounded size, final download host, and Authenticode
signer. The model picker is sized from local RAM and shows the approximate
download before approval. A successful pull updates Hawk's provider, model,
and `http://127.0.0.1:11434` base URL, then restarts the daemon.

The real workspace is unchanged while the model works. At the end of a turn,
Hawk stages only the isolated workspace changes, produces a bounded binary-safe
patch, records its SHA-256 hash, and stores preimage hashes for every touched
file.

## Review actions

- **Preview exact diff** shows the patch inside the Hawk panel and in the
  editor's diff viewer.
- **Run gates** executes only detected `package.json` scripts selected from the
  daemon's fixed `typecheck`, `lint`, `test`, and `build` allowlist. The user
  must approve the commands first.
- **Auto verify** requires one explicit launch approval, runs the same fixed
  gate allowlist, records each attempt in durable session history, and feeds
  bounded failure output back to the isolated agent. It retries at most
  `hawk.agent.autonomous.maxRepairAttempts` times, resumes after daemon
  restart, and always stops at manual diff review. It never calls Apply.
- **Apply** requires a modal approval and the exact reviewed patch hash. Hawk
  refuses the operation if any touched workspace file drifted after the
  session snapshot. Applying without passing detected gates requires a second
  explicit override.
- **Reject** deletes the isolated worktree and never changes the workspace.
- **Revert** uses the retained exact patch. It first verifies that every
  touched file still matches the post-apply hash, so it cannot silently erase
  later operator edits.
- **Stop task** terminates the worker or approved gate process.
- **Save checkpoint** copies the exact hash-verified isolated patch into the
  durable session store.
- **Restore checkpoint** resets only the temporary worktree, verifies the
  retained SHA-256, and regenerates the review diff.
- **Open isolated terminal** opens the editor terminal in the review worktree,
  so streamed commands cannot change the operator workspace before Apply.
- **Run 3 Docker lanes** sends architecture, implementation, and verification
  sessions directly through Hawk's capability-aware Docker scheduler. Before
  launch, Hawk verifies Docker, resolves the configured image to an immutable
  ID, assigns each lane to an agent slot, and records the placement score and
  reasons in durable session state. Every container receives only its own
  writable detached worktree and agent-memory file, plus a read-only Hawk
  daemon bundle. It has a read-only root filesystem, dropped capabilities,
  `no-new-privileges`, PID/CPU/RAM limits, no Docker socket, and no mount of the
  operator workspace. Each lane autonomously verifies its candidate with
  bounded repair attempts and remains a separate review session.
- Parallel AI provider access is approval-gated. `provider-egress` connects
  the selected model provider and rewrites loopback Ollama/LM Studio URLs to
  `host.docker.internal`; `none` disables container networking. Image,
  scheduling strategy, CPU, RAM, and network mode are configurable under
  `hawk.agent.parallelDocker.*`.
- **Pause** stops the worker while retaining its worktree and saved agent
  memory. **Resume** continues it without recreating the task.
- Background lanes recover after daemon restart and auto-resume when enabled.
  Docker-backed lanes retain their immutable image, placement metadata, limits,
  and network policy when resumed; Hawk does not silently fall back to a host
  process.
- **Semantic Merge v2** scores review-ready lanes, reads their isolated file
  states, and compares TypeScript/JavaScript compiler-AST declarations,
  imports, containers, and members. Python functions, classes, and methods use
  indentation-aware declaration boundaries. Compatible whole-file and symbol
  edits are transplanted into a fresh worktree deterministically. Same-symbol
  divergence, removal-versus-modification, base drift, and unsupported-language
  collisions become a structured conflict plan for the merge agent instead of
  patch concatenation. The result remains an ordinary review-gated diff.
- **Hawk: Run Automatic Debug / Test / Fix Loop** captures native DAP threads,
  frames, scopes, variables, breakpoints, and diagnostics, redacts secret-like
  values, and starts an isolated fix task. After a separate approval showing
  the exact gate commands, Hawk relaunches the saved debugger configuration
  against the current isolated worktree, reproduces the original failure,
  runs approved retest gates, and feeds bounded DAP/test evidence into the next
  fix attempt up to `hawk.debug.autoFix.maxAttempts`. An inconclusive relaunch
  never counts as a green reproduction result; successful fixes still require
  manual diff review and Apply.
- **Hawk: Show Next Edit Model Evaluation** compares every model configuration
  observed by Hawk Tab using structured-edit validity, explicit editor
  acceptance/rejection feedback, cache reuse, and p50/p95 generation latency.
  Recommendations are labelled low, medium, or high evidence confidence.
- **Governed memory injection** runs automatically for every native, background,
  Docker, resumed, and semantic-merge agent turn. Hawk retrieves only active
  entries relevant to the prompt, excludes branch-mismatched facts, redacts
  credential-shaped values, bounds the injected context to 12,000 characters,
  and wraps it as read-only evidence with prompt-injection guidance. Revoked,
  stale, expired, or unrelated memory is not injected.
- **Generic security reproduction** accepts a bounded operator-provided
  control/reproduction command pair for findings that have no deterministic
  Hawk rule adapter. Commands run as direct argv (no shell), only approved
  runtimes are accepted, the container stays read-only with dropped
  capabilities and no network, and expected exit codes are bound into the
  approval hash. The negative control must not match while the reproduction
  command must match; both remain observations, never an automatic verdict.
- **External security adapters** expose one normalized Hawk finding stream for
  CodeQL, Semgrep, OWASP ZAP, Nuclei, Trivy, and OSS-Fuzz SARIF. **Hawk: Import
  External Security SARIF** preserves producer identity, redacts messages,
  bounds imports to 500 findings/5 MB, and sends imported signals through the
  same governed reproduction, evidence, AI-fix, and GitHub workflow. **Hawk:
  Run Governed Security Adapter** executes the official CLI inside a bounded
  Docker lane, requires a hash-bound approval, supports no-network or explicit
  host allowlists, and imports SARIF from stdout or `/output/results.sarif`.
- **Security benchmark** accepts a public manifest of real repositories and
  reports reproduction rate, labeled false-positive rate, fix/test success,
  p50/p95 time, peak/average memory, and total/average cost. The report keeps
  per-sample provenance so teams can publish repeatable comparisons.
- **Security graph chain** links source file and route to HTTP request, finding,
  reproduction, evidence pack, agent patch, tests, and recorded GitHub PR.
  Delivery metadata is added only through the authenticated local daemon.
- **Multi-mode reproduction** labels the governed command pair as `command`,
  `http`, `unit-test`, `fuzz`, `protocol`, or `dependency`; the operator supplies
  the exact direct-argv control and reproduction commands for that mode.
- **Hawk: Issue → Branch → PR Automation** creates a GitHub issue, derives and
  creates a local feature branch, commits only after a modal approval, rejects
  secret-like paths, runs `git diff --check`, pushes the branch, opens a PR
  with `Closes #…`, and posts a bounded Hawk review. **Hawk: Review GitHub Pull
  Request** can post the same evidence-bounded review to an existing PR, while
  **Hawk: Open Pull Request from Current Branch** resumes the PR step after an
  AI implementation has been applied to the issue branch. GitHub
  authentication uses the built-in VS Code session when available or an
  OS-backed SecretStorage token; credentials never enter git arguments or
  webviews. A human maintainer remains responsible for final merge approval.

## AI fix quality and integrations

Apply is blocked until three independent gates are green: an approved direct-argv
reproduction, every detected project test gate, and Hawk Semantic v2 review with
zero AST/semantic conflicts. The durable session keeps the exact patch hash,
redacted reproduction/test output, semantic review hash, branch scope, and audit
events. Hawk also exposes governed integration contracts for GitHub, GitLab,
Jira, Slack, Burp, Browser, CI/CD, Docker, and Kubernetes; external actions use
expiring approval plans and credentials never enter plan payloads.

## Next Edit acceleration and evaluation

Hawk keeps a bounded, TTL-controlled prediction cache in daemon memory. An
exact repeated request is returned immediately. Concurrent identical requests
join one model call, and when an operator manually types the beginning of a
cached insertion Hawk can return the remaining text without another call.
Index rebuilds and provider/model configuration changes invalidate reuse
through the cache key.

The model scorecard persists only aggregate counters and the latest bounded
latency samples under `~/.hawk/ide/prediction-evaluation/`. It never stores
prompts, source, diagnostics, file names, or generated edits. The acceptance
rate is explicitly an operator-feedback proxy rather than a synthetic accuracy
claim. **Hawk: Clear Next Edit Cache** removes the in-memory source cache.

Smart MCP evaluation runs are also aggregated per Hawk model (quality,
reliability, p95 latency, cost, model class, and sample count). On startup the
MCP brain hydrates the adaptive router from those durable profiles; each new
Hawk evaluation publishes a fresh snapshot to the running planner immediately.
Baseline records remain comparison-only and cannot change live routing.

## Coordinated Multi-File Next Edit

**Hawk: Predict Coordinated Multi-File Edit** infers one follow-up spanning
two to eight existing files from recent operator edits, current diagnostics,
open documents, and semantic-index neighbors. It is deliberately separate
from inline Tab because an editor ghost-text item cannot safely represent
changes to several files.

Hawk sends complete bounded candidate documents to the loopback daemon. The
model must return one unique exact replacement per distinct provided file.
The daemon rejects low-confidence, ambiguous, duplicate-path, traversal, file
creation, and single-file answers. Each accepted edit carries the SHA-256 of
its complete base document. The extension opens an exact diff preview and
waits for **Apply all** or **Reject**. Before applying, it reopens every target,
rechecks every digest and unique old-text preimage, then submits one atomic
VS Code `WorkspaceEdit`. Any drift cancels the entire operation; files are
never partially applied. One Undo reverts the accepted workspace edit.

## Automatic terminal-output context

Hawk listens to VS Code's shell-integrated terminal execution lifecycle and
starts reading the output stream as soon as a command begins. Only executions
whose reported working directory is inside a trusted open workspace qualify.
Hawk strips ANSI/OSC/control sequences, applies backspaces, redacts common
authorization headers, tokens, passwords, credential URLs, JWTs, provider
keys, and AWS access-key shapes, then retains only a bounded output tail in
memory.

The **Terminal output** context chip is enabled by default in Hawk AI. It adds
the latest bounded command records, exit codes, relative working directories,
and redacted output to the next task. The context explicitly treats terminal
text as untrusted diagnostic evidence rather than agent instructions.
Retention, successful-command inclusion, command count, and character limits
are configurable under `hawk.agent.terminalCapture.*`.

No terminal transcript is written to disk. Commands outside the workspace are
ignored, and terminals without VS Code shell integration are not scraped
through unstable or proposed APIs. **Hawk: Show Captured Terminal Context**
shows exactly what can be attached; **Hawk: Clear Captured Terminal Context**
removes it immediately.

## Persistence

Session metadata, event logs, agent conversation memory, and retained patches
are stored outside the repository under:

```text
~/.hawk/ide/workspaces/<workspace-hash>/ai-sessions/
```

No daemon token is sent to the webview. The extension host owns that token and
proxies every authenticated request to the loopback-only daemon. A daemon
restart restores interrupted work as paused/recoverable. Background sessions
with auto-resume enabled continue from saved agent memory; interrupted test
gates are never assumed to have passed.

## Local API

The token-gated daemon exposes:

```text
POST /v1/ai/sessions
POST /v1/ai/batches
GET  /v1/ai/batches/:batch-id
GET  /v1/ai/batches/:batch-id/events?after=<json-cursors>
POST /v1/ai/batches/merge
GET  /v1/ai/sessions
GET  /v1/ai/sessions/:id
GET  /v1/ai/sessions/:id/events?after=<event-id>
POST /v1/ai/sessions/:id/messages
GET  /v1/ai/sessions/:id/diff
POST /v1/ai/sessions/:id/tests
POST /v1/ai/sessions/:id/tests/cancel
POST /v1/ai/sessions/:id/apply
POST /v1/ai/sessions/:id/checkpoints
POST /v1/ai/sessions/:id/checkpoints/restore
POST /v1/ai/sessions/:id/reject
POST /v1/ai/sessions/:id/revert
POST /v1/ai/sessions/:id/cancel
POST /v1/ai/sessions/:id/pause
POST /v1/ai/sessions/:id/resume
POST /v1/ai/inline-completion
POST /v1/ai/edit-prediction
POST /v1/ai/edit-prediction/multi-file
POST /v1/ai/edit-prediction/feedback
GET  /v1/ai/edit-prediction/evaluation
DELETE /v1/ai/edit-prediction/cache
POST /v1/workspace/semantic-index
PUT  /v1/workspace/semantic-index/file
DELETE /v1/workspace/semantic-index/file
POST /v1/workspace/search
POST /v1/diagnostics/coding-core
```

All mutating review endpoints require an explicit approval field. Apply also
requires the current patch hash.
