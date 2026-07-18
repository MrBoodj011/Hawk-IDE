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
  in independent worktrees. Each candidate remains a separate review session.

## Persistence

Session metadata, event logs, agent conversation memory, and retained patches
are stored outside the repository under:

```text
~/.hawk/ide/workspaces/<workspace-hash>/ai-sessions/
```

No daemon token is sent to the webview. The extension host owns that token and
proxies every authenticated request to the loopback-only daemon. A daemon
restart marks interrupted work as failed but preserves reviewable sessions and
their event history.

## Local API

The token-gated daemon exposes:

```text
POST /v1/ai/sessions
POST /v1/ai/batches
GET  /v1/ai/sessions
GET  /v1/ai/sessions/:id
GET  /v1/ai/sessions/:id/events?after=<event-id>
POST /v1/ai/sessions/:id/messages
GET  /v1/ai/sessions/:id/diff
POST /v1/ai/sessions/:id/tests
POST /v1/ai/sessions/:id/apply
POST /v1/ai/sessions/:id/checkpoints
POST /v1/ai/sessions/:id/checkpoints/restore
POST /v1/ai/sessions/:id/reject
POST /v1/ai/sessions/:id/revert
POST /v1/ai/sessions/:id/cancel
POST /v1/ai/inline-completion
POST /v1/workspace/semantic-index
POST /v1/workspace/search
POST /v1/diagnostics/coding-core
```

All mutating review endpoints require an explicit approval field. Apply also
requires the current patch hash.
