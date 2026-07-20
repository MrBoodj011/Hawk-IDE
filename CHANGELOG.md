# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.0] - 2026-07-20

### Added

- **Strict sub-500 MiB index contract** — Hawk now records baseline, final,
  delta, and process-lifetime peak RSS, fails a repeatable memory gate at
  500 MiB, and enforces the same limit in large-project beta benchmarks.
- **Real signed-update smoke gate** — every published desktop release is
  downloaded again from the private GitHub feed on Windows and must pass
  release selection, exact-size, SHA-256, PE, trusted-host, and Authenticode
  verification without launching the installer.

### Changed

- The persistent semantic index uses wider chunks, bounded large-file AST
  parsing, 2,200 resident chunks, a 128 MiB persistent file ceiling, and
  bounded finite local embeddings to keep indexing responsive under the new
  memory budget.
- Windows updates cannot launch unless their Authenticode chain is trusted.
  Production publication also requires a pinned `HAWK_WINDOWS_PUBLISHER`
  certificate subject in addition to the PFX or Azure signing identity.
- The local IDE API protocol is now version 11.

## [0.6.0] - 2026-07-20

### Added

- **Automatic offline sandbox reproduction** — supported static findings can
  create an expiring, SHA-256-bound plan and, only after exact operator
  approval, run baseline, safe negative-control, and deterministic
  reproduction gates in a local Docker worker. The workspace and root
  filesystem are read-only, network is disabled, Linux capabilities are
  dropped, and CPU, RAM, time, logs, and artifacts remain bounded.
- **Native reproduction workflow** — the loopback daemon, Hawk MCP server,
  Mission Control, reproduction history, and Security Graph now share the same
  persisted result. A reproduced signal is explicitly never auto-promoted to a
  verified vulnerability; independent identity, impact, scope, evidence, and
  review gates remain mandatory.
- MCP tools `hawk_reproduction_plan`, `hawk_reproduction_execute`, and
  `hawk_reproductions_list`.

### Changed

- **Pixel-polished Hawk identity** — Mission Control now has one consistent
  Hawk wordmark, a six-card operational scoreline, explicit local trust
  boundaries, a branded Sandbox Lab, clearer finding actions, and dedicated
  responsive layouts verified at desktop and 390 px mobile widths.
- The local IDE API protocol is now version 10.

## [0.5.0] - 2026-07-20

### Added

- **Intelligent distributed Docker agent scheduler** — capability and resource
  matching, critical-path and operator priority ranking, balanced/latency/
  throughput strategies, worker health and observed-duration scoring, expiring
  leases, retry reassignment, restart reattachment, and live scheduler
  inspection through MCP.
- **Native Security Graph** — the local daemon now continuously connects
  repository files, route-handler symbols, routes, redacted HTTP requests,
  audit signals, evidence, evidence packs, agent patches, and test gates with
  explicit confidence and provenance. Smart MCP and Mission Control use the
  same durable graph.
- **Traceable Mission Control graph** — the branded source-to-request surface
  renders real backend relations and opens graph nodes at their source
  location.

### Changed

- The local IDE API protocol is now version 9.
- Docker orchestration snapshots use protocol version 2 and record instance
  assignments, placement reasons, critical-path estimates, leases, duration,
  and reassignment counts.

## [0.4.0] - 2026-07-20

### Added

- **Automatic Debug Agent** — one explicit approval starts a bounded
  diagnose/edit/test/fix cycle in the isolated worktree. Hawk feeds exact
  failed-gate output and a refreshed, redacted DAP snapshot back into the same
  durable agent session until all approved gates pass or the configured safety
  limit is reached. Cancel stops the active gate; Apply always remains manual.
- **Real AST semantic merge** — parallel candidates are compared by
  TypeScript/JavaScript declarations, imports, classes, interfaces, and
  members. Compatible whole-file and symbol changes are deterministically
  transplanted into the merge worktree before the model runs; divergent edits
  to the same semantic unit become an explicit conflict plan in Hawk AI.

### Changed

- The local IDE API protocol is now version 8 and returns the structured
  semantic merge plan alongside candidate scores.

## [0.3.1] - 2026-07-20

### Added

- **Fast, evaluated Hawk Next Edit** — bounded exact and partial-typing
  continuation caches, concurrent-request deduplication, confidence filtering,
  editor acceptance/rejection feedback, and a persistent per-model scorecard
  for valid-edit rate, acceptance proxy, cache reuse, and p50/p95 latency.
- **Privacy-safe evaluation** — the scorecard stores only aggregate counters
  and bounded latency samples. Prompts, source, diagnostics, file names, and
  generated edits remain in memory and are never persisted by evaluation.

## [0.3.0] - 2026-07-18

### Added

- **Hawk Next Edit and deep index** — safe multiline replacement prediction
  plus a persistent, incremental TypeScript/JavaScript AST/type/import/call
  index with optional loopback-only Ollama embeddings.
- **Native Debug Agent** — breakpoint, thread, stack, scope, variable, and
  diagnostics capture with secret redaction and an isolated fix loop.
- **Durable coding mesh** — Pause/Resume, restart recovery, background
  auto-resume, and test-aware intelligent synthesis across parallel candidates.
- **Production release gates** — trusted RSA Authenticode signing and
  verification, a real private-feed updater test, Chrome/PortSwigger submission
  packs, an external pentest scope, and large-project beta benchmarks.

- **Saved memory (`#` quick-add)** — a curated, human-readable memory layer
  modeled on Claude Code. `#<text>` saves a durable fact (one Markdown file per
  fact with frontmatter, under `.pentesterflow/memory/`); `#!<text>` saves it to
  the personal scope. The fact catalog is pinned into the system prompt every
  turn (survives compaction) and the most relevant facts are recalled in full
  per turn, surfaced as a `recalled memory: …` line. Manage with
  `/memory add|list|forget`. Secrets are redacted before write.
- **Parallel tool dispatch** — independent tool calls in one step now run
  concurrently (bounded fan-out) with results recorded in call order; recon
  fan-outs finish in ~max(latency) instead of the sum. Single-call and
  `load_skill` steps stay sequential. The permission prompter serializes its
  modal so approvals still appear one at a time.
- **LLM retry/backoff** — transient backend failures (HTTP 429 / 502 / 503 /
  504 and connection drops) are retried with exponential backoff, honoring a
  `Retry-After` header. Applied to the OpenAI-compatible client (Kimi, Groq,
  OpenRouter, DeepSeek, LM Studio).

### Changed

- **Hawk Obsidian desktop identity** — rebuilt the native shell, product mark,
  title bar, activity icon, colors, Mission Control, and Hawk AI surfaces around
  one operator-grade visual system. Upstream onboarding, sign-in, Chat, and
  Copilot surfaces stay hidden; local model outages now render as a guided
  offline state instead of raw transport errors.

- **Self-update hardening** — a pinned `pentesterflow update <version>` now
  fetches the installer from that release tag (immutable) instead of `main`, and
  the installer URL is asserted to be https on `raw.githubusercontent.com`
  before fetch.

### Fixed

- **Redaction gaps** — connection-string query-param credentials
  (`?password=` / `&auth=` / `&access_token=`), HTTP Digest `response=` hashes,
  and GCP service-account `private_key_id` are now masked.
- Closed out the internal code audit: 35 of 39 findings fixed, 3 accepted as
  intentional, 1 hardened (see `AUDIT.md`).

## [0.2.1] - 2026-07-18

### Added

- **Verified Hawk Local AI setup** — the Windows EXE offers Ollama as a
  selected component; the installer and native first-run wizard require the
  official GitHub release path, bounded size, published SHA-256 digest, and
  valid Ollama Windows signer. Hawk recommends a coding model from local RAM,
  discloses its approximate size, pulls it only after approval, configures the
  loopback provider, and restarts the workspace daemon.

## [0.2.0] - 2026-07-18

Hardening, model tuning, and a transcript/status overhaul, plus Claude
Code-style permission bypass. Focus areas: the permission model, Kimi K2.6/K2.5
behavior, and making long-running turns legible.

### Added

- **Hawk Coding Core** — editor-native inline completion, a bounded local
  symbol-aware semantic index, natural-language workspace search, named
  checkpoints, isolated task terminals, three-lane parallel coding sessions,
  explicit BYOK model fallback routes, performance benchmarks, and a private
  GitHub Release updater with SHA-256 verification.

- **`--yolo` flag** — canonical short flag for permission-bypass mode;
  `--dangerously-skip-permissions` is kept as an alias.
- **SuperMode badge** — when permission-bypass is on, a right-aligned
  `SuperMode` indicator is pinned to the status bar in every phase so it's
  always clear that approvals are being skipped.
- **`temperature` config option** — sent to providers that accept it;
  automatically omitted for models that reject it (Kimi K2.6/K2.5 lock it to 1).
- **`max_tokens` config option** — per-response token cap. Kimi defaults to
  2048 (these models can't be slowed via temperature) so a turn can't narrate
  unbounded; override per config.
- **Kimi thinking toggle** — `thinking: disabled` is now sent for the reasoning
  models that support it (K2.6/K2.5) to suppress the `reasoning_content` trace.
- **Markdown tables and links** in the transcript — pipe tables render as an
  aligned grid; `[label](url)` renders as styled `label (url)`.
- **Structured HTTP responses** — `http` tool results color the status line by
  class (2xx/3xx/4xx/5xx), dim header names, and syntax-highlight JSON bodies.
- **First-class findings** — `confirm_finding` now renders a severity-colored
  finding card instead of a generic tool line, and the `findings` filter keys
  off it.
- **Live turn feedback** — the busy status line names the in-flight tool and
  shows an elapsed `m:ss` clock, so a slow tool is distinguishable from a hang.
- **`NO_COLOR` support** — when `NO_COLOR` is set, the UI's chalk instances drop
  to level 0 and color is not force-enabled (per no-color.org).

### Changed

- **Permission bypass now skips *everything*** — YOLO / `--yolo` /
  `--dangerously-skip-permissions` auto-approves all prompts, including the
  sensitive-file and SSRF/private-host gates (the `bypassYolo` carve-out was
  removed), matching Claude Code's `--dangerously-skip-permissions`. The shell
  denylist still hard-blocks catastrophic commands. **Breaking** for anyone who
  relied on YOLO still prompting for credential paths.
- **Session-scoped approvals** — an "allow session" decision is now keyed to the
  specific command, request origin, or target path instead of the bare tool
  name, so approving one `shell`/`http`/`file_write` call no longer whitelists
  every later call of that tool for the session.
- **Kimi auto-compaction sized to context window** — K2.6/K2.5 (256K) compact at
  ~196K rather than the generic 16K default, so their large window is actually
  used; small Moonshot models are tightened to avoid silent overflow.
- **Permission modal shows the full command** — shell/http/file requests display
  the exact, untruncated, code-styled payload being approved.

### Fixed

- **"Stuck on planning"** — streaming responses now advance the status phase to
  "answering" on the first delta instead of showing "planning" for the entire
  generation.
- **Silent reasoning-model stalls** — `reasoning_content` deltas are streamed as
  visible progress (and kept out of conversation history) so a reasoning model
  no longer looks frozen while thinking.
- **Kimi `temperature` 400s** — `temperature` is no longer sent to K2.6/K2.5,
  which reject any value other than 1.

### Security

- **SSRF guard on the `http` tool** — requests whose host is (or resolves to) a
  private, loopback, link-local, or cloud-metadata address require an explicit,
  non-cached approval (shared with `web_fetch`); covers IPv4, IPv6, and
  `::ffff:` mapped forms.
- **Fail-closed self-update** — the installers (`install.sh`, `install.ps1`)
  now refuse to install a binary they can't SHA-256 verify (missing
  `SHA256SUMS`, missing checksum tool, or mismatch are all fatal). Override with
  `PENTESTERFLOW_SKIP_CHECKSUM=1`.

## [0.1.0] - 2026-05-31

First public release of pentesterflow — an agentic offensive-security CLI for
security engineers, professional penetration testers, and bug hunters.

### Added

- **Baseline x64 release binaries** — x64 standalone binaries are now built
  with Bun's baseline runtime so older x86_64 CPUs without AVX2 do not crash
  with `Illegal instruction` on startup.
- **Continuous learning intelligence** — local project and personal knowledge
  bases store redacted lessons from completed turns and compactions, including
  user preferences, decisions, proven workflows, mistakes, tool/config patterns,
  coverage gaps, finding patterns, and recon lessons. Relevant memories are
  retrieved silently as hidden context so future sessions improve without
  manual memory management.
- **Resume recap** — `--resume <session-id>` now opens with a concise recap of
  the previous session's persistent memory, similar to Codex-style session
  continuity, so analysts can immediately see what happened before continuing.
- **LM Studio stop-token handling** — OpenAI-compatible LM Studio responses now
  send chat-template stop tokens and trim leaked markers such as `<|user|>` and
  `<|observation|>` in both streaming and non-streaming paths.
- **Cleaner shell transcript states** — search commands with no matches now show
  `[no match]` instead of a misleading success line, and non-zero no-output
  shell results render as `(no output)`.
- **Kimi provider support** — first-class `kimi` backend, default Moonshot API
  settings, provider-scoped model listing, secret API-key prompt in the
  provider picker, and Kimi-compatible request shaping.
- **Groq provider support** — first-class `groq` backend, default Groq
  OpenAI-compatible endpoint, `GROQ_API_KEY` loading, model listing, and
  secret API-key prompt in the provider picker. Groq sessions use a compact
  system prompt and lower auto-compaction threshold to avoid on-demand TPM 413
  errors during long assessments.
- **Gemini provider support** — first-class `gemini` backend, native
  `generateContent` tool-call integration, `GEMINI_API_KEY` loading,
  interactive API-key setup, recommended PentesterFlow-fit model ordering, and
  `cheap cost` tags for low-cost Gemini models in the picker.
- **Burp bridge runtime** — `pentesterflow --burp [port]`, `/burp [port]`, Burp
  task ingestion, issue import endpoints, and Browser Capture tools for reading
  queued Burp requests and confirmed issues from the CLI session.
- **Context snapshots and session memory** — compacted engagement memory,
  `/compact`, `/memory`, `/snapshot`, automatic five-minute context snapshots,
  persisted memory in session files, and status-bar memory counters.
- **Coverage-driven next steps** — `/next [objective]` uses coverage state to
  propose concrete untested endpoint / parameter / vulnerability-class checks
  without running tools.
- **Improved terminal UX** — full-width dynamic banner layout, framed input
  prompt lines, better multi-line history behavior, and clearer context usage
  display.
- **LLM backends** — Ollama and OpenAI-compatible clients (LM Studio, vLLM,
  llama.cpp server, remote providers) with NDJSON / SSE streaming, abort-aware
  fetch, a `ready` / `disconnected` health probe, and error classification.
- **Eleven built-in tools** — `shell` / `BashTool`, `file_read` / `file_write` /
  `file_edit` (with PascalCase aliases), `GlobTool`, `GrepTool`, `http`,
  `web_fetch`, `web_search`, `ask_user`, `confirm_finding`, `coverage`,
  `load_skill`, and the `browser_capture_*` family.
- **Ten skills** — `recon`, `webvuln`, `ssrf`, `ssti`, `jwt`, `graphql`, `race`,
  `takeover`, `supabase`, and `deserialize`, loaded on demand from markdown
  playbooks. Scaffold new ones with `/skills new`.
- **Scope-locked system prompt** — penetration testing / bug bounty / code
  review / coding only, calibrated against OWASP Top 10, the Bugcrowd VRT, and
  PortSwigger research (markers pinned in tests).
- **Agent loop** — autonomous plan → act → observe → verify → report with
  `AbortSignal` cancellation, error recovery, `@file` mention expansion, and
  session save on every history mutation.
- **MCP integration** via `@modelcontextprotocol/sdk`, including one-flag Browser
  MCP and a standalone `pentesterflow-browser-mcp` stdio server with a local
  capture-ingest endpoint.
- **Findings workflow** — verified bugs written to `./findings/<slug>.md` with a
  copy-pasteable PoC, impact, and remediation.
- **Safety rails** — shell denylist, sensitive-path gating, and credential
  redaction on `/compact` and `/export`.
- **Terminal UI** — banner, scrollback transcript, multi-line input with
  bracketed-paste, slash-command completion menu, `@file` mention picker,
  markdown rendering, status bar, and permission / question modals.
- **Configuration** — zod-validated `~/.pentesterflow/config.json` with
  crash-safe atomic saves; resumable sessions; structured JSON-lines logs.
- **Quality** — 300+ unit and integration tests (vitest), typecheck, and lint
  gated by `npm run ci`.
- **Distribution** — tsup ESM bundle, single-file binaries, and GitHub Actions
  for CI (Node 20 + 22 on Ubuntu + macOS) and tagged releases (npm +
  cross-platform binaries).

### Changed

- **CLI bridge naming** — `--browser-ingest` is now a deprecated alias for
  `--burp`, keeping old commands working while making Burp integration clearer.
- **Kimi tool-call compatibility** — Kimi OpenAI-compatible requests disable
  provider-side thinking to avoid tool-call failures caused by missing
  `reasoning_content`.
