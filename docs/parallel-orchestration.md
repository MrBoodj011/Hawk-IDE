# Hawk parallel Docker orchestration

Hawk's local MCP server schedules an explicit dependency graph across
isolated Docker agent instances. The scheduler ranks ready work by operator
priority and remaining critical path, then chooses a healthy instance using
required capabilities, preferred capabilities, CPU/RAM fit, active load,
failure history, and observed duration. It is useful for independent test
shards, repository analysis, report generation, and headless agent images that
are already installed locally.

Each logical instance represents a schedulable agent slot. Every task
assignment still launches a fresh isolated Docker container and receives a
short-lived lease. A retry can be rebalanced to another compatible instance;
restart recovery reattaches a retained container by run, task, agent, and lease
labels.

Parallelism reduces wall-clock time only when work can be split into
independent tasks. A sequential ten-hour operation does not become a one-hour
operation merely by starting ten identical containers.

## Security and resource boundary

Every worker:

- uses an image that already exists locally (`--pull=never`) and resolves its
  tag to an immutable `sha256:` identity before scheduling;
- gets the workspace mounted read-only at `/workspace`;
- gets a unique quota-limited tmpfs at `/output`; Hawk copies it into the
  durable per-task artifact directory only after the worker stops;
- runs with a read-only root filesystem, all Linux capabilities dropped,
  `no-new-privileges`, a non-root UID/GID, a 256-process limit, and a bounded
  open-file limit;
- receives explicit CPU, memory, artifact, retry, and timeout limits, plus
  global CPU/RAM/worker ceilings shared across concurrent runs;
- has no network by default; and
- is explicitly removed by Hawk after its exit code and capped logs are
  collected. A retained container can be reattached after an MCP restart.

Run state and capped logs are written under
`.hawk/orchestrations/<run-id>/`. Each task owns a separate output directory,
so parallel workers never write to the same source checkout.

## Build the local base image

Start Docker Desktop (or another Docker daemon), then build the small local
worker image:

```sh
docker build -t hawk-worker:local docker/hawk-worker
```

The base image contains Node.js, Python, Git, ripgrep, jq, and curl. A team can
derive another image from it and install its own headless agent or test
runtime. Hawk never pulls or builds an image during `hawk_parallel_start`.

## MCP tools

- `hawk_parallel_runtime` checks whether Docker is ready.
- `hawk_scheduler_status` reads instances, capabilities, health, load,
  reservations, leases, and recent placement decisions.
- `hawk_parallel_estimate` calculates the critical path and theoretical
  scheduling floor before any containers start.
- `hawk_docker_desktop_status` reads Docker Desktop lifecycle state.
- `hawk_docker_desktop_start` requests an asynchronous Docker Desktop start
  after explicit approval. Poll `hawk_parallel_runtime` until it is ready.
- `hawk_docker_desktop_stop` stops it after explicit approval and an
  acknowledgement that unrelated containers can also be affected. Stop is
  also asynchronous.
- `hawk_parallel_start` validates and starts a background task graph.
- `hawk_parallel_status` returns progress and optionally capped logs.
- `hawk_parallel_runs` lists restored and current runs from the workspace.
- `hawk_parallel_cancel` stops pending work and force-removes active workers.

The stop tool refuses to run while a Hawk orchestration is active unless
`force` is explicitly enabled. Forced shutdown first cancels the active Hawk
runs. Hawk does not automatically stop Docker Desktop because it cannot assume
that unrelated operator containers may be interrupted.

On Windows, Docker Desktop's first setup or service startup can require an
administrator action in the desktop app. Hawk can request start and stop
operations, but it never bypasses Windows elevation or Docker's own security
controls.

Example arguments for `hawk_parallel_start`:

```json
{
  "image": "hawk-worker:local",
  "max_parallel": 4,
  "cpu_per_worker": 1,
  "memory_mb_per_worker": 1024,
  "artifact_mb_per_worker": 512,
  "schedule_strategy": "latency",
  "lease_seconds": 30,
  "agent_instances": [
    {
      "id": "code-agent",
      "capabilities": ["code", "test"],
      "cpu_capacity": 2,
      "memory_mb_capacity": 2048
    },
    {
      "id": "security-agent",
      "capabilities": ["security", "traffic"],
      "cpu_capacity": 2,
      "memory_mb_capacity": 2048
    }
  ],
  "tasks": [
    {
      "id": "auth-surface",
      "title": "Inventory authentication code",
      "required_capabilities": ["security"],
      "preferred_capabilities": ["traffic"],
      "priority": 90,
      "estimated_seconds": 300,
      "command": [
        "sh",
        "-lc",
        "rg -n \"auth|session|token\" /workspace > /output/auth-surface.txt"
      ]
    },
    {
      "id": "api-surface",
      "title": "Inventory API routes",
      "required_capabilities": ["code"],
      "priority": 70,
      "estimated_seconds": 240,
      "command": [
        "sh",
        "-lc",
        "rg -n \"GET|POST|PUT|PATCH|DELETE\" /workspace > /output/api-surface.txt"
      ]
    },
    {
      "id": "summary",
      "title": "Merge worker evidence",
      "depends_on": ["auth-surface", "api-surface"],
      "required_capabilities": ["code"],
      "preferred_capabilities": ["test"],
      "command": [
        "sh",
        "-lc",
        "printf \"Independent worker artifacts are stored beside this task.\\n\" > /output/README.txt"
      ]
    }
  ]
}
```

The `command` array is passed directly to Docker without a host shell. An
image can explicitly use `sh -lc` inside the container when a pipeline is
needed.

## Headless LLM workers

For a custom image that calls a hosted LLM or a model reachable over Docker's
bridge network, the MCP request must opt in:

```json
{
  "network_mode": "bridge",
  "inherit_env": ["OPENAI_API_KEY"],
  "approved_external_access": true
}
```

Hawk passes only the named host variables to Docker and never returns their
values in MCP output or persisted run state. Enabling this option can create
external API usage and cost for every active worker, so keep
`max_parallel`, token limits, and provider budgets explicit.

For local Ollama on Docker Desktop, configure the worker's provider endpoint
as `http://host.docker.internal:11434`; it still requires bridge networking
and explicit approval.

## Long-running behavior

`hawk_parallel_start` returns immediately with a run id. Poll
`hawk_parallel_status` instead of holding one MCP call open for hours. A task
can run for up to 43,200 seconds (12 hours), retry up to three times, and a run
can contain up to 64 tasks with at most 32 active workers.

Hawk atomically writes both a redacted `run.json` and a private `spec.json`. On MCP
restart it restores run history and reattaches to a retained Docker container
by its `hawk.run` and `hawk.task` identity. It waits for the original
container, recovers its exit code, capped logs, and quota-limited artifacts,
then continues the dependency graph. Initialization also removes retained
Hawk-managed containers that belong to this workspace but no longer map to an
active durable task.

If a running container disappeared before recovery, Hawk retries only when
the task explicitly declared an available retry. Otherwise it fails the task
instead of silently repeating a potentially non-idempotent security action.
Machine reboot recovery therefore works for Docker containers configured by
the host to restart or remain available; a container removed by Docker cannot
be reconstructed without an explicitly authorized retry.
