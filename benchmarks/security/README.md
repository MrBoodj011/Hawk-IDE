# Hawk public security benchmark

Had benchmark public kayst3mel repos open-source 7a9i9iya, w kay9is nafs lmetrics f kol run: detection, reproduction, false positives m3a ground-truth labels, fix/test success, wall time, peak memory, w cost.

`public-manifest.json` howa dataset seed; ma kay3nich belli Hawk qas kol repo daba. Lrunner dyal CI khaso yclone lcommit pinned, ychghal adapters/reproduction modes f sandbox, yrecord samples, w ypost report l endpoint:

```text
POST /v1/benchmarks/security
```

Kol sample khaso `repo`, `findingId`, `detected`, `reproduced`, `durationMs`, w ila kaynin `truth`, `fixed`, `testsPassed`, `memoryBytes`, `costUsd`. Report kay3ti reproduction rate, false-positive rate, fix success, p50/p95, memory, cost, w per-sample provenance.

## Dataset seed

Repos homa public w intentionally security-focused: OWASP Juice Shop, OWASP WebGoat, OWASP NodeGoat, Damn Vulnerable Web Application, w GoogleClusterFuzz. CI khaso ypin commit SHA w yst3mel authorization local/sandbox only.
