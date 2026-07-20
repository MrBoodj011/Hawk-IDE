# Hawk chaos and recovery tests

Hawk treats the daemon, the Docker worker runtime, and each background coding
agent as independently crashable processes. The chaos suite checks the durable
handoffs that make that safe:

| Fault injected | Expected invariant |
| --- | --- |
| Worker hangs/crashes while a task is running, then the orchestrator restarts | `run.json` is sufficient to reattach the retained worker; the task completes once and the run reaches a terminal state. |
| Docker/network adapter throws `ECONNRESET` | The task is recorded as a failed attempt, retries only within its explicit budget, and never leaves the run stuck in `running`. |
| Recovery itself loses the Docker/network socket | The reattach failure is persisted, the task is reassigned only within its retry budget, and the next worker attempt can complete normally. |
| Hawk agent process disappears while a background task is editing an isolated worktree | The saved session/worktree is reopened, the task auto-resumes once, and the resulting diff is still reviewable. |

Run the deterministic suite locally:

```sh
npm run test:chaos
```

The tests use in-process fault-injecting runtimes and a tiny worker fixture; no
Docker daemon, network target, model key, or external service is required. This
makes them suitable for every pull request and for reproducing recovery bugs.

For release hardening, run the same scenarios against a disposable Docker
daemon as a scheduled job: stop/restart the daemon during a labelled worker,
drop the daemon socket/network route, and restart the Hawk control process.
Compare the resulting `run.json`, task attempt count, lease state, and agent
session events with the invariants above. Never run that destructive variant
against an operator's active workspace.
