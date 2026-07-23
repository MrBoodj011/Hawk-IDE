import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { startIngestServer } from '../browser/server.js';
import { CaptureStore } from '../browser/store.js';
import { AgentFleetRegistry } from './agentFleet.js';
import type {
  AiApplyRequest,
  AiCheckpointRequest,
  AiCreateSessionRequest,
  AiMergeBatchRequest,
  AiParallelBatchRequest,
  AiReproduceRequest,
  AiRestoreCheckpointRequest,
  AiRunTestsRequest,
} from './aiProtocol.js';
import { AiSessionManager } from './aiSessionManager.js';
import { buildAttackTwin } from './attackTwin.js';
import { AutonomousSecurityService } from './autonomousSecurity.js';
import { runCodingCoreBenchmark } from './codingBenchmark.js';
import { listDockerAgentProfiles } from './dockerAgentProfiles.js';
import { DurableStore } from './durableStore.js';
import { EditPredictionEngine, type EditPredictionFeedback } from './editPredictionEngine.js';
import { buildEvidencePack } from './evidenceReport.js';
import { governancePolicyHash, loadGovernancePolicy } from './governancePolicy.js';
import { GovernedMemory } from './governedMemory.js';
import { createGovernedMission } from './governedMission.js';
import { importHawkHealthReport } from './hawkReport.js';
import {
  type IdentityReplayExecuteInput,
  type IdentityReplayPlanInput,
  IdentityReplayService,
} from './identityReplay.js';
import {
  type EditPredictionRequest,
  type InlineCompletionRequest,
  type MultiFileEditPredictionRequest,
  createInlineCompletion,
} from './inlineCompletion.js';
import { listHawkIntegrations } from './integrationHub.js';
import { listMcpToolGovernance } from './mcpGovernance.js';
import { McpTrustPlatform } from './mcpTrust.js';
import { HawkObservability } from './observability.js';
import { HawkDockerOrchestrator } from './orchestrator.js';
import { analyzePullRequestDiff, pullRequestReportToSarif } from './prSecurityAgent.js';
import { ProofGraph } from './proofGraph.js';
import {
  type DaemonHealth,
  type EvidencePackReport,
  type GenericReproductionScenario,
  type GovernedMissionPlan,
  type GovernedMissionProfile,
  type HawkHealthReport,
  IDE_PROTOCOL_VERSION,
  type RetestResult,
  type SandboxReproductionPlan,
  type SandboxReproductionResult,
  type SecurityFinding,
  type TrafficInventory,
  type WorkspaceInventory,
  type WorkspaceScanPlan,
  type WorkspaceScanReport,
  type WorkspaceScanTemplateId,
  type WorkspaceScanTemplatesResponse,
} from './protocol.js';
import { scanProtocolSurfaces } from './protocolIntelligence.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import {
  type GenericReproductionInput,
  type ReproductionOrchestrator,
  SandboxVulnerabilityReproducer,
} from './sandboxReproduction.js';
import {
  type SecurityAdapterId,
  adapterFingerprint,
  importSarifFindings,
  listSecurityAdapters,
} from './securityAdapters.js';
import { type SecurityBenchmarkSample, summarizeSecurityBenchmark } from './securityBenchmark.js';
import {
  type SecurityGraphDelivery,
  buildUnifiedSecurityGraph,
  securityGraphResponse,
} from './securityGraph.js';
import {
  type SecurityTestTemplateId,
  createSecurityTestPlan,
  listSecurityTestTemplates,
  runApprovedSecurityTest,
} from './securityTesting.js';
import {
  type CreateSecurityToolPlanInput,
  GovernedSecurityToolRunner,
  type SecurityToolRunPlan,
} from './securityToolRunner.js';
import { SemanticWorkspaceIndex } from './semanticIndex.js';
import { scanWorkspaceSecurity } from './staticAudit.js';
import {
  importHarTraffic,
  importLiveTraffic,
  liveTrafficRequestId,
  mergeTrafficInventories,
} from './traffic.js';
import {
  createWorkspaceScanPlan,
  createWorkspaceScanTemplates,
  runApprovedWorkspaceScan,
} from './workspaceScan.js';

const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;
// Bound control-plane connections so a local client cannot hold sockets forever.
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

export interface IdeDaemonOptions {
  workspaceRoot?: string;
  host?: string;
  port?: number;
  token?: string;
  now?: () => Date;
  reproductionOrchestrator?: ReproductionOrchestrator;
}

export interface IdeDaemonHandle {
  host: string;
  port: number;
  url: string;
  token: string;
  captureUrl: string;
  captureToken: string;
  close(): Promise<void>;
  inventory(): WorkspaceInventory | null;
}

/**
 * Local control plane for the future Code-OSS client. It binds to loopback
 * only, protects every endpoint with a process-scoped token, and keeps the
 * initial surface deliberately small while the desktop UI is built.
 */
export async function startIdeDaemon(opts: IdeDaemonOptions = {}): Promise<IdeDaemonHandle> {
  const host = opts.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) throw new Error('IDE daemon may only bind to a loopback host');
  const workspaceRoot = resolve(opts.workspaceRoot ?? process.cwd());
  const token = opts.token ?? randomBytes(32).toString('base64url');
  const now = opts.now ?? (() => new Date());
  let latestInventory: WorkspaceInventory | null = null;
  let latestProtocols: Awaited<ReturnType<typeof scanProtocolSurfaces>> | null = null;
  let findings: SecurityFinding[] = [];
  let importedTraffic: TrafficInventory | null = null;
  const evidencePacks: EvidencePackReport[] = [];
  let hawkHealth = await loadStoredHawkHealthReport(workspaceRoot, now);
  const durableStore = new DurableStore(workspaceRoot);
  const deliveries: SecurityGraphDelivery[] = await durableStore.listJson<SecurityGraphDelivery>(
    'security-graph-deliveries',
  );
  const autonomousSecurity = new AutonomousSecurityService(workspaceRoot, durableStore, now);
  const agentFleet = new AgentFleetRegistry(durableStore, now);
  const governedMemory = new GovernedMemory(durableStore, now);
  const mcpTrust = new McpTrustPlatform(durableStore, now);
  const observability = new HawkObservability(now);
  const proofGraph = new ProofGraph(durableStore, now);
  const reproductionOrchestrator =
    opts.reproductionOrchestrator ?? new HawkDockerOrchestrator(workspaceRoot);
  const reproducer = new SandboxVulnerabilityReproducer(
    workspaceRoot,
    durableStore,
    reproductionOrchestrator,
    now,
  );
  const securityToolRunner = new GovernedSecurityToolRunner({
    workspaceRoot,
    store: durableStore,
    orchestrator: reproductionOrchestrator,
    now,
  });
  const aiSessions = new AiSessionManager({ workspaceRoot, now, governedMemory });
  await aiSessions.initialize();
  const semanticIndex = new SemanticWorkspaceIndex(workspaceRoot, {
    embeddings: {
      enabled: process.env.HAWK_IDE_EMBEDDINGS === '1',
      baseUrl: process.env.HAWK_IDE_EMBEDDING_BASE_URL,
      model: process.env.HAWK_IDE_EMBEDDING_MODEL,
    },
  });
  const editPredictions = new EditPredictionEngine(workspaceRoot, semanticIndex);
  await editPredictions.initialize();
  const completionLatencies: number[] = [];
  const captureStore = new CaptureStore({ maxEntries: 5_000 });
  const identityReplay = new IdentityReplayService(
    (id) =>
      captureStore.getRequest(id) ??
      captureStore
        .listRequests({ limit: 5_000 })
        .find((entry) => liveTrafficRequestId(entry) === id),
    now,
  );
  const captureServer = await startIngestServer({
    store: captureStore,
    port: 0,
  });

  const server = createServer((req, res) => {
    const trace = observability.start(req.method, req.url);
    res.setHeader('X-Hawk-Trace-Id', trace.id);
    let recorded = false;
    const record = (status: number) => {
      if (recorded) return;
      recorded = true;
      observability.finish(trace, status);
    };
    res.once('finish', () => record(res.statusCode || 500));
    res.once('close', () => record(res.writableEnded ? res.statusCode || 500 : 499));
    void handleRequest(req, res, {
      token,
      workspaceRoot,
      now,
      inventory: () => latestInventory,
      setInventory: (value) => {
        latestInventory = value;
      },
      protocols: () => latestProtocols,
      setProtocols: (value) => {
        latestProtocols = value;
      },
      findings: () => findings,
      setFindings: (value) => {
        findings = value;
      },
      traffic: () =>
        mergeTrafficInventories(
          importedTraffic,
          importLiveTraffic(captureStore.listRequests({ limit: 1_500 }), now()),
          now(),
        ),
      setTraffic: (value) => {
        importedTraffic = value;
      },
      evidencePacks: () => [...evidencePacks],
      addEvidencePack: (value) => {
        evidencePacks.push(value);
        if (evidencePacks.length > 20) evidencePacks.shift();
      },
      deliveries: () => [...deliveries],
      addDelivery: (value) => {
        deliveries.push(value);
        if (deliveries.length > 100) deliveries.shift();
        void durableStore.writeJson('security-graph-deliveries', value.id, value);
      },
      hawkHealth: () => hawkHealth,
      setHawkHealth: async (value) => {
        await persistHawkHealthReport(workspaceRoot, value);
        hawkHealth = value;
      },
      aiSessions,
      proofGraph,
      reproducer,
      semanticIndex,
      editPredictions,
      completionLatencies: () => [...completionLatencies],
      identityReplay,
      observability,
      autonomousSecurity,
      agentFleet,
      governedMemory,
      securityToolRunner,
      mcpTrust,
      recordCompletionLatency: (latencyMs) => {
        completionLatencies.push(latencyMs);
        if (completionLatencies.length > 100) completionLatencies.shift();
      },
    }).catch((error) => {
      if (!res.headersSent) {
        sendJSON(res, 500, { ok: false, error: errorMessage(error), traceId: trace.id });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  return await new Promise<IdeDaemonHandle>((resolveHandle, reject) => {
    server.once('error', (err) => {
      void captureServer.close();
      reject(err);
    });
    server.listen(opts.port ?? 0, host, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : (opts.port ?? 0);
      const url = `http://${host}:${port}`;
      resolveHandle({
        host,
        port,
        url,
        token,
        captureUrl: captureServer.url,
        captureToken: captureServer.token,
        inventory: () => latestInventory,
        close: async () => {
          await Promise.all([
            aiSessions.dispose(),
            editPredictions.dispose(),
            reproducer.shutdown(),
          ]);
          await Promise.all([closeServer(server), captureServer.close()]);
        },
      });
    });
  });
}

interface RequestContext {
  token: string;
  workspaceRoot: string;
  now: () => Date;
  inventory: () => WorkspaceInventory | null;
  setInventory(value: WorkspaceInventory): void;
  protocols(): Awaited<ReturnType<typeof scanProtocolSurfaces>> | null;
  setProtocols(value: Awaited<ReturnType<typeof scanProtocolSurfaces>>): void;
  findings(): SecurityFinding[];
  setFindings(value: SecurityFinding[]): void;
  traffic(): TrafficInventory | null;
  setTraffic(value: TrafficInventory): void;
  evidencePacks(): EvidencePackReport[];
  addEvidencePack(value: EvidencePackReport): void;
  deliveries(): SecurityGraphDelivery[];
  addDelivery(value: SecurityGraphDelivery): void;
  hawkHealth(): HawkHealthReport | null;
  setHawkHealth(value: HawkHealthReport): Promise<void>;
  aiSessions: AiSessionManager;
  proofGraph: ProofGraph;
  reproducer: SandboxVulnerabilityReproducer;
  securityToolRunner: GovernedSecurityToolRunner;
  semanticIndex: SemanticWorkspaceIndex;
  editPredictions: EditPredictionEngine;
  identityReplay: IdentityReplayService;
  observability: HawkObservability;
  autonomousSecurity: AutonomousSecurityService;
  agentFleet: AgentFleetRegistry;
  governedMemory: GovernedMemory;
  mcpTrust: McpTrustPlatform;
  completionLatencies(): number[];
  recordCompletionLatency(latencyMs: number): void;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: RequestContext,
): Promise<void> {
  if (!validLoopbackHost(req)) {
    sendJSON(res, 403, { ok: false, error: 'invalid host' });
    return;
  }
  if (!authorized(req, context.token)) {
    sendJSON(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  const requestURL = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = requestURL.pathname;

  if (req.method === 'GET' && pathname === '/v1/health') {
    const health: DaemonHealth = {
      ok: true,
      protocolVersion: IDE_PROTOCOL_VERSION,
      workspaceRoot: context.workspaceRoot,
    };
    sendJSON(res, 200, health);
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/workspace/index') {
    try {
      await consumeBody(req);
      const [scan] = await Promise.all([
        scanWorkspaceRoutes(context.workspaceRoot),
        context.semanticIndex.build(),
      ]);
      const inventory: WorkspaceInventory = {
        protocolVersion: IDE_PROTOCOL_VERSION,
        root: context.workspaceRoot,
        indexedAt: context.now().toISOString(),
        sourceFiles: scan.sourceFiles,
        routes: scan.routes,
      };
      context.setInventory(inventory);
      sendJSON(res, 200, inventory);
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/workspace/semantic-index') {
    try {
      await consumeBody(req);
      sendJSON(res, 200, await context.semanticIndex.build());
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'PUT' && pathname === '/v1/workspace/semantic-index/file') {
    try {
      const input = parseJSONBody<{ file?: string }>(await readBody(req));
      if (typeof input.file !== 'string' || !input.file.trim()) throw new Error('file is required');
      sendJSON(res, 200, await context.semanticIndex.updateFile(input.file));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'DELETE' && pathname === '/v1/workspace/semantic-index/file') {
    try {
      const input = parseJSONBody<{ file?: string }>(await readBody(req));
      if (typeof input.file !== 'string' || !input.file.trim()) throw new Error('file is required');
      sendJSON(res, 200, await context.semanticIndex.removeFile(input.file));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/workspace/semantic-index') {
    const stats = context.semanticIndex.stats();
    if (!stats) {
      sendJSON(res, 404, { ok: false, error: 'semantic workspace index has not been built yet' });
      return;
    }
    sendJSON(res, 200, stats);
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/workspace/search') {
    try {
      const input = parseJSONBody<{ query?: string; limit?: number }>(await readBody(req));
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) throw new Error('query is required');
      await context.semanticIndex.ensureBuilt();
      sendJSON(res, 200, {
        query,
        results: await context.semanticIndex.searchHybrid(query, input.limit),
        stats: context.semanticIndex.stats(),
      });
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/ai/inline-completion') {
    try {
      const input = parseJSONBody<InlineCompletionRequest>(await readBody(req));
      const completion = await createInlineCompletion(input, context.semanticIndex);
      context.recordCompletionLatency(completion.latencyMs);
      sendJSON(res, 200, completion);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/ai/edit-prediction') {
    try {
      const input = parseJSONBody<EditPredictionRequest>(await readBody(req));
      const prediction = await context.editPredictions.predict(input);
      context.recordCompletionLatency(prediction.latencyMs);
      sendJSON(res, 200, prediction);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/ai/edit-prediction/multi-file') {
    try {
      const input = parseJSONBody<MultiFileEditPredictionRequest>(await readBody(req));
      const prediction = await context.editPredictions.predictMultiFile(input);
      context.recordCompletionLatency(prediction.latencyMs);
      sendJSON(res, 200, prediction);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/ai/edit-prediction/feedback') {
    try {
      const input = parseJSONBody<EditPredictionFeedback>(await readBody(req));
      if (
        typeof input.predictionId !== 'string' ||
        (input.outcome !== 'accepted' && input.outcome !== 'rejected')
      ) {
        throw new Error('predictionId and a valid outcome are required');
      }
      sendJSON(res, 200, context.editPredictions.recordFeedback(input));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/ai/edit-prediction/evaluation') {
    sendJSON(res, 200, context.editPredictions.report());
    return;
  }

  if (req.method === 'DELETE' && pathname === '/v1/ai/edit-prediction/cache') {
    context.editPredictions.clearCache();
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/diagnostics/coding-core') {
    try {
      await consumeBody(req);
      sendJSON(
        res,
        200,
        await runCodingCoreBenchmark(context.semanticIndex, context.completionLatencies()),
      );
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/diagnostics/metrics') {
    sendJSON(res, 200, context.observability.snapshot());
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/diagnostics/bundle') {
    try {
      const input = parseJSONBody<{ approved?: boolean }>(await readBody(req));
      sendJSON(
        res,
        201,
        await context.observability.buildDebugBundle({
          approved: input.approved === true,
          workspaceRoot: context.workspaceRoot,
          extra: {
            protocolVersion: IDE_PROTOCOL_VERSION,
            semanticIndex: context.semanticIndex.stats() ?? null,
            aiSessions: (await context.aiSessions.list(100)).length,
            findings: context.findings().length,
            trafficRecords: context.traffic()?.requests.length ?? 0,
            reproductions: (await context.reproducer.list(100)).length,
          },
        }),
      );
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/workspace/inventory') {
    const inventory = context.inventory();
    if (!inventory) {
      sendJSON(res, 404, { ok: false, error: 'workspace has not been indexed yet' });
      return;
    }
    sendJSON(res, 200, inventory);
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/findings') {
    sendJSON(res, 200, { findings: context.findings() });
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/security/adapters') {
    sendJSON(res, 200, {
      protocolVersion: IDE_PROTOCOL_VERSION,
      fingerprint: adapterFingerprint(),
      adapters: listSecurityAdapters(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/integrations') {
    sendJSON(res, 200, {
      protocolVersion: IDE_PROTOCOL_VERSION,
      integrations: listHawkIntegrations(),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/security/import') {
    try {
      const input = parseSecurityImportRequest(await readBody(req));
      const imported = importSarifFindings(
        input.adapter,
        input.document,
        input.source,
        context.now(),
      );
      const existing = context
        .findings()
        .filter((finding) => !finding.id.startsWith(`external-${input.adapter}-`));
      context.setFindings([...existing, ...imported.findings]);
      sendJSON(res, 201, imported);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/security/adapter/plan') {
    try {
      const input = parseSecurityToolPlanRequest(await readBody(req));
      sendJSON(res, 201, await context.securityToolRunner.createPlan(input));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/security/adapter/run') {
    try {
      const input = parseSecurityToolRunRequest(await readBody(req));
      const result = await context.securityToolRunner.execute(input.plan, true);
      if (result.findings.length) {
        const existing = context
          .findings()
          .filter((finding) => !finding.id.startsWith(`external-${result.adapter}-`));
        context.setFindings([...existing, ...result.findings]);
      }
      sendJSON(res, 200, result);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/benchmarks/security') {
    try {
      const request = parseJSONBody<Record<string, unknown>>(await readBody(req));
      if (!Array.isArray(request.samples)) throw new Error('Benchmark samples are required');
      const samples = request.samples as SecurityBenchmarkSample[];
      const dataset =
        typeof request.dataset === 'string' ? request.dataset : 'hawk-public-benchmark';
      sendJSON(res, 201, summarizeSecurityBenchmark(samples, dataset, context.now()));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/security/graph/delivery') {
    try {
      const delivery = parseSecurityGraphDelivery(await readBody(req));
      context.addDelivery(delivery);
      sendJSON(res, 201, delivery);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/traffic') {
    const traffic = context.traffic();
    if (!traffic) {
      sendJSON(res, 404, { ok: false, error: 'no traffic has been imported yet' });
      return;
    }
    sendJSON(res, 200, traffic);
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/security/graph') {
    try {
      let inventory = context.inventory();
      if (!inventory) {
        const scan = await scanWorkspaceRoutes(context.workspaceRoot);
        inventory = {
          protocolVersion: IDE_PROTOCOL_VERSION,
          root: context.workspaceRoot,
          indexedAt: context.now().toISOString(),
          sourceFiles: scan.sourceFiles,
          routes: scan.routes,
        };
        context.setInventory(inventory);
      }
      const graph = await buildUnifiedSecurityGraph(context.proofGraph, {
        inventory,
        findings: context.findings(),
        traffic: context.traffic(),
        evidencePacks: context.evidencePacks(),
        sessions: await context.aiSessions.list(50),
        reproductions: await context.reproducer.list(100),
        protocols: context.protocols() ?? undefined,
        deliveries: context.deliveries(),
      });
      const nodeId = requestURL.searchParams.get('nodeId')?.trim();
      if (!nodeId) {
        sendJSON(res, 200, graph);
        return;
      }
      const depthValue = Number.parseInt(requestURL.searchParams.get('depth') ?? '2', 10);
      const depth = Number.isFinite(depthValue) ? Math.max(0, Math.min(depthValue, 5)) : 2;
      const snapshot = await context.proofGraph.subgraph(nodeId, depth);
      if (!snapshot.nodes.some((node) => node.id === nodeId)) {
        sendJSON(res, 404, { ok: false, error: 'security graph node not found' });
        return;
      }
      sendJSON(res, 200, securityGraphResponse(snapshot));
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/security/protocols') {
    try {
      const protocols = await scanProtocolSurfaces(context.workspaceRoot, context.now());
      context.setProtocols(protocols);
      sendJSON(res, 200, protocols);
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/security/attack-twin') {
    try {
      let inventory = context.inventory();
      if (!inventory) {
        const scan = await scanWorkspaceRoutes(context.workspaceRoot);
        inventory = {
          protocolVersion: IDE_PROTOCOL_VERSION,
          root: context.workspaceRoot,
          indexedAt: context.now().toISOString(),
          sourceFiles: scan.sourceFiles,
          routes: scan.routes,
        };
        context.setInventory(inventory);
      }
      const protocols =
        context.protocols() ?? (await scanProtocolSurfaces(context.workspaceRoot, context.now()));
      context.setProtocols(protocols);
      const graph = await buildUnifiedSecurityGraph(context.proofGraph, {
        inventory,
        findings: context.findings(),
        traffic: context.traffic(),
        evidencePacks: context.evidencePacks(),
        sessions: await context.aiSessions.list(50),
        reproductions: await context.reproducer.list(100),
        protocols,
        deliveries: context.deliveries(),
      });
      sendJSON(
        res,
        200,
        buildAttackTwin({
          inventory,
          protocols,
          graph,
          findings: context.findings(),
          now: context.now(),
        }),
      );
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/security/autopilot/plan') {
    try {
      const input = parseJSONBody<{
        objective?: string;
        networkPolicy?: 'offline' | 'captured-only';
        scopeHosts?: string[];
      }>(await readBody(req));
      sendJSON(res, 201, await context.autonomousSecurity.createPlan(input));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/security/autopilot/run') {
    try {
      const input = parseJSONBody<{
        planId: string;
        planHash: string;
        approved: boolean;
      }>(await readBody(req));
      const run = await context.autonomousSecurity.run(input, {
        inventory: async () => {
          const scan = await scanWorkspaceRoutes(context.workspaceRoot);
          const inventory: WorkspaceInventory = {
            protocolVersion: IDE_PROTOCOL_VERSION,
            root: context.workspaceRoot,
            indexedAt: context.now().toISOString(),
            sourceFiles: scan.sourceFiles,
            routes: scan.routes,
          };
          context.setInventory(inventory);
          await context.semanticIndex.build();
          return inventory;
        },
        protocols: async () => {
          const protocols = await scanProtocolSurfaces(context.workspaceRoot, context.now());
          context.setProtocols(protocols);
          return protocols;
        },
        audit: async () => {
          const audit = await scanWorkspaceSecurity(context.workspaceRoot, context.now());
          context.setFindings(audit.findings);
          return audit;
        },
        attackTwin: async () => {
          const inventory = context.inventory();
          const protocols = context.protocols();
          if (!inventory || !protocols)
            throw new Error('Autopilot discovery stages are incomplete');
          const graph = await buildUnifiedSecurityGraph(context.proofGraph, {
            inventory,
            findings: context.findings(),
            traffic: context.traffic(),
            evidencePacks: context.evidencePacks(),
            sessions: await context.aiSessions.list(50),
            reproductions: await context.reproducer.list(100),
            protocols,
            deliveries: context.deliveries(),
          });
          return buildAttackTwin({
            inventory,
            protocols,
            graph,
            findings: context.findings(),
            now: context.now(),
          });
        },
      });
      sendJSON(res, 200, run);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/security/autopilot/runs') {
    sendJSON(res, 200, {
      protocolVersion: IDE_PROTOCOL_VERSION,
      runs: await context.autonomousSecurity.list(),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/security/pr/analyze') {
    try {
      const input = parseJSONBody<{ diff?: string }>(await readBody(req));
      if (typeof input.diff !== 'string') throw new Error('Git diff is required');
      const report = analyzePullRequestDiff(input.diff, context.now());
      sendJSON(res, 200, { report, sarif: pullRequestReportToSarif(report) });
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/fleet') {
    sendJSON(res, 200, await context.agentFleet.snapshot());
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/fleet/dispatch-plan') {
    try {
      const input = parseJSONBody<Parameters<AgentFleetRegistry['planDispatch']>[0]>(
        await readBody(req),
      );
      sendJSON(res, 201, await context.agentFleet.planDispatch(input));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/fleet/register') {
    try {
      sendJSON(res, 201, await context.agentFleet.register(parseJSONBody(await readBody(req))));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/fleet/heartbeat') {
    try {
      sendJSON(res, 200, await context.agentFleet.heartbeat(parseJSONBody(await readBody(req))));
    } catch (err) {
      sendJSON(res, 401, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const fleetRevokeMatch = pathname.match(/^\/v1\/fleet\/([^/]+)\/revoke$/);
  if (req.method === 'POST' && fleetRevokeMatch?.[1]) {
    try {
      const input = parseJSONBody<{ approved?: boolean }>(await readBody(req));
      sendJSON(
        res,
        200,
        await context.agentFleet.revoke(
          decodeURIComponent(fleetRevokeMatch[1]),
          input.approved === true,
        ),
      );
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/memory/posture') {
    sendJSON(res, 200, {
      protocolVersion: IDE_PROTOCOL_VERSION,
      ...(await context.governedMemory.posture()),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/memory/query') {
    const query = requestURL.searchParams.get('q') ?? '';
    const layerValue = requestURL.searchParams.get('layer');
    const layer = ['run', 'project', 'organization'].includes(layerValue ?? '')
      ? (layerValue as 'run' | 'project' | 'organization')
      : undefined;
    sendJSON(res, 200, {
      protocolVersion: IDE_PROTOCOL_VERSION,
      entries: await context.governedMemory.query(query, layer),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/memory/audit') {
    try {
      const input = parseJSONBody<{ sourceDigests?: Record<string, string>; branch?: string }>(
        await readBody(req),
      );
      sendJSON(
        res,
        200,
        await context.governedMemory.auditProvenance({
          sourceDigests: input.sourceDigests ?? {},
          branch: input.branch,
        }),
      );
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/mcp/trust') {
    sendJSON(res, 200, await context.mcpTrust.posture());
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/mcp/trust/inspect') {
    try {
      const input = parseJSONBody<{ manifest?: unknown; artifactSha256?: string }>(
        await readBody(req),
      );
      if (!input.artifactSha256) throw new Error('Actual artifact SHA-256 is required');
      sendJSON(res, 200, await context.mcpTrust.inspect(input.manifest, input.artifactSha256));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/mcp/trust/approve') {
    try {
      const input = parseJSONBody<{
        manifest?: unknown;
        artifactSha256?: string;
        approvedBy?: string;
        approved?: boolean;
      }>(await readBody(req));
      if (!input.artifactSha256) throw new Error('Actual artifact SHA-256 is required');
      sendJSON(
        res,
        200,
        await context.mcpTrust.approve(
          input.manifest,
          input.artifactSha256,
          input.approvedBy ?? '',
          input.approved === true,
        ),
      );
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/hawk/health') {
    const health = context.hawkHealth();
    if (!health) {
      sendJSON(res, 404, { ok: false, error: 'no Hawk health report has been imported yet' });
      return;
    }
    sendJSON(res, 200, health);
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/ai/sessions') {
    try {
      const limit = Number.parseInt(requestURL.searchParams.get('limit') ?? '30', 10);
      sendJSON(res, 200, { sessions: await context.aiSessions.list(limit) });
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/ai/sessions') {
    try {
      const input = parseJSONBody<AiCreateSessionRequest>(await readBody(req));
      sendJSON(res, 201, await context.aiSessions.create(input));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/ai/batches') {
    try {
      const input = parseJSONBody<AiParallelBatchRequest>(await readBody(req));
      sendJSON(res, 201, await context.aiSessions.createParallelBatch(input));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiBatchMatch = pathname.match(/^\/v1\/ai\/batches\/([^/]+)$/);
  if (req.method === 'GET' && aiBatchMatch?.[1]) {
    try {
      sendJSON(res, 200, await context.aiSessions.batch(decodeURIComponent(aiBatchMatch[1])));
    } catch (err) {
      sendJSON(res, statusForSessionError(err), { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiBatchEventsMatch = pathname.match(/^\/v1\/ai\/batches\/([^/]+)\/events$/);
  if (req.method === 'GET' && aiBatchEventsMatch?.[1]) {
    try {
      const rawAfter = requestURL.searchParams.get('after');
      let after: Record<string, number> = {};
      if (rawAfter) {
        const parsed = JSON.parse(rawAfter) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          after = Object.fromEntries(
            Object.entries(parsed).filter(
              ([, value]) => typeof value === 'number' && Number.isFinite(value),
            ),
          );
        }
      }
      sendJSON(
        res,
        200,
        await context.aiSessions.batchEvents(decodeURIComponent(aiBatchEventsMatch[1]), after),
      );
    } catch (err) {
      sendJSON(res, statusForSessionError(err), { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/ai/batches/merge') {
    try {
      const input = parseJSONBody<AiMergeBatchRequest>(await readBody(req));
      sendJSON(res, 201, await context.aiSessions.mergeBatch(input));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiSessionMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && aiSessionMatch?.[1]) {
    try {
      sendJSON(res, 200, await context.aiSessions.get(decodeURIComponent(aiSessionMatch[1])));
    } catch (err) {
      sendJSON(res, statusForSessionError(err), { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiEventsMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/events$/);
  if (req.method === 'GET' && aiEventsMatch?.[1]) {
    try {
      const after = Number.parseInt(requestURL.searchParams.get('after') ?? '0', 10);
      sendJSON(
        res,
        200,
        await context.aiSessions.events(
          decodeURIComponent(aiEventsMatch[1]),
          Number.isFinite(after) ? after : 0,
        ),
      );
    } catch (err) {
      sendJSON(res, statusForSessionError(err), { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiDiffMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/diff$/);
  if (req.method === 'GET' && aiDiffMatch?.[1]) {
    try {
      sendJSON(res, 200, await context.aiSessions.diff(decodeURIComponent(aiDiffMatch[1])));
    } catch (err) {
      sendJSON(res, statusForSessionError(err), { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiContinueMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/messages$/);
  if (req.method === 'POST' && aiContinueMatch?.[1]) {
    try {
      const input = parseJSONBody<AiCreateSessionRequest>(await readBody(req));
      sendJSON(
        res,
        202,
        await context.aiSessions.continue(decodeURIComponent(aiContinueMatch[1]), input),
      );
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiTestsMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/tests$/);
  if (req.method === 'POST' && aiTestsMatch?.[1]) {
    try {
      const input = parseJSONBody<AiRunTestsRequest>(await readBody(req));
      sendJSON(
        res,
        200,
        await context.aiSessions.runTests(decodeURIComponent(aiTestsMatch[1]), input),
      );
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiCancelTestsMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/tests\/cancel$/);
  if (req.method === 'POST' && aiCancelTestsMatch?.[1]) {
    try {
      sendJSON(
        res,
        200,
        await context.aiSessions.cancelTests(decodeURIComponent(aiCancelTestsMatch[1])),
      );
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiReproduceMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/reproduce$/);
  if (req.method === 'POST' && aiReproduceMatch?.[1]) {
    try {
      const input = parseJSONBody<AiReproduceRequest>(await readBody(req));
      sendJSON(
        res,
        200,
        await context.aiSessions.reproduce(decodeURIComponent(aiReproduceMatch[1]), input),
      );
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiSemanticReviewMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/semantic-review$/);
  if (req.method === 'POST' && aiSemanticReviewMatch?.[1]) {
    try {
      sendJSON(
        res,
        200,
        await context.aiSessions.semanticReview(decodeURIComponent(aiSemanticReviewMatch[1])),
      );
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiApplyMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/apply$/);
  if (req.method === 'POST' && aiApplyMatch?.[1]) {
    try {
      const input = parseJSONBody<AiApplyRequest>(await readBody(req));
      sendJSON(
        res,
        200,
        await context.aiSessions.apply(decodeURIComponent(aiApplyMatch[1]), input),
      );
    } catch (err) {
      sendJSON(res, 409, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiCheckpointMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/checkpoints$/);
  if (req.method === 'POST' && aiCheckpointMatch?.[1]) {
    try {
      const input = parseJSONBody<AiCheckpointRequest>(await readBody(req));
      sendJSON(
        res,
        201,
        await context.aiSessions.checkpoint(decodeURIComponent(aiCheckpointMatch[1]), input),
      );
    } catch (err) {
      sendJSON(res, 409, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiRestoreCheckpointMatch = pathname.match(
    /^\/v1\/ai\/sessions\/([^/]+)\/checkpoints\/restore$/,
  );
  if (req.method === 'POST' && aiRestoreCheckpointMatch?.[1]) {
    try {
      const input = parseJSONBody<AiRestoreCheckpointRequest>(await readBody(req));
      sendJSON(
        res,
        200,
        await context.aiSessions.restoreCheckpoint(
          decodeURIComponent(aiRestoreCheckpointMatch[1]),
          input,
        ),
      );
    } catch (err) {
      sendJSON(res, 409, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiRejectMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/reject$/);
  if (req.method === 'POST' && aiRejectMatch?.[1]) {
    try {
      const input = parseJSONBody<{ approved?: boolean }>(await readBody(req));
      if (input.approved !== true)
        throw new Error('Operator approval is required to reject changes.');
      sendJSON(res, 200, await context.aiSessions.reject(decodeURIComponent(aiRejectMatch[1])));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiRevertMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/revert$/);
  if (req.method === 'POST' && aiRevertMatch?.[1]) {
    try {
      const input = parseJSONBody<{ approved?: boolean }>(await readBody(req));
      if (input.approved !== true)
        throw new Error('Operator approval is required to revert changes.');
      sendJSON(res, 200, await context.aiSessions.revert(decodeURIComponent(aiRevertMatch[1])));
    } catch (err) {
      sendJSON(res, 409, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiCancelMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && aiCancelMatch?.[1]) {
    try {
      const input = parseJSONBody<{ approved?: boolean }>(await readBody(req));
      if (input.approved !== true)
        throw new Error('Operator approval is required to cancel a task.');
      sendJSON(res, 200, await context.aiSessions.cancel(decodeURIComponent(aiCancelMatch[1])));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiPauseMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/pause$/);
  if (req.method === 'POST' && aiPauseMatch?.[1]) {
    try {
      const input = parseJSONBody<{ approved?: boolean }>(await readBody(req));
      if (input.approved !== true)
        throw new Error('Operator approval is required to pause a task.');
      sendJSON(res, 200, await context.aiSessions.pause(decodeURIComponent(aiPauseMatch[1])));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const aiResumeMatch = pathname.match(/^\/v1\/ai\/sessions\/([^/]+)\/resume$/);
  if (req.method === 'POST' && aiResumeMatch?.[1]) {
    try {
      const input = parseJSONBody<{ approved?: boolean }>(await readBody(req));
      if (input.approved !== true)
        throw new Error('Operator approval is required to resume a task.');
      sendJSON(res, 202, await context.aiSessions.resume(decodeURIComponent(aiResumeMatch[1])));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/hawk/health/import') {
    try {
      const body = await readBody(req);
      const health = importHawkHealthReport(JSON.parse(body.toString('utf8')), context.now());
      await context.setHawkHealth(health);
      sendJSON(res, 200, health);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/traffic/import/har') {
    try {
      const body = await readBody(req);
      const traffic = importHarTraffic(JSON.parse(body.toString('utf8')), context.now());
      context.setTraffic(traffic);
      sendJSON(res, 200, traffic);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/traffic/replay/plan') {
    try {
      const input = parseJSONBody<IdentityReplayPlanInput>(await readBody(req));
      sendJSON(res, 201, context.identityReplay.createPlan(input));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/traffic/replay/execute') {
    try {
      const input = parseJSONBody<IdentityReplayExecuteInput>(await readBody(req));
      sendJSON(res, 200, await context.identityReplay.execute(input));
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/audit/static') {
    try {
      await consumeBody(req);
      const audit = await scanWorkspaceSecurity(context.workspaceRoot, context.now());
      context.setFindings(audit.findings);
      sendJSON(res, 200, audit);
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/scans/templates') {
    const response: WorkspaceScanTemplatesResponse = {
      protocolVersion: IDE_PROTOCOL_VERSION,
      templates: createWorkspaceScanTemplates(),
    };
    sendJSON(res, 200, response);
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/security-tests/templates') {
    sendJSON(res, 200, {
      protocolVersion: IDE_PROTOCOL_VERSION,
      templates: await listSecurityTestTemplates(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/security-tests/plan') {
    try {
      const templateId = parseSecurityTestTemplateId(
        requestURL.searchParams.get('templateId') ?? 'static-code',
      );
      const hosts = requestURL.searchParams.getAll('host');
      const plan = await createSecurityTestPlan({
        workspaceRoot: context.workspaceRoot,
        templateId,
        scopeHosts: hosts,
        maxRequestsPerSecond: parseOptionalRate(requestURL.searchParams.get('rate')),
        now: context.now(),
      });
      sendJSON(res, 200, plan);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/security-tests/run') {
    try {
      const input = parseSecurityTestRunRequest(await readBody(req));
      const plan = await createSecurityTestPlan({
        workspaceRoot: context.workspaceRoot,
        templateId: input.templateId,
        scopeHosts: input.scopeHosts,
        maxRequestsPerSecond: input.maxRequestsPerSecond,
      });
      const result = await runApprovedSecurityTest({
        workspaceRoot: context.workspaceRoot,
        plan,
        approvalHash: input.approvalHash,
        approved: input.approved,
        traffic: context.traffic(),
        now: context.now(),
      });
      context.setFindings(result.findings);
      sendJSON(res, 200, result);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/governance/policy') {
    try {
      const policy = await loadGovernancePolicy(context.workspaceRoot);
      sendJSON(res, 200, { policy, policyHash: governancePolicyHash(policy) });
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/mcp/registry') {
    sendJSON(res, 200, { protocolVersion: IDE_PROTOCOL_VERSION, tools: listMcpToolGovernance() });
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/docker/agent-profiles') {
    sendJSON(res, 200, {
      protocolVersion: IDE_PROTOCOL_VERSION,
      profiles: listDockerAgentProfiles(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/scans/plan') {
    try {
      const templateId = parseTemplateId(
        requestURL.searchParams.get('templateId') ?? 'passive-workspace',
      );
      const plan: WorkspaceScanPlan = createWorkspaceScanPlan(
        context.workspaceRoot,
        templateId,
        context.now(),
      );
      sendJSON(res, 200, plan);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/scans/run') {
    try {
      const input = parseScanRequest(await readBody(req));
      const report: WorkspaceScanReport = await runApprovedWorkspaceScan({
        workspaceRoot: context.workspaceRoot,
        templateId: input.templateId,
        approvalHash: input.approvalHash,
        approved: input.approved,
        traffic: context.traffic(),
        hawkHealth: context.hawkHealth(),
        now: context.now(),
      });
      context.setFindings(report.findings);
      sendJSON(res, 200, report);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/reports/evidence') {
    try {
      const input = parseEvidencePackRequest(await readBody(req));
      const report: EvidencePackReport = await buildEvidencePack({
        workspaceRoot: context.workspaceRoot,
        approved: input.approved,
        traffic: context.traffic(),
        hawkHealth: context.hawkHealth(),
        now: context.now(),
      });
      context.addEvidencePack(report);
      sendJSON(res, 200, report);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/missions/plan') {
    try {
      const input = parseMissionRequest(await readBody(req));
      const mission: GovernedMissionPlan = await createGovernedMission({
        workspaceRoot: context.workspaceRoot,
        objective: input.objective,
        profile: input.profile,
        hosts: input.hosts,
        now: context.now(),
      });
      sendJSON(res, 200, mission);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/reproductions') {
    sendJSON(res, 200, { reproductions: await context.reproducer.list(100) });
    return;
  }

  const reproductionPlanMatch = pathname.match(/^\/v1\/findings\/([^/]+)\/reproduction-plan$/);
  if (req.method === 'POST' && reproductionPlanMatch?.[1]) {
    try {
      const findingId = decodeURIComponent(reproductionPlanMatch[1]);
      const finding = context.findings().find((candidate) => candidate.id === findingId);
      if (!finding) {
        sendJSON(res, 404, { ok: false, error: 'finding not found' });
        return;
      }
      const input = parseReproductionPlanRequest(await readBody(req));
      const plan: SandboxReproductionPlan = await context.reproducer.createPlan(
        finding,
        input.image,
        input.generic,
      );
      sendJSON(res, 201, plan);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const reproduceMatch = pathname.match(/^\/v1\/findings\/([^/]+)\/reproduce$/);
  if (req.method === 'POST' && reproduceMatch?.[1]) {
    try {
      const findingId = decodeURIComponent(reproduceMatch[1]);
      const finding = context.findings().find((candidate) => candidate.id === findingId);
      if (!finding) {
        sendJSON(res, 404, { ok: false, error: 'finding not found' });
        return;
      }
      const input = parseReproductionExecuteRequest(await readBody(req));
      const result: SandboxReproductionResult = await context.reproducer.execute(finding, input);
      sendJSON(res, 200, result);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const retestMatch = pathname.match(/^\/v1\/findings\/([^/]+)\/retest$/);
  if (req.method === 'POST' && retestMatch?.[1]) {
    try {
      await consumeBody(req);
      const id = decodeURIComponent(retestMatch[1]);
      const previous = context.findings().find((finding) => finding.id === id);
      if (!previous) {
        sendJSON(res, 404, { ok: false, error: 'finding not found' });
        return;
      }
      const audit = await scanWorkspaceSecurity(context.workspaceRoot, context.now());
      context.setFindings(audit.findings);
      const current = audit.findings.find((finding) => finding.id === id);
      const result: RetestResult = current
        ? { finding: current, present: true }
        : { finding: { ...previous, status: 'fixed' }, present: false };
      sendJSON(res, 200, result);
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  sendJSON(res, 404, { ok: false, error: 'not found' });
}

function authorized(req: IncomingMessage, token: string): boolean {
  const rawHeader = req.headers['x-hawk-token'];
  const supplied = Array.isArray(rawHeader) ? (rawHeader[0] ?? '') : (rawHeader ?? '');
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function loadStoredHawkHealthReport(
  workspaceRoot: string,
  now: () => Date,
): Promise<HawkHealthReport | null> {
  try {
    return importHawkHealthReport(
      JSON.parse(await readFile(join(workspaceRoot, '.hawk', 'health.json'), 'utf8')),
      now(),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

async function persistHawkHealthReport(
  workspaceRoot: string,
  report: HawkHealthReport,
): Promise<void> {
  const directory = join(workspaceRoot, '.hawk');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'health.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function validLoopbackHost(req: IncomingMessage): boolean {
  // Binding the server to loopback is the primary boundary. Check the peer as
  // well so a future proxy/transport change cannot turn a spoofed Host header
  // into an authorization bypass. Node reports IPv4 peers as ::ffff:x.x.x.x
  // when the listener is dual-stack on some platforms.
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const raw = req.headers.host;
  if (!raw) return true;
  try {
    // URL parsing gives us strict bracket/port handling and rejects malformed
    // Host values instead of attempting to sanitize them with a regex.
    const parsed = new URL(`http://${raw}`);
    return isLoopbackHost(parsed.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().replace(/^::ffff:/, '');
  return isLoopbackHost(normalized);
}

function consumeBody(req: IncomingMessage): Promise<void> {
  return readBody(req).then(() => undefined);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.end(JSON.stringify(value));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((err) => (err ? reject(err) : resolveClose()));
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseScanRequest(body: Buffer): {
  approved: boolean;
  templateId: WorkspaceScanTemplateId;
  approvalHash: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('scan request must be valid JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('scan request must be an object');
  const request = value as Record<string, unknown>;
  if (request.approved !== true)
    throw new Error('operator approval is required for a workspace scan');
  if (typeof request.templateId !== 'string') throw new Error('scan template id is required');
  if (typeof request.approvalHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.approvalHash)) {
    throw new Error('a valid scan approval hash is required');
  }
  return {
    approved: true,
    templateId: parseTemplateId(request.templateId),
    approvalHash: request.approvalHash,
  };
}

function parseEvidencePackRequest(body: Buffer): { approved: true } {
  const request = parseJSONBody<Record<string, unknown>>(body);
  if (request.approved !== true) {
    throw new Error('operator approval is required to build an evidence pack');
  }
  return { approved: true };
}

function parseSecurityImportRequest(body: Buffer): {
  adapter: SecurityAdapterId;
  source: string;
  document: unknown;
} {
  const request = parseJSONBody<Record<string, unknown>>(body);
  const adapters: SecurityAdapterId[] = ['codeql', 'semgrep', 'zap', 'nuclei', 'trivy', 'oss-fuzz'];
  if (
    typeof request.adapter !== 'string' ||
    !adapters.includes(request.adapter as SecurityAdapterId)
  ) {
    throw new Error('A supported security adapter is required');
  }
  if (
    request.source !== undefined &&
    (typeof request.source !== 'string' || request.source.length > 500)
  ) {
    throw new Error('Security import source must be a bounded string');
  }
  return {
    adapter: request.adapter as SecurityAdapterId,
    source:
      typeof request.source === 'string' && request.source.trim()
        ? request.source
        : `${request.adapter}.sarif`,
    document: request.document,
  };
}

function parseSecurityToolPlanRequest(body: Buffer): CreateSecurityToolPlanInput {
  const request = parseJSONBody<Record<string, unknown>>(body);
  const adapters: SecurityAdapterId[] = ['codeql', 'semgrep', 'zap', 'nuclei', 'trivy', 'oss-fuzz'];
  if (
    typeof request.adapter !== 'string' ||
    !adapters.includes(request.adapter as SecurityAdapterId)
  ) {
    throw new Error('A supported security adapter is required');
  }
  if (typeof request.image !== 'string' || typeof request.target !== 'string') {
    throw new Error('Security adapter image and target are required');
  }
  if (!Array.isArray(request.args) || !request.args.every((arg) => typeof arg === 'string')) {
    throw new Error('Security adapter args must be an array of strings');
  }
  const networkMode = request.networkMode === 'restricted' ? 'restricted' : 'none';
  const allowedHosts = Array.isArray(request.allowedHosts)
    ? request.allowedHosts.filter((host): host is string => typeof host === 'string')
    : [];
  return {
    adapter: request.adapter as SecurityAdapterId,
    image: request.image,
    target: request.target,
    args: request.args,
    networkMode,
    allowedHosts,
    ...(request.approvedExternalAccess === true ? { approvedExternalAccess: true } : {}),
  };
}

function parseSecurityToolRunRequest(body: Buffer): { plan: SecurityToolRunPlan } {
  const request = parseJSONBody<Record<string, unknown>>(body);
  if (request.approved !== true)
    throw new Error('Operator approval is required for adapter execution');
  if (!request.plan || typeof request.plan !== 'object')
    throw new Error('Security adapter plan is required');
  return { plan: request.plan as SecurityToolRunPlan };
}

function parseSecurityGraphDelivery(body: Buffer): SecurityGraphDelivery {
  const request = parseJSONBody<Record<string, unknown>>(body);
  if (
    typeof request.id !== 'string' ||
    !request.id.trim() ||
    typeof request.branch !== 'string' ||
    typeof request.base !== 'string'
  ) {
    throw new Error('Graph delivery id, branch and base are required');
  }
  const statuses = ['open', 'merged', 'closed', 'draft'] as const;
  const reviewStatuses = ['passed', 'changes-requested', 'pending', 'skipped'] as const;
  if (
    typeof request.status !== 'string' ||
    !statuses.includes(request.status as (typeof statuses)[number])
  )
    throw new Error('Graph delivery status is invalid');
  if (
    request.reviewStatus !== undefined &&
    (typeof request.reviewStatus !== 'string' ||
      !reviewStatuses.includes(request.reviewStatus as (typeof reviewStatuses)[number]))
  )
    throw new Error('Graph delivery reviewStatus is invalid');
  const findingIds = Array.isArray(request.findingIds)
    ? request.findingIds.filter((value): value is string => typeof value === 'string').slice(0, 500)
    : [];
  return {
    id: request.id.trim().slice(0, 300),
    ...(Number.isInteger(request.number) && Number(request.number) > 0
      ? { number: Number(request.number) }
      : {}),
    ...(typeof request.url === 'string' && request.url.length <= 1_000 ? { url: request.url } : {}),
    branch: request.branch.trim().slice(0, 300),
    base: request.base.trim().slice(0, 300),
    status: request.status as SecurityGraphDelivery['status'],
    ...(typeof request.reviewStatus === 'string'
      ? { reviewStatus: request.reviewStatus as SecurityGraphDelivery['reviewStatus'] }
      : {}),
    ...(findingIds.length ? { findingIds } : {}),
    ...(typeof request.patchHash === 'string' && /^[a-f0-9]{32,128}$/.test(request.patchHash)
      ? { patchHash: request.patchHash }
      : {}),
  };
}

function parseReproductionPlanRequest(body: Buffer): {
  image?: string;
  generic?: GenericReproductionInput;
} {
  const request = parseJSONBody<Record<string, unknown>>(body);
  if (
    request.image !== undefined &&
    (typeof request.image !== 'string' || request.image.length > 255)
  )
    throw new Error('reproduction image must be a bounded string');
  return {
    ...(typeof request.image === 'string' ? { image: request.image } : {}),
    generic: parseGenericReproductionScenario(request.generic),
  };
}

function parseGenericReproductionScenario(value: unknown): GenericReproductionScenario | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    throw new Error('generic reproduction scenario must be an object');
  }
  const input = value as Record<string, unknown>;
  const control = parseGenericCommand(input.control, 'control');
  const reproduction = parseGenericCommand(input.reproduction, 'reproduction');
  const controlExpectedExitCode = parseGenericExitCode(input.controlExpectedExitCode, 0);
  const reproductionExpectedExitCode = parseGenericExitCode(input.reproductionExpectedExitCode, 0);
  const modes = ['command', 'http', 'unit-test', 'fuzz', 'protocol', 'dependency'] as const;
  if (
    input.mode !== undefined &&
    (typeof input.mode !== 'string' || !modes.includes(input.mode as (typeof modes)[number]))
  ) {
    throw new Error('generic reproduction mode is unsupported');
  }
  if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 160)) {
    throw new Error('generic reproduction label must be a bounded string');
  }
  return {
    ...(typeof input.mode === 'string'
      ? { mode: input.mode as GenericReproductionScenario['mode'] }
      : {}),
    control,
    reproduction,
    controlExpectedExitCode,
    reproductionExpectedExitCode,
    ...(typeof input.label === 'string' && input.label.trim() ? { label: input.label.trim() } : {}),
  };
}

function parseGenericCommand(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`generic ${label} command is required`);
  return value.map((part) => {
    if (typeof part !== 'string' || part.length === 0 || part.length > 1_000) {
      throw new Error(`generic ${label} command contains an invalid argument`);
    }
    return part;
  });
}

function parseGenericExitCode(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 255) {
    throw new Error('generic reproduction exit codes must be integers from 0 to 255');
  }
  return Number(value);
}

function parseReproductionExecuteRequest(body: Buffer): {
  planId: string;
  planHash: string;
  approved: true;
} {
  const request = parseJSONBody<Record<string, unknown>>(body);
  if (request.approved !== true)
    throw new Error('operator approval is required for sandbox reproduction');
  if (typeof request.planId !== 'string' || !/^repro-plan-[a-f0-9-]{36}$/.test(request.planId)) {
    throw new Error('valid reproduction plan id is required');
  }
  if (typeof request.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.planHash)) {
    throw new Error('valid reproduction approval hash is required');
  }
  return { planId: request.planId, planHash: request.planHash, approved: true };
}

function parseMissionRequest(body: Buffer): {
  objective: string;
  profile: GovernedMissionProfile;
  hosts: string[];
} {
  const request = parseJSONBody<Record<string, unknown>>(body);
  if (typeof request.objective !== 'string' || !request.objective.trim()) {
    throw new Error('mission objective is required');
  }
  if (request.objective.length > 1_000) throw new Error('mission objective is too long');
  if (
    request.profile !== 'review' &&
    request.profile !== 'remediate' &&
    request.profile !== 'authorized-validation'
  ) {
    throw new Error('unsupported mission profile');
  }
  const hosts = request.hosts ?? [];
  if (
    !Array.isArray(hosts) ||
    hosts.length > 128 ||
    !hosts.every((host) => typeof host === 'string' && host.length <= 2_048)
  ) {
    throw new Error('mission hosts must be a bounded string list');
  }
  return {
    objective: request.objective.trim(),
    profile: request.profile,
    hosts: hosts as string[],
  };
}

function parseTemplateId(value: string): WorkspaceScanTemplateId {
  if (value !== 'passive-workspace' && value !== 'runtime-observe' && value !== 'release-gate') {
    throw new Error('unsupported scan template');
  }
  return value;
}

function parseSecurityTestTemplateId(value: string): SecurityTestTemplateId {
  if (
    value !== 'static-code' &&
    value !== 'route-coverage' &&
    value !== 'dependency-manifest' &&
    value !== 'sandbox-signal'
  ) {
    throw new Error('unsupported security test template');
  }
  return value;
}

function parseOptionalRate(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1_000) {
    throw new Error('rate must be a number between 0 and 1000');
  }
  return rate;
}

function parseSecurityTestRunRequest(body: Buffer): {
  approved: true;
  templateId: SecurityTestTemplateId;
  approvalHash: string;
  scopeHosts: string[];
  maxRequestsPerSecond?: number;
} {
  const request = parseJSONBody<Record<string, unknown>>(body);
  if (request.approved !== true)
    throw new Error('operator approval is required for a security test');
  if (typeof request.templateId !== 'string')
    throw new Error('security test template id is required');
  if (typeof request.approvalHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.approvalHash)) {
    throw new Error('a valid security test approval hash is required');
  }
  const hosts = request.scopeHosts ?? [];
  if (
    !Array.isArray(hosts) ||
    hosts.length > 32 ||
    !hosts.every((host) => typeof host === 'string')
  ) {
    throw new Error('security test scopeHosts must be a bounded string list');
  }
  return {
    approved: true,
    templateId: parseSecurityTestTemplateId(request.templateId),
    approvalHash: request.approvalHash,
    scopeHosts: hosts as string[],
    maxRequestsPerSecond:
      request.maxRequestsPerSecond === undefined
        ? undefined
        : parseOptionalRate(String(request.maxRequestsPerSecond)),
  };
}

function parseJSONBody<T>(body: Buffer): T {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('request body must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body must be an object');
  }
  return value as T;
}

function statusForSessionError(err: unknown): number {
  return errorMessage(err).toLowerCase().includes('not found') ? 404 : 400;
}
