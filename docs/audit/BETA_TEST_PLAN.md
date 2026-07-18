# Hawk private beta plan

Hawk remains a local, personal product during this beta. No account, telemetry,
billing, or cloud sync is required.

## Cohorts

- TypeScript/JavaScript monorepo (10k+ source files).
- Mixed-language backend repository with Docker and CI.
- Authorized web-security lab using Browser and Burp companions.
- Debug-heavy project using Node, Python, or native Debug Adapter Protocol.

## Required scenarios

1. Cold index, restart, warm persistent index, one-file incremental update.
2. Symbol/type/import/call search and optional local Ollama hybrid search.
3. Multiline Next Edit acceptance, rejection, cancellation, and stale-edit guard.
4. Debug snapshot on breakpoint and exception; isolated fix; test; Apply; rerun.
5. Three long parallel lanes; pause; Hawk restart; resume; candidate synthesis.
6. Apply conflict after an operator edit and exact safe Revert after Apply.
7. Browser/Burp capture with narrow scope, redaction, rate limit, and evidence export.
8. v0.2.0 to v0.2.1 updater detection and verified download.
9. Offline Ollama, unavailable model, corrupt index, corrupt session, and lost
   network recovery.

## Exit criteria

- No data loss or unapproved workspace mutation.
- No Critical/High security finding.
- Warm index reuses unchanged files and improves over a cold build.
- Search p95 below 50 ms on the indexed corpus.
- Pause/restart/recovery preserves worktree and agent history.
- Every applied patch has a reviewed hash and conflict-safe preimage check.
- Installer/update hash validation passes; production candidate also has a
  trusted Authenticode signature.
- Five complete real-project task sessions without a manual recovery workaround.

## Evidence

Record repository commit, Hawk commit, model, hardware, index statistics,
prediction latency, session event log, test-gate output, diff hash, updater
report, and any failure/recovery notes. Do not include target credentials or
captured secrets.
