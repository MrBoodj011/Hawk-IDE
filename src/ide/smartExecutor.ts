import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importHawkHealthReport } from './hawkReport.js';
import type { HawkDockerOrchestrator, OrchestrationSnapshot } from './orchestrator.js';
import type { ProofEdgeInput, ProofNodeInput } from './proofGraph.js';
import type { HawkHealthReport, TrafficInventory, WorkspaceRoute } from './protocol.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import type { SmartMcpBrain } from './smartBrain.js';
import type { CapabilityExecutionContext, CapabilityExecutionResult } from './smartRunEngine.js';
import { scanWorkspaceSecurity } from './staticAudit.js';

export function createCoreCapabilityExecutor(
  workspaceRoot: string,
  orchestrator: HawkDockerOrchestrator,
  getBrain: () => SmartMcpBrain,
) {
  return async (context: CapabilityExecutionContext): Promise<CapabilityExecutionResult> => {
    const result = await execute(workspaceRoot, orchestrator, getBrain(), context);
    const inspected = getBrain().sentinel.inspectResult(result.output);
    if (!inspected.safe)
      throw new Error(
        `Capability output was blocked by MCP Sentinel: ${inspected.findings
          .map((finding) => finding.message)
          .join('; ')}`,
      );
    return { ...result, output: inspected.redacted };
  };
}

async function execute(
  workspaceRoot: string,
  orchestrator: HawkDockerOrchestrator,
  brain: SmartMcpBrain,
  context: CapabilityExecutionContext,
): Promise<CapabilityExecutionResult> {
  switch (context.node.capabilityId) {
    case 'context.workspace.snapshot': {
      const [routes, audit, traffic, health] = await Promise.all([
        scanWorkspaceRoutes(workspaceRoot),
        scanWorkspaceSecurity(workspaceRoot),
        readTraffic(workspaceRoot),
        readHealth(workspaceRoot),
      ]);
      return {
        summary: 'Redacted local workspace context snapshot created',
        output: {
          sourceFiles: Math.max(routes.sourceFiles, audit.sourceFiles),
          routes: routes.routes.length,
          signals: audit.findings.length,
          trafficRequests: traffic?.requests.length ?? 0,
          trafficHosts: traffic?.hosts ?? [],
          repositories: health?.summary.repositories ?? 0,
          generatedAt: new Date().toISOString(),
        },
      };
    }
    case 'code.route.inventory': {
      const inventory = await scanWorkspaceRoutes(workspaceRoot);
      return {
        summary: `Mapped ${inventory.routes.length} source routes`,
        output: inventory,
      };
    }
    case 'code.static.audit': {
      const audit = await scanWorkspaceSecurity(workspaceRoot);
      return {
        summary: `Recorded ${audit.findings.length} unverified static signals`,
        output: { ...audit, validationRequired: true },
      };
    }
    case 'traffic.source.correlate': {
      const [inventory, traffic] = await Promise.all([
        scanWorkspaceRoutes(workspaceRoot),
        readTraffic(workspaceRoot),
      ]);
      const correlations = correlate(inventory.routes, traffic);
      return {
        summary: `Correlated ${correlations.length} imported requests to source routes`,
        output: {
          correlations,
          unmatchedRequests: Math.max(0, (traffic?.requests.length ?? 0) - correlations.length),
          replayedRequests: 0,
        },
      };
    }
    case 'supply-chain.health': {
      const report = await readHealth(workspaceRoot);
      return {
        summary: report
          ? `Loaded sanitized posture for ${report.summary.repositories} repositories`
          : 'No local Hawk supply-chain report is available',
        output: report ?? { available: false },
      };
    }
    case 'proof.graph.build': {
      const [routes, audit, traffic] = await Promise.all([
        scanWorkspaceRoutes(workspaceRoot),
        scanWorkspaceSecurity(workspaceRoot),
        readTraffic(workspaceRoot),
      ]);
      const nodes: ProofNodeInput[] = [
        {
          id: 'repository-workspace',
          kind: 'repository',
          label: 'Current workspace',
          attributes: {
            sourceFiles: Math.max(routes.sourceFiles, audit.sourceFiles),
          },
        },
      ];
      const edges: ProofEdgeInput[] = [];
      for (const route of routes.routes.slice(0, 2_000)) {
        const routeId = routeNodeId(route);
        const fileId = `file-${shortHash(route.file)}`;
        nodes.push(
          { id: fileId, kind: 'file', label: route.file, attributes: { file: route.file } },
          {
            id: routeId,
            kind: 'route',
            label: `${route.method} ${route.path}`,
            attributes: {
              method: route.method,
              path: route.path,
              line: route.line,
            },
          },
        );
        edges.push(
          { from: fileId, to: routeId, relation: 'declares' },
          { from: 'repository-workspace', to: fileId, relation: 'contains' },
        );
      }
      for (const finding of audit.findings.slice(0, 2_000)) {
        nodes.push({
          id: finding.id,
          kind: 'finding',
          label: finding.title,
          attributes: {
            severity: finding.severity,
            lifecycle: 'signal',
          },
        });
        if (finding.source) {
          const fileId = `file-${shortHash(finding.source.file)}`;
          nodes.push({
            id: fileId,
            kind: 'file',
            label: finding.source.file,
            attributes: { file: finding.source.file },
          });
          edges.push(
            { from: fileId, to: finding.id, relation: 'contains-signal' },
            { from: 'repository-workspace', to: fileId, relation: 'contains' },
          );
        }
      }
      for (const request of traffic?.requests.slice(0, 2_000) ?? []) {
        nodes.push({
          id: request.id,
          kind: 'request',
          label: `${request.method} ${request.url}`,
          attributes: {
            method: request.method,
            host: request.host,
            status: request.status ?? 0,
          },
        });
      }
      for (const match of correlate(routes.routes, traffic)) {
        const route = routes.routes.find(
          (candidate) =>
            candidate.method === match.method &&
            candidate.path === match.route &&
            candidate.file === match.sourceFile &&
            candidate.line === match.sourceLine,
        );
        if (route)
          edges.push({
            from: match.requestId,
            to: routeNodeId(route),
            relation: 'correlates-to',
          });
      }
      const graph = await brain.graph.merge(nodes, edges);
      return {
        summary: `ProofGraph contains ${graph.nodes.length} nodes and ${graph.edges.length} edges`,
        output: {
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          resourceUri: 'hawk://workspace/graph',
        },
      };
    }
    case 'evidence.independent.verify':
      return {
        summary: 'Verification gates initialized; no signal was auto-promoted',
        output: {
          autoPromoted: 0,
          requiredGates: [
            'baseline',
            'reproduction',
            'independent reproduction',
            'valid identity',
            'demonstrated impact',
            'declared scope',
            'safe side effects',
            'redacted evidence',
          ],
          nextTool: 'hawk_evidence_verify',
        },
      };
    case 'runtime.authorized.validate':
    case 'patch.candidate.generate':
    case 'patch.regression.validate':
      return await executeDockerCapability(orchestrator, context);
    default:
      throw new Error(`No executor is installed for capability: ${context.node.capabilityId}`);
  }
}

async function executeDockerCapability(
  orchestrator: HawkDockerOrchestrator,
  context: CapabilityExecutionContext,
): Promise<CapabilityExecutionResult> {
  if (context.signal.aborted) throw new Error('Capability was cancelled before launch');
  const input = dockerInput(context.input);
  const activeRuntime = context.node.capabilityId === 'runtime.authorized.validate';
  if (
    activeRuntime &&
    input.networkMode === 'bridge' &&
    input.acknowledgeUnrestrictedBridge !== true
  )
    throw new Error(
      'Docker bridge is not host-restricted; set acknowledge_unrestricted_bridge only after exact scope approval',
    );
  const run = await orchestrator.start({
    image: input.image,
    tasks: [
      {
        id: context.node.capabilityId.replaceAll('.', '-'),
        title: context.node.title,
        command: input.command,
        timeoutSeconds: input.timeoutSeconds,
        retries: 0,
      },
    ],
    maxParallel: 1,
    networkMode: input.networkMode,
    approvedExternalAccess: input.networkMode === 'bridge',
  });
  const completed = await waitForOrchestration(
    orchestrator,
    run.id,
    input.timeoutSeconds + 30,
    context.signal,
  );
  if (completed.status !== 'succeeded')
    throw new Error(`Docker capability ended with ${completed.status}`);
  const task = completed.tasks[0];
  return {
    summary: `Isolated worker completed ${context.node.title}`,
    output: {
      orchestrationRunId: completed.id,
      status: completed.status,
      artifactDirectory: task?.artifactDirectory,
      exitCode: task?.exitCode,
      output: task?.output,
      outputTruncated: task?.outputTruncated,
    },
  };
}

function dockerInput(value: unknown): {
  image: string;
  command: string[];
  timeoutSeconds: number;
  networkMode: 'none' | 'bridge';
  acknowledgeUnrestrictedBridge: boolean;
} {
  if (!value || typeof value !== 'object')
    throw new Error('This capability needs an execution input with image and command');
  const input = value as Record<string, unknown>;
  if (typeof input.image !== 'string' || !input.image)
    throw new Error('Docker capability input.image is required');
  if (
    !Array.isArray(input.command) ||
    input.command.length === 0 ||
    !input.command.every((item) => typeof item === 'string' && item.length > 0)
  )
    throw new Error('Docker capability input.command must be a non-empty string array');
  return {
    image: input.image,
    command: input.command as string[],
    timeoutSeconds:
      typeof input.timeout_seconds === 'number'
        ? Math.max(10, Math.min(Math.floor(input.timeout_seconds), 43_200))
        : 1_800,
    networkMode: input.network_mode === 'bridge' ? 'bridge' : 'none',
    acknowledgeUnrestrictedBridge: input.acknowledge_unrestricted_bridge === true,
  };
}

async function waitForOrchestration(
  orchestrator: HawkDockerOrchestrator,
  runId: string,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<OrchestrationSnapshot> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      await orchestrator.cancel(runId);
      throw new Error('Docker capability was cancelled');
    }
    const run = orchestrator.get(runId, true);
    if (!run) throw new Error(`Orchestration disappeared: ${runId}`);
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled')
      return run;
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, 250);
      timer.unref();
    });
  }
  await orchestrator.cancel(runId);
  throw new Error(`Orchestration exceeded ${timeoutSeconds} seconds`);
}

async function readTraffic(workspaceRoot: string): Promise<TrafficInventory | undefined> {
  return await readJson<TrafficInventory>(join(workspaceRoot, '.hawk', 'traffic.json'));
}

async function readHealth(workspaceRoot: string): Promise<HawkHealthReport | undefined> {
  const value = await readJson<unknown>(join(workspaceRoot, '.hawk', 'health.json'));
  if (value === undefined) return undefined;
  try {
    return importHawkHealthReport(value);
  } catch {
    return undefined;
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function correlate(routes: WorkspaceRoute[], traffic: TrafficInventory | undefined) {
  const correlations: Array<{
    requestId: string;
    route: string;
    method: string;
    sourceFile: string;
    sourceLine: number;
    confidence: number;
  }> = [];
  for (const request of traffic?.requests ?? []) {
    let pathname = '';
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      continue;
    }
    const route = routes.find(
      (candidate) =>
        candidate.method === request.method && routePattern(candidate.path).test(pathname),
    );
    if (!route) continue;
    correlations.push({
      requestId: request.id,
      route: route.path,
      method: route.method,
      sourceFile: route.file,
      sourceLine: route.line,
      confidence: route.path === pathname ? 1 : 0.85,
    });
  }
  return correlations;
}

function routePattern(route: string): RegExp {
  const escaped = route
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\:([a-zA-Z0-9_]+)/g, '[^/]+')
    .replace(/\\\[[.]{3}[^\]]+\\\]/g, '.+')
    .replace(/\\\[[^\]]+\\\]/g, '[^/]+');
  return new RegExp(`^${escaped}/?$`);
}

function routeNodeId(route: WorkspaceRoute): string {
  return `route-${shortHash(`${route.method}\u0000${route.path}\u0000${route.file}\u0000${route.line}`)}`;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
