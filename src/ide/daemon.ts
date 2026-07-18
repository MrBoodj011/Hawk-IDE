import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { startIngestServer } from '../browser/server.js';
import { CaptureStore } from '../browser/store.js';
import type {
  AiApplyRequest,
  AiCheckpointRequest,
  AiCreateSessionRequest,
  AiMergeBatchRequest,
  AiParallelBatchRequest,
  AiRestoreCheckpointRequest,
  AiRunTestsRequest,
} from './aiProtocol.js';
import { AiSessionManager } from './aiSessionManager.js';
import { runCodingCoreBenchmark } from './codingBenchmark.js';
import { buildEvidencePack } from './evidenceReport.js';
import { createGovernedMission } from './governedMission.js';
import { importHawkHealthReport } from './hawkReport.js';
import {
  type EditPredictionRequest,
  type InlineCompletionRequest,
  createEditPrediction,
  createInlineCompletion,
} from './inlineCompletion.js';
import {
  type DaemonHealth,
  type EvidencePackReport,
  type GovernedMissionPlan,
  type GovernedMissionProfile,
  type HawkHealthReport,
  IDE_PROTOCOL_VERSION,
  type RetestResult,
  type SecurityFinding,
  type TrafficInventory,
  type WorkspaceInventory,
  type WorkspaceScanPlan,
  type WorkspaceScanReport,
  type WorkspaceScanTemplateId,
  type WorkspaceScanTemplatesResponse,
} from './protocol.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import { SemanticWorkspaceIndex } from './semanticIndex.js';
import { scanWorkspaceSecurity } from './staticAudit.js';
import { importHarTraffic, importLiveTraffic, mergeTrafficInventories } from './traffic.js';
import {
  createWorkspaceScanPlan,
  createWorkspaceScanTemplates,
  runApprovedWorkspaceScan,
} from './workspaceScan.js';

const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;

export interface IdeDaemonOptions {
  workspaceRoot?: string;
  host?: string;
  port?: number;
  token?: string;
  now?: () => Date;
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
  let findings: SecurityFinding[] = [];
  let importedTraffic: TrafficInventory | null = null;
  let hawkHealth = await loadStoredHawkHealthReport(workspaceRoot, now);
  const aiSessions = new AiSessionManager({ workspaceRoot, now });
  await aiSessions.initialize();
  const semanticIndex = new SemanticWorkspaceIndex(workspaceRoot, {
    embeddings: {
      enabled: process.env.HAWK_IDE_EMBEDDINGS === '1',
      baseUrl: process.env.HAWK_IDE_EMBEDDING_BASE_URL,
      model: process.env.HAWK_IDE_EMBEDDING_MODEL,
    },
  });
  const completionLatencies: number[] = [];
  const captureStore = new CaptureStore({ maxEntries: 5_000 });
  const captureServer = await startIngestServer({
    store: captureStore,
    port: 0,
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      token,
      workspaceRoot,
      now,
      inventory: () => latestInventory,
      setInventory: (value) => {
        latestInventory = value;
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
      hawkHealth: () => hawkHealth,
      setHawkHealth: async (value) => {
        await persistHawkHealthReport(workspaceRoot, value);
        hawkHealth = value;
      },
      aiSessions,
      semanticIndex,
      completionLatencies: () => [...completionLatencies],
      recordCompletionLatency: (latencyMs) => {
        completionLatencies.push(latencyMs);
        if (completionLatencies.length > 100) completionLatencies.shift();
      },
    });
  });

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
          await aiSessions.dispose();
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
  findings(): SecurityFinding[];
  setFindings(value: SecurityFinding[]): void;
  traffic(): TrafficInventory | null;
  setTraffic(value: TrafficInventory): void;
  hawkHealth(): HawkHealthReport | null;
  setHawkHealth(value: HawkHealthReport): Promise<void>;
  aiSessions: AiSessionManager;
  semanticIndex: SemanticWorkspaceIndex;
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
      const prediction = await createEditPrediction(input, context.semanticIndex);
      context.recordCompletionLatency(prediction.latencyMs);
      sendJSON(res, 200, prediction);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
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

  if (req.method === 'GET' && pathname === '/v1/traffic') {
    const traffic = context.traffic();
    if (!traffic) {
      sendJSON(res, 404, { ok: false, error: 'no traffic has been imported yet' });
      return;
    }
    sendJSON(res, 200, traffic);
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
  const raw = req.headers.host;
  if (!raw) return true;
  const host = raw
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return isLoopbackHost(host);
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
