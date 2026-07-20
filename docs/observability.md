# Hawk local observability and debug bundles

Hawk observability is local, bounded, and support-oriented. It is not a
telemetry service and it never uploads data.

## Request traces and metrics

Every loopback-daemon request receives an `X-Hawk-Trace-Id`. Hawk retains at
most 500 completed traces and 200 route accumulators in memory. A route keeps
at most 256 latency samples. Numeric and UUID-like path segments are normalized,
and URL query strings are removed before a trace is recorded.

`GET /v1/diagnostics/metrics` returns:

- total, active, 2xx, 4xx, 5xx, and internal-error request counts;
- process RSS, heap, and external-memory counters;
- per-method route counts, errors, p50, p95, and maximum latency;
- the latest 100 trace IDs, methods, normalized routes, status codes, and
  durations.

The endpoint requires the same process-scoped daemon token as every other local
API route. Metrics live only for the current daemon process.

## Sanitized debug bundle

Use **Hawk: Export Sanitized Debug Bundle** from the command palette. Hawk
shows a modal approval because the result is written to the workspace. The
daemon accepts the operation only when the request body contains:

```json
{ "approved": true }
```

The output is written with private file permissions under:

```text
.hawk/diagnostics/hawk-debug-bundle-<timestamp>.json
.hawk/diagnostics/hawk-debug-bundle-<timestamp>.manifest.json
```

The manifest binds the filename, exact byte size, and SHA-256 digest. The
bundle may contain runtime versions, bounded request metrics, semantic-index
statistics, and counts of sessions, findings, traffic records, and
reproductions.

It deliberately excludes source code, prompts, generated edits, request and
response bodies, authorization material, cookies, API keys, tokens, and the
absolute workspace path. Extra metadata larger than 256 KiB or containing a
secret-shaped field is rejected. A symlinked diagnostics directory is rejected.

Treat the bundle as local support data: inspect it before sharing, and delete it
when it is no longer needed.

## Runtime verification

Run the packaged-process contract locally:

```sh
npm run test:e2e-runtime
```

The test builds the extension, starts its embedded daemon, indexes a temporary
route, reads metrics, validates a generated debug-bundle digest, starts the
embedded MCP server, and verifies that MCP sees the same route. CI repeats the
already-built contract on Windows and Linux.
