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
3. Multiline Next Edit acceptance, rejection, cancellation, and stale-edit
   guard; coordinated Multi-File Next Edit preview, rejection, atomic Apply,
   one-step Undo, ambiguous-preimage refusal, and all-files drift refusal.
4. Debug snapshot on breakpoint and exception; isolated fix; test; Apply; rerun.
5. Three long parallel lanes; pause; Hawk restart; resume; candidate synthesis.
6. Apply conflict after an operator edit and exact safe Revert after Apply.
7. Browser/Burp capture with narrow scope, redaction, rate limit, and evidence export.
8. Signed v0.7.x to v0.7.x+1 updater detection, verified download, silent
   installation inside an ephemeral Windows runner, version check, and cleanup.
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

Record one real session with:

```powershell
npm run beta:record -- `
  --cohort typescript-monorepo `
  --repository-commit <commit> `
  --model <provider/model> `
  --hardware "<cpu / ram / os>" `
  --outcome pass `
  --manual-recovery false `
  --critical-high-findings 0 `
  --search-p95-ms <milliseconds> `
  --peak-rss-mb <megabytes> `
  --signed-update-verified true `
  --evidence <sanitized-session-evidence.json>
```

The command stores a local, atomic evidence ledger under
`.hawk/validation/beta-acceptance.json`. It does not invent results. Run
`npm run release:readiness` to check the five-session, three-cohort gate.
The expected structure is documented in
`docs/audit/BETA_ACCEPTANCE.example.json`.
