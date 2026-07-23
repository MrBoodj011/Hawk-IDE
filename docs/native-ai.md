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
- **Run 3 lanes** starts architecture, implementation, and verification agents
  in independent worktrees. Each lane autonomously verifies its candidate with
  bounded repair attempts. Every candidate remains a separate review session.
- **Pause** stops the worker while retaining its worktree and saved agent
  memory. **Resume** continues it without recreating the task.
- Background lanes recover after daemon restart and auto-resume when enabled.
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
  the exact gate commands, Hawk repeats edit, approved tests, and evidence-fed
  repair up to `hawk.debug.autoFix.maxAttempts`. Cancel stops an active gate;
  successful fixes still require manual diff review and Apply.
- **Hawk: Show Next Edit Model Evaluation** compares every model configuration
  observed by Hawk Tab using structured-edit validity, explicit editor
  acceptance/rejection feedback, cache reuse, and p50/p95 generation latency.
  Recommendations are labelled low, medium, or high evidence confidence.

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
