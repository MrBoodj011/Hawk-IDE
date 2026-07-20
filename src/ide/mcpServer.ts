import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DockerDesktopController } from './dockerDesktop.js';
import { DurableMcpTaskStore } from './durableMcpTaskStore.js';
import { importHawkHealthReport } from './hawkReport.js';
import { estimateParallelExecution } from './orchestrationEstimate.js';
import { HawkDockerOrchestrator } from './orchestrator.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import { SandboxVulnerabilityReproducer } from './sandboxReproduction.js';
import { SmartMcpBrain } from './smartBrain.js';
import { createCoreCapabilityExecutor } from './smartExecutor.js';
import { registerSmartMcp } from './smartMcp.js';
import { scanWorkspaceSecurity } from './staticAudit.js';

const SERVER_NAME = 'hawk-ide';
const SERVER_VERSION = '0.7.0';

interface ParsedArgs {
  workspaceRoot: string;
  showHelp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { workspaceRoot: process.cwd(), showHelp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => argv[++index] ?? '';
    if (flag === '--workspace') args.workspaceRoot = resolve(next());
    if (flag === '--help' || flag === '-h') args.showHelp = true;
  }
  return args;
}

function printHelp(): void {
  process.stderr.write(`hawk-ide-mcp ${SERVER_VERSION}

Local Hawk Security IDE analysis and isolated worker orchestration.
Passive tools only parse source files. Parallel worker tools require an
explicit call, use an existing local Docker image, mount the workspace
read-only, and disable container network unless external access is explicitly
approved.

Usage:
  hawk-ide-mcp --workspace <path>

MCP configuration:
  {
    "mcpServers": {
      "hawk": {
        "command": "hawk-ide-mcp",
        "args": ["--workspace", "\${workspaceFolder}"]
      }
    }
  }
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.showHelp) {
    printHelp();
    return;
  }

  const orchestrator = new HawkDockerOrchestrator(args.workspaceRoot);
  await orchestrator.initialize();
  const brainReference: { current?: SmartMcpBrain } = {};
  const executor = createCoreCapabilityExecutor(args.workspaceRoot, orchestrator, () => {
    if (!brainReference.current) throw new Error('Hawk Smart MCP Brain is not initialized');
    return brainReference.current;
  });
  const brain = new SmartMcpBrain(args.workspaceRoot, executor);
  brainReference.current = brain;
  await brain.initialize();
  const reproducer = new SandboxVulnerabilityReproducer(
    args.workspaceRoot,
    brain.store,
    orchestrator,
  );
  const durableTaskStore = new DurableMcpTaskStore(
    brain.store,
    () => new Date(),
    async (taskId, status) => {
      if (status !== 'cancelled') return;
      const mapping = await brain.store.readJson<{ runId: string }>('mcp-task-runs', taskId);
      if (mapping) await brain.runs.control(mapping.runId, 'cancel').catch(() => undefined);
    },
  );
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      taskStore: durableTaskStore,
      capabilities: {
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
      instructions:
        'Hawk is an evidence-driven security IDE for authorized workspaces. Start with hawk_capabilities_search or hawk_context_snapshot. Compile work with hawk_plan_create, respect policy decisions, bind approvals to the exact plan hash, and never promote a static signal without hawk_evidence_verify.',
    },
  );
  const dockerDesktop = new DockerDesktopController();
  brain.runs.onEvent(async (event) => {
    await Promise.allSettled([
      mcp.sendLoggingMessage({
        level: 'info',
        logger: 'hawk.smart-run',
        data: {
          runId: event.runId,
          sequence: event.sequence,
          type: event.type,
          at: event.at,
          hash: event.hash,
        },
      }),
      mcp.server.sendResourceUpdated({ uri: `hawk://run/${event.runId}/events` }),
    ]);
  });
  mcp.registerTool(
    'ide_route_inventory',
    {
      title: 'IDE route inventory',
      description:
        'Passively index Express, Fastify, and Next.js routes in the local workspace. This reads source text only and never starts the application.',
      inputSchema: {
        path_contains: z.string().optional().describe('Optional substring filter for route paths.'),
      },
    },
    async (input) => {
      const inventory = await scanWorkspaceRoutes(args.workspaceRoot);
      const query = input.path_contains?.toLowerCase();
      const routes = query
        ? inventory.routes.filter((route) => route.path.toLowerCase().includes(query))
        : inventory.routes;
      return textResult(JSON.stringify({ sourceFiles: inventory.sourceFiles, routes }, null, 2));
    },
  );
  mcp.registerTool(
    'hawk_supply_chain_health',
    {
      title: 'Hawk supply-chain health',
      description:
        'Read the sanitized local .hawk/health.json import created from a Hawk health report. This never contacts GitHub and does not expose credentials or raw alert payloads.',
      inputSchema: {},
    },
    async () => {
      try {
        const report = importHawkHealthReport(
          JSON.parse(await readFile(join(args.workspaceRoot, '.hawk', 'health.json'), 'utf8')),
        );
        return textResult(JSON.stringify(report, null, 2));
      } catch (err) {
        return textResult(
          JSON.stringify({
            available: false,
            message: `No local Hawk health report: ${errorMessage(err)}`,
          }),
        );
      }
    },
  );
  mcp.registerTool(
    'ide_static_audit',
    {
      title: 'IDE local static audit',
      description:
        'Run a passive, redacted code audit for high-signal insecure patterns. Results are suspected signals requiring manual validation, not confirmed vulnerabilities.',
      inputSchema: {
        severity: z
          .enum(['critical', 'high', 'medium', 'low', 'info'])
          .optional()
          .describe('Optional exact severity filter.'),
      },
    },
    async (input) => {
      const report = await scanWorkspaceSecurity(args.workspaceRoot);
      const severity = input.severity;
      const findings = severity
        ? report.findings.filter((finding) => finding.severity === severity)
        : report.findings;
      return textResult(
        JSON.stringify(
          {
            scannedAt: report.scannedAt,
            sourceFiles: report.sourceFiles,
            validationRequired: true,
            findings,
          },
          null,
          2,
        ),
      );
    },
  );
  mcp.registerTool(
    'hawk_reproduction_plan',
    {
      title: 'Plan an offline sandbox reproduction',
      description:
        'Create an expiring, hash-bound plan for a supported static finding. The plan uses an existing local Docker image, a read-only workspace, no network, dropped capabilities, and bounded resources. Planning does not execute code.',
      inputSchema: {
        finding_id: z.string().min(1).max(256),
        image: z.string().min(1).max(256).optional().default('hawk-worker:local'),
      },
    },
    async (input) => {
      try {
        const report = await scanWorkspaceSecurity(args.workspaceRoot);
        const finding = report.findings.find((candidate) => candidate.id === input.finding_id);
        if (!finding) throw new Error(`Current static finding not found: ${input.finding_id}`);
        return textResult(
          JSON.stringify(await reproducer.createPlan(finding, input.image), null, 2),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_reproduction_execute',
    {
      title: 'Execute an approved offline sandbox reproduction',
      description:
        'Execute the exact approved plan through baseline, safe negative-control, and deterministic reproduction gates. A reproduced signal remains unverified until independent identity, impact, scope, and review gates pass.',
      inputSchema: {
        finding_id: z.string().min(1).max(256),
        plan_id: z.string().regex(/^repro-plan-[a-f0-9-]{36}$/),
        plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
        approved: z.literal(true),
      },
    },
    async (input) => {
      try {
        const report = await scanWorkspaceSecurity(args.workspaceRoot);
        const finding = report.findings.find((candidate) => candidate.id === input.finding_id);
        if (!finding) throw new Error(`Current static finding not found: ${input.finding_id}`);
        return textResult(
          JSON.stringify(
            await reproducer.execute(finding, {
              planId: input.plan_id,
              planHash: input.plan_hash,
              approved: input.approved,
            }),
            null,
            2,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_reproductions_list',
    {
      title: 'List sandbox reproduction history',
      description:
        'List persisted offline reproduction attempts and their proof-gate status. Results never imply that a vulnerability was independently verified.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
    },
    async (input) =>
      textResult(JSON.stringify({ reproductions: await reproducer.list(input.limit) }, null, 2)),
  );
  mcp.registerTool(
    'hawk_parallel_estimate',
    {
      title: 'Estimate a Hawk parallel task graph',
      description:
        'Estimate the scheduling floor, critical path, and theoretical speedup for a proposed dependency graph before starting containers. This is advisory and does not execute work.',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              estimated_minutes: z.number().positive().max(43_200),
              depends_on: z.array(z.string()).max(32).optional(),
            }),
          )
          .min(1)
          .max(64),
        max_parallel: z.number().int().min(1).max(32),
        startup_seconds_per_task: z.number().nonnegative().max(300).optional(),
      },
    },
    async (input) => {
      try {
        return textResult(
          JSON.stringify(
            estimateParallelExecution(
              input.tasks.map((task) => ({
                id: task.id,
                estimatedMinutes: task.estimated_minutes,
                dependsOn: task.depends_on,
              })),
              input.max_parallel,
              input.startup_seconds_per_task,
            ),
            null,
            2,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_parallel_runtime',
    {
      title: 'Hawk parallel runtime status',
      description:
        'Check whether the local Docker daemon is ready for isolated Hawk worker orchestration. This does not start containers.',
      inputSchema: {},
    },
    async () => {
      const runtime = await orchestrator.availability();
      return textResult(
        JSON.stringify(
          {
            ...runtime,
            scheduler: orchestrator.schedulerStatus(),
            isolation: {
              workspace: 'read-only',
              output: '.hawk/orchestrations/<run>/<task>',
              network: 'none by default; bridge requires explicit approval',
              capabilities: 'dropped',
            },
          },
          null,
          2,
        ),
      );
    },
  );
  mcp.registerTool(
    'hawk_scheduler_status',
    {
      title: 'Inspect the distributed Hawk agent scheduler',
      description:
        'Read Docker agent instances, capabilities, health, load, resource reservations, leases, and recent placement decisions without changing runtime state.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(orchestrator.schedulerStatus(), null, 2)),
  );
  mcp.registerTool(
    'hawk_docker_desktop_status',
    {
      title: 'Read Docker Desktop lifecycle status',
      description:
        'Read Docker Desktop application status without starting or stopping it. Use this after an asynchronous lifecycle request.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(await dockerDesktop.status(), null, 2)),
  );
  mcp.registerTool(
    'hawk_docker_desktop_start',
    {
      title: 'Start Docker Desktop for Hawk workers',
      description:
        'Request an asynchronous start of the local Docker Desktop engine. This changes host application state and requires explicit operator approval. Poll hawk_parallel_runtime until workers are available.',
      inputSchema: {
        approved: z
          .literal(true)
          .describe('Explicit confirmation that Docker Desktop may be started on this host.'),
      },
    },
    async () => {
      try {
        return textResult(JSON.stringify(await dockerDesktop.start(), null, 2));
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_docker_desktop_stop',
    {
      title: 'Stop Docker Desktop after Hawk work',
      description:
        'Stop Docker Desktop after worker runs finish. This can stop unrelated containers owned by the operator, so the caller must explicitly acknowledge that impact. Refuses while Hawk runs are active unless force is true.',
      inputSchema: {
        approved: z.literal(true),
        acknowledge_stops_other_containers: z.literal(true),
        force: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        const active = orchestrator
          .list()
          .filter((run) => run.status === 'queued' || run.status === 'running');
        if (active.length > 0 && input.force !== true) {
          throw new Error(
            `Docker Desktop cannot stop while ${active.length} Hawk run(s) are active; cancel them or set force`,
          );
        }
        if (active.length > 0) {
          await Promise.all(active.map((run) => orchestrator.cancel(run.id)));
        }
        return textResult(JSON.stringify(await dockerDesktop.stop(input.force === true), null, 2));
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_parallel_start',
    {
      title: 'Start isolated parallel Hawk workers',
      description:
        'Start a background dependency graph of independent tasks in isolated Docker containers. The image must already exist locally. Workers receive a read-only workspace, write only to per-task artifact folders, use CPU/RAM/PID/time limits, and are removed when done. Network and credential inheritance are off by default and require explicit external-access approval. Use this only for authorized work.',
      inputSchema: {
        image: z
          .string()
          .min(1)
          .max(255)
          .describe('Existing local Docker image. Hawk never pulls images automatically.'),
        tasks: z
          .array(
            z.object({
              id: z
                .string()
                .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
                .describe('Unique stable task id.'),
              title: z.string().min(1).max(160),
              command: z
                .array(z.string().min(1).max(4096))
                .min(1)
                .max(64)
                .describe('Executable and arguments passed directly without a host shell.'),
              depends_on: z.array(z.string()).max(32).optional(),
              timeout_seconds: z.number().int().min(10).max(43_200).optional(),
              retries: z.number().int().min(0).max(3).optional(),
              required_capabilities: z
                .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/))
                .max(16)
                .optional(),
              preferred_capabilities: z
                .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/))
                .max(16)
                .optional(),
              priority: z.number().int().min(0).max(100).optional(),
              estimated_seconds: z.number().int().min(1).max(86_400).optional(),
            }),
          )
          .min(1)
          .max(64),
        max_parallel: z.number().int().min(1).max(32).optional(),
        cpu_per_worker: z.number().min(0.25).max(8).optional(),
        memory_mb_per_worker: z.number().int().min(128).max(16_384).optional(),
        artifact_mb_per_worker: z
          .number()
          .int()
          .min(32)
          .max(4_096)
          .optional()
          .describe('Hard tmpfs ceiling for one worker artifact directory. Defaults to 512 MB.'),
        network_mode: z
          .enum(['none', 'bridge'])
          .optional()
          .describe(
            'Container network mode. Defaults to none. Bridge requires approved_external_access.',
          ),
        inherit_env: z
          .array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/))
          .max(16)
          .optional()
          .describe(
            'Names of host environment variables to pass into workers. Values are never returned by Hawk. Requires approved_external_access.',
          ),
        approved_external_access: z
          .boolean()
          .optional()
          .describe(
            'Must be true to enable network access or inherit credentials. This can trigger external API usage and cost across every parallel worker.',
          ),
        schedule_strategy: z.enum(['balanced', 'latency', 'throughput']).optional(),
        lease_seconds: z.number().int().min(15).max(600).optional(),
        agent_instances: z
          .array(
            z.object({
              id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
              capabilities: z
                .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/))
                .max(32)
                .optional(),
              max_concurrent: z.number().int().min(1).max(8).optional(),
              cpu_capacity: z.number().min(0.25).max(64).optional(),
              memory_mb_capacity: z.number().int().min(128).max(65_536).optional(),
            }),
          )
          .max(32)
          .optional()
          .describe(
            'Optional logical Docker agent pool. Every assignment still launches a separate isolated task container.',
          ),
      },
    },
    async (input) => {
      try {
        const run = await orchestrator.start({
          image: input.image,
          tasks: input.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            command: task.command,
            dependsOn: task.depends_on,
            timeoutSeconds: task.timeout_seconds,
            retries: task.retries,
            requiredCapabilities: task.required_capabilities,
            preferredCapabilities: task.preferred_capabilities,
            priority: task.priority,
            estimatedSeconds: task.estimated_seconds,
          })),
          maxParallel: input.max_parallel,
          cpuPerWorker: input.cpu_per_worker,
          memoryMbPerWorker: input.memory_mb_per_worker,
          artifactMbPerWorker: input.artifact_mb_per_worker,
          networkMode: input.network_mode,
          inheritEnv: input.inherit_env,
          approvedExternalAccess: input.approved_external_access,
          scheduleStrategy: input.schedule_strategy,
          leaseSeconds: input.lease_seconds,
          agentInstances: input.agent_instances?.map((instance) => ({
            id: instance.id,
            capabilities: instance.capabilities,
            maxConcurrent: instance.max_concurrent,
            cpuCapacity: instance.cpu_capacity,
            memoryMbCapacity: instance.memory_mb_capacity,
          })),
        });
        return textResult(JSON.stringify(run, null, 2));
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_parallel_status',
    {
      title: 'Read a Hawk parallel run',
      description:
        'Read progress, task states, exit codes, artifact folders, and optionally capped local worker output for one background run.',
      inputSchema: {
        run_id: z.string().min(1),
        include_output: z.boolean().optional(),
      },
    },
    async (input) => {
      const run = orchestrator.get(input.run_id, input.include_output === true);
      return run
        ? textResult(JSON.stringify(run, null, 2))
        : toolError(new Error(`Unknown orchestration run: ${input.run_id}`));
    },
  );
  mcp.registerTool(
    'hawk_parallel_runs',
    {
      title: 'List Hawk parallel runs',
      description:
        'List restored and current background orchestration runs for this workspace. Worker output is omitted.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify({ runs: orchestrator.list() }, null, 2)),
  );
  mcp.registerTool(
    'hawk_parallel_cancel',
    {
      title: 'Cancel a Hawk parallel run',
      description:
        'Cancel pending work and force-remove running containers for one Hawk orchestration run.',
      inputSchema: { run_id: z.string().min(1) },
    },
    async (input) => {
      try {
        return textResult(JSON.stringify(await orchestrator.cancel(input.run_id), null, 2));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  registerSmartMcp(mcp, brain, args.workspaceRoot, orchestrator, durableTaskStore);
  await mcp.connect(new StdioServerTransport());
  const shutdown = (): void => {
    void Promise.allSettled([brain.runs.shutdown(), reproducer.shutdown()]).finally(() =>
      process.exit(0),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>(() => undefined);
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function toolError(err: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: errorMessage(err) }],
  };
}

main().catch((err: unknown) => {
  process.stderr.write(`[hawk-ide-mcp] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
