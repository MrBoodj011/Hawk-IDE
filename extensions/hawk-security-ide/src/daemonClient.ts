import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import * as vscode from 'vscode';
import { hawkLlmProvider, llmSecretStorageKey } from './llmProviderPolicy';
import type {
  AiDiffResponse,
  AiEventPage,
  AiMergeBatchResponse,
  AiParallelBatchResponse,
  AiSessionList,
  AiSessionSummary,
  CodingCoreBenchmark,
  DaemonDescriptor,
  DaemonHealth,
  DebugBundleResult,
  EditPredictionEvaluationReport,
  EditPredictionResponse,
  EvidencePackReport,
  FindingsResponse,
  GovernedMissionPlan,
  GovernedMissionProfile,
  HawkHealthReport,
  IdentityReplayPlan,
  IdentityReplayResult,
  InlineCompletionResponse,
  ObservabilitySnapshot,
  RetestResult,
  SandboxReproductionPlan,
  SandboxReproductionResult,
  SandboxReproductionsResponse,
  SecurityGraphResponse,
  SecurityTestPlan,
  SecurityTestResult,
  SecurityTestTemplateId,
  SecurityTestTemplatesResponse,
  SemanticIndexStats,
  SemanticSearchResponse,
  StaticAuditReport,
  TrafficInventory,
  WorkspaceInventory,
  WorkspaceScanPlan,
  WorkspaceScanReport,
  WorkspaceScanTemplateId,
  WorkspaceScanTemplatesResponse,
} from './types';

const START_TIMEOUT_MS = 15_000;

interface ActiveDaemon extends DaemonDescriptor {
  child: ChildProcess;
  workspace: vscode.Uri;
}

/**
 * Owns the local daemon lifecycle for one Code-OSS workspace. The extension
 * never exposes the daemon token to a webview; UI code talks to this client by
 * message passing and the extension host adds authentication itself.
 */
export class DaemonClient implements vscode.Disposable {
  private active: ActiveDaemon | undefined;
  private starting: Promise<ActiveDaemon> | undefined;
  private readonly output = vscode.window.createOutputChannel('Hawk Security IDE');

  constructor(
    private readonly extensionUri?: vscode.Uri,
    private readonly secrets?: vscode.SecretStorage,
  ) {}

  async start(workspace: vscode.Uri): Promise<DaemonDescriptor> {
    if (this.active?.workspace.fsPath === workspace.fsPath) return this.active;
    if (this.starting) return this.starting;
    this.stop();
    this.starting = this.spawnDaemon(workspace);
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async restart(workspace: vscode.Uri): Promise<DaemonDescriptor> {
    this.stop();
    return await this.start(workspace);
  }

  async health(workspace: vscode.Uri): Promise<DaemonHealth> {
    const daemon = await this.start(workspace);
    return await this.request<DaemonHealth>(daemon, '/v1/health');
  }

  async capturePairing(
    workspace: vscode.Uri,
  ): Promise<{ url: string; token: string; workspace: string }> {
    const daemon = await this.start(workspace);
    if (!daemon.captureUrl || !daemon.captureToken) {
      throw new Error('The local agent does not expose the Hawk capture bridge.');
    }
    return {
      url: daemon.captureUrl,
      token: daemon.captureToken,
      workspace: workspace.fsPath,
    };
  }

  async indexWorkspace(workspace: vscode.Uri): Promise<WorkspaceInventory> {
    const daemon = await this.start(workspace);
    return await this.request<WorkspaceInventory>(daemon, '/v1/workspace/index', {
      method: 'POST',
    });
  }

  async rebuildSemanticIndex(workspace: vscode.Uri): Promise<SemanticIndexStats> {
    const daemon = await this.start(workspace);
    return await this.request<SemanticIndexStats>(daemon, '/v1/workspace/semantic-index', {
      method: 'POST',
    });
  }

  async updateSemanticFile(
    workspace: vscode.Uri,
    file: string,
    deleted = false,
  ): Promise<SemanticIndexStats> {
    const daemon = await this.start(workspace);
    return await this.request<SemanticIndexStats>(daemon, '/v1/workspace/semantic-index/file', {
      method: deleted ? 'DELETE' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
  }

  async semanticSearch(
    workspace: vscode.Uri,
    query: string,
    limit = 12,
  ): Promise<SemanticSearchResponse> {
    const daemon = await this.start(workspace);
    return await this.request<SemanticSearchResponse>(daemon, '/v1/workspace/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    });
  }

  async inlineCompletion(
    workspace: vscode.Uri,
    input: { file: string; languageId: string; prefix: string; suffix: string },
  ): Promise<InlineCompletionResponse> {
    const daemon = await this.start(workspace);
    return await this.request<InlineCompletionResponse>(daemon, '/v1/ai/inline-completion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async editPrediction(
    workspace: vscode.Uri,
    input: {
      file: string;
      languageId: string;
      prefix: string;
      suffix: string;
      recentEdits: Array<{ file: string; before: string; after: string; line: number }>;
      diagnostics: string[];
      minConfidence: number;
    },
  ): Promise<EditPredictionResponse> {
    const daemon = await this.start(workspace);
    return await this.request<EditPredictionResponse>(daemon, '/v1/ai/edit-prediction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async editPredictionFeedback(
    workspace: vscode.Uri,
    predictionId: string,
    outcome: 'accepted' | 'rejected',
  ): Promise<{ recorded: boolean; reason?: string }> {
    const daemon = await this.start(workspace);
    return await this.request(daemon, '/v1/ai/edit-prediction/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ predictionId, outcome }),
    });
  }

  async editPredictionEvaluation(workspace: vscode.Uri): Promise<EditPredictionEvaluationReport> {
    const daemon = await this.start(workspace);
    return await this.request(daemon, '/v1/ai/edit-prediction/evaluation');
  }

  async clearEditPredictionCache(workspace: vscode.Uri): Promise<void> {
    const daemon = await this.start(workspace);
    await this.request(daemon, '/v1/ai/edit-prediction/cache', { method: 'DELETE' });
  }

  async codingCoreBenchmark(workspace: vscode.Uri): Promise<CodingCoreBenchmark> {
    const daemon = await this.start(workspace);
    return await this.request<CodingCoreBenchmark>(daemon, '/v1/diagnostics/coding-core', {
      method: 'POST',
    });
  }

  async observability(workspace: vscode.Uri): Promise<ObservabilitySnapshot> {
    const daemon = await this.start(workspace);
    return await this.request<ObservabilitySnapshot>(daemon, '/v1/diagnostics/metrics');
  }

  async buildDebugBundle(workspace: vscode.Uri): Promise<DebugBundleResult> {
    const daemon = await this.start(workspace);
    return await this.request<DebugBundleResult>(daemon, '/v1/diagnostics/bundle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
  }

  async inventory(workspace: vscode.Uri): Promise<WorkspaceInventory | undefined> {
    const daemon = await this.start(workspace);
    try {
      return await this.request<WorkspaceInventory>(daemon, '/v1/workspace/inventory');
    } catch (err) {
      if (errorStatus(err) === 404) return undefined;
      throw err;
    }
  }

  async findings(workspace: vscode.Uri): Promise<FindingsResponse> {
    const daemon = await this.start(workspace);
    return await this.request<FindingsResponse>(daemon, '/v1/findings');
  }

  async staticAudit(workspace: vscode.Uri): Promise<StaticAuditReport> {
    const daemon = await this.start(workspace);
    return await this.request<StaticAuditReport>(daemon, '/v1/audit/static', { method: 'POST' });
  }

  async retest(workspace: vscode.Uri, findingId: string): Promise<RetestResult> {
    const daemon = await this.start(workspace);
    return await this.request<RetestResult>(
      daemon,
      `/v1/findings/${encodeURIComponent(findingId)}/retest`,
      { method: 'POST' },
    );
  }

  async createSandboxReproductionPlan(
    workspace: vscode.Uri,
    findingId: string,
    image: string,
  ): Promise<SandboxReproductionPlan> {
    const daemon = await this.start(workspace);
    return await this.request<SandboxReproductionPlan>(
      daemon,
      `/v1/findings/${encodeURIComponent(findingId)}/reproduction-plan`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image }),
      },
    );
  }

  async executeSandboxReproduction(
    workspace: vscode.Uri,
    findingId: string,
    plan: Pick<SandboxReproductionPlan, 'id' | 'planHash'>,
  ): Promise<SandboxReproductionResult> {
    const daemon = await this.start(workspace);
    return await this.request<SandboxReproductionResult>(
      daemon,
      `/v1/findings/${encodeURIComponent(findingId)}/reproduce`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: true,
          planId: plan.id,
          planHash: plan.planHash,
        }),
      },
    );
  }

  async reproductions(workspace: vscode.Uri): Promise<SandboxReproductionsResponse> {
    const daemon = await this.start(workspace);
    return await this.request<SandboxReproductionsResponse>(daemon, '/v1/reproductions');
  }

  async traffic(workspace: vscode.Uri): Promise<TrafficInventory | undefined> {
    const daemon = await this.start(workspace);
    try {
      return await this.request<TrafficInventory>(daemon, '/v1/traffic');
    } catch (err) {
      if (errorStatus(err) === 404) return undefined;
      throw err;
    }
  }

  async securityGraph(
    workspace: vscode.Uri,
    nodeId?: string,
    depth = 2,
  ): Promise<SecurityGraphResponse> {
    const daemon = await this.start(workspace);
    const query = nodeId
      ? `?nodeId=${encodeURIComponent(nodeId)}&depth=${Math.max(0, Math.min(depth, 5))}`
      : '';
    return await this.request<SecurityGraphResponse>(daemon, `/v1/security/graph${query}`);
  }

  async importHar(workspace: vscode.Uri, har: unknown): Promise<TrafficInventory> {
    const daemon = await this.start(workspace);
    return await this.request<TrafficInventory>(daemon, '/v1/traffic/import/har', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(har),
    });
  }

  async createIdentityReplayPlan(
    workspace: vscode.Uri,
    input: {
      requestId: string;
      allowedHost: string;
      identities: Array<{ id: string; label: string; headers: Record<string, string> }>;
      maxRequestsPerSecond?: number;
    },
  ): Promise<IdentityReplayPlan> {
    const daemon = await this.start(workspace);
    return await this.request<IdentityReplayPlan>(daemon, '/v1/traffic/replay/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async executeIdentityReplay(
    workspace: vscode.Uri,
    input: { planId: string; approvalHash: string; approved: true },
  ): Promise<IdentityReplayResult> {
    const daemon = await this.start(workspace);
    return await this.request<IdentityReplayResult>(daemon, '/v1/traffic/replay/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async hawkHealth(workspace: vscode.Uri): Promise<HawkHealthReport | undefined> {
    const daemon = await this.start(workspace);
    try {
      return await this.request<HawkHealthReport>(daemon, '/v1/hawk/health');
    } catch (err) {
      if (errorStatus(err) === 404) return undefined;
      throw err;
    }
  }

  async importHawkHealth(workspace: vscode.Uri, report: unknown): Promise<HawkHealthReport> {
    const daemon = await this.start(workspace);
    return await this.request<HawkHealthReport>(daemon, '/v1/hawk/health/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
  }

  async workspaceScanTemplates(workspace: vscode.Uri): Promise<WorkspaceScanTemplatesResponse> {
    const daemon = await this.start(workspace);
    return await this.request<WorkspaceScanTemplatesResponse>(daemon, '/v1/scans/templates');
  }

  async workspaceScanPlan(
    workspace: vscode.Uri,
    templateId: WorkspaceScanTemplateId,
  ): Promise<WorkspaceScanPlan> {
    const daemon = await this.start(workspace);
    return await this.request<WorkspaceScanPlan>(
      daemon,
      `/v1/scans/plan?templateId=${encodeURIComponent(templateId)}`,
    );
  }

  async runApprovedWorkspaceScan(
    workspace: vscode.Uri,
    plan: WorkspaceScanPlan,
  ): Promise<WorkspaceScanReport> {
    const daemon = await this.start(workspace);
    return await this.request<WorkspaceScanReport>(daemon, '/v1/scans/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approved: true,
        templateId: plan.templateId,
        approvalHash: plan.approvalHash,
      }),
    });
  }

  async buildEvidencePack(workspace: vscode.Uri): Promise<EvidencePackReport> {
    const daemon = await this.start(workspace);
    return await this.request<EvidencePackReport>(daemon, '/v1/reports/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
  }

  async securityTestTemplates(workspace: vscode.Uri): Promise<SecurityTestTemplatesResponse> {
    const daemon = await this.start(workspace);
    return await this.request<SecurityTestTemplatesResponse>(
      daemon,
      '/v1/security-tests/templates',
    );
  }

  async securityTestPlan(
    workspace: vscode.Uri,
    templateId: SecurityTestTemplateId,
    scopeHosts: string[] = [],
  ): Promise<SecurityTestPlan> {
    const daemon = await this.start(workspace);
    const query = new URLSearchParams({ templateId });
    for (const host of scopeHosts) query.append('host', host);
    return await this.request<SecurityTestPlan>(
      daemon,
      `/v1/security-tests/plan?${query.toString()}`,
    );
  }

  async runApprovedSecurityTest(
    workspace: vscode.Uri,
    plan: SecurityTestPlan,
  ): Promise<SecurityTestResult> {
    const daemon = await this.start(workspace);
    return await this.request<SecurityTestResult>(daemon, '/v1/security-tests/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approved: true,
        templateId: plan.templateId,
        scopeHosts: plan.scopeHosts,
        maxRequestsPerSecond: plan.rateLimit.maxRequestsPerSecond,
        approvalHash: plan.approvalHash,
      }),
    });
  }

  async createGovernedMission(
    workspace: vscode.Uri,
    objective: string,
    profile: GovernedMissionProfile,
    hosts: string[],
  ): Promise<GovernedMissionPlan> {
    const daemon = await this.start(workspace);
    return await this.request<GovernedMissionPlan>(daemon, '/v1/missions/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective, profile, hosts }),
    });
  }

  async createAiSession(
    workspace: vscode.Uri,
    prompt: string,
    context: string,
  ): Promise<AiSessionSummary> {
    const daemon = await this.start(workspace);
    return await this.request<AiSessionSummary>(daemon, '/v1/ai/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, context }),
    });
  }

  async createParallelAiBatch(
    workspace: vscode.Uri,
    objective: string,
    context: string,
    lanes = 3,
  ): Promise<AiParallelBatchResponse> {
    const daemon = await this.start(workspace);
    return await this.request<AiParallelBatchResponse>(daemon, '/v1/ai/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective, context, lanes }),
    });
  }

  async mergeAiBatch(
    workspace: vscode.Uri,
    sessionIds: string[],
    objective = '',
    context = '',
  ): Promise<AiMergeBatchResponse> {
    const daemon = await this.start(workspace);
    return await this.request<AiMergeBatchResponse>(daemon, '/v1/ai/batches/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds, objective, context }),
    });
  }

  async continueAiSession(
    workspace: vscode.Uri,
    sessionId: string,
    prompt: string,
    context: string,
  ): Promise<AiSessionSummary> {
    const daemon = await this.start(workspace);
    return await this.request<AiSessionSummary>(
      daemon,
      `/v1/ai/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, context }),
      },
    );
  }

  async aiSessions(workspace: vscode.Uri, limit = 30): Promise<AiSessionList> {
    const daemon = await this.start(workspace);
    return await this.request<AiSessionList>(daemon, `/v1/ai/sessions?limit=${limit}`);
  }

  async aiEvents(workspace: vscode.Uri, sessionId: string, after: number): Promise<AiEventPage> {
    const daemon = await this.start(workspace);
    return await this.request<AiEventPage>(
      daemon,
      `/v1/ai/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`,
    );
  }

  async aiDiff(workspace: vscode.Uri, sessionId: string): Promise<AiDiffResponse> {
    const daemon = await this.start(workspace);
    return await this.request<AiDiffResponse>(
      daemon,
      `/v1/ai/sessions/${encodeURIComponent(sessionId)}/diff`,
    );
  }

  async runAiTests(
    workspace: vscode.Uri,
    sessionId: string,
    gateIds: string[],
  ): Promise<AiSessionSummary> {
    return await this.aiAction(workspace, sessionId, 'tests', {
      approved: true,
      gateIds,
    });
  }

  async cancelAiTests(workspace: vscode.Uri, sessionId: string): Promise<AiSessionSummary> {
    return await this.aiAction(workspace, sessionId, 'tests/cancel', {
      approved: true,
    });
  }

  async applyAiSession(
    workspace: vscode.Uri,
    sessionId: string,
    patchHash: string,
    allowFailingTests: boolean,
  ): Promise<AiSessionSummary> {
    return await this.aiAction(workspace, sessionId, 'apply', {
      approved: true,
      patchHash,
      allowFailingTests,
    });
  }

  async checkpointAiSession(
    workspace: vscode.Uri,
    sessionId: string,
    label?: string,
  ): Promise<AiSessionSummary> {
    return await this.aiAction(workspace, sessionId, 'checkpoints', { label });
  }

  async restoreAiCheckpoint(
    workspace: vscode.Uri,
    sessionId: string,
    checkpointId: string,
  ): Promise<AiSessionSummary> {
    return await this.aiAction(workspace, sessionId, 'checkpoints/restore', {
      approved: true,
      checkpointId,
    });
  }

  async rejectAiSession(workspace: vscode.Uri, sessionId: string): Promise<AiSessionSummary> {
    return await this.aiAction(workspace, sessionId, 'reject', { approved: true });
  }

  async revertAiSession(workspace: vscode.Uri, sessionId: string): Promise<AiSessionSummary> {
    return await this.aiAction(workspace, sessionId, 'revert', { approved: true });
  }

  async cancelAiSession(workspace: vscode.Uri, sessionId: string): Promise<AiSessionSummary> {
    return await this.aiAction(workspace, sessionId, 'cancel', { approved: true });
  }

  async pauseAiSession(workspace: vscode.Uri, sessionId: string): Promise<AiSessionSummary> {
    return await this.aiAction(workspace, sessionId, 'pause', { approved: true });
  }

  async resumeAiSession(workspace: vscode.Uri, sessionId: string): Promise<AiSessionSummary> {
    return await this.aiAction(workspace, sessionId, 'resume', { approved: true });
  }

  dispose(): void {
    this.stop();
    this.output.dispose();
  }

  private stop(): void {
    const active = this.active;
    this.active = undefined;
    if (active && !active.child.killed) active.child.kill();
  }

  private async spawnDaemon(workspace: vscode.Uri): Promise<ActiveDaemon> {
    const configuredPath = vscode.workspace
      .getConfiguration('hawk')
      .get<string>('daemonPath', '')
      .trim();
    const embeddedDaemon = configuredPath ? undefined : bundledDaemonPath(this.extensionUri);
    const launch = embeddedDaemon
      ? { command: process.execPath, args: [embeddedDaemon, '--workspace', workspace.fsPath] }
      : {
          command: configuredPath || defaultDaemonCommand(),
          args: ['--workspace', workspace.fsPath],
        };
    this.output.appendLine(
      `Starting local agent for ${workspace.fsPath} (${embeddedDaemon ? 'bundled daemon' : launch.command})`,
    );
    const hawkConfiguration = vscode.workspace.getConfiguration('hawk');
    const preferredProvider = hawkConfiguration.get<string>('preferredProvider', '').trim();
    const preferredModel = hawkConfiguration.get<string>('preferredModel', '').trim();
    const preferredBaseUrl = hawkConfiguration.get<string>('preferredBaseUrl', '').trim();
    let preferredApiKey: string | undefined;
    if (preferredProvider && hawkLlmProvider(preferredProvider)) {
      try {
        preferredApiKey = await this.secrets?.get(llmSecretStorageKey(preferredProvider));
      } catch {
        // An unavailable OS keychain must not leak details or prevent the
        // daemon from starting; the provider will report a missing key.
      }
    }
    const editCacheTtlSeconds = clamp(
      hawkConfiguration.get<number>('tab.editPrediction.cacheTtlSeconds', 120),
      5,
      600,
    );
    const editCacheMaxEntries = clamp(
      hawkConfiguration.get<number>('tab.editPrediction.cacheMaxEntries', 256),
      32,
      512,
    );
    const daemonEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      ...(embeddedDaemon ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(preferredProvider ? { HAWK_IDE_BACKEND: preferredProvider } : {}),
      ...(preferredModel ? { HAWK_IDE_MODEL: preferredModel } : {}),
      ...(preferredBaseUrl ? { HAWK_IDE_BASE_URL: preferredBaseUrl } : {}),
      ...(preferredApiKey ? { HAWK_IDE_API_KEY: preferredApiKey } : {}),
      HAWK_IDE_EDIT_CACHE_ENABLED: hawkConfiguration.get<boolean>(
        'tab.editPrediction.cacheEnabled',
        true,
      )
        ? '1'
        : '0',
      HAWK_IDE_EDIT_CACHE_TTL_MS: String(Math.round(editCacheTtlSeconds * 1_000)),
      HAWK_IDE_EDIT_CACHE_MAX_ENTRIES: String(Math.round(editCacheMaxEntries)),
      ...(hawkConfiguration.get<boolean>('index.embeddings.enabled', false)
        ? { HAWK_IDE_EMBEDDINGS: '1' }
        : {}),
      ...(hawkConfiguration.get<string>('index.embeddings.model', '').trim()
        ? {
            HAWK_IDE_EMBEDDING_MODEL: hawkConfiguration
              .get<string>('index.embeddings.model', '')
              .trim(),
          }
        : {}),
      ...(hawkConfiguration.get<string>('index.embeddings.baseUrl', '').trim()
        ? {
            HAWK_IDE_EMBEDDING_BASE_URL: hawkConfiguration
              .get<string>('index.embeddings.baseUrl', '')
              .trim(),
          }
        : {}),
    };

    return await new Promise<ActiveDaemon>((resolveStart, rejectStart) => {
      const child = spawn(launch.command, launch.args, {
        cwd: workspace.fsPath,
        windowsHide: true,
        env: daemonEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      const reader = readline.createInterface({ input: child.stdout });
      const timeout = setTimeout(() => {
        finish(new Error(`Timed out waiting for ${launch.command} to start`));
      }, START_TIMEOUT_MS);

      const finish = (err?: Error, daemon?: ActiveDaemon): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reader.close();
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        if (err) {
          if (!child.killed) child.kill();
          rejectStart(err);
          return;
        }
        if (!daemon) {
          rejectStart(new Error('Daemon did not return a connection descriptor'));
          return;
        }
        this.active = daemon;
        daemon.child.once('exit', (code, signal) => {
          if (this.active === daemon) {
            this.output.appendLine(
              `Local agent stopped (code=${code ?? 'none'}, signal=${signal ?? 'none'})`,
            );
            this.active = undefined;
          }
        });
        resolveStart(daemon);
      };
      const onError = (err: Error): void => finish(err);
      const onExit = (code: number | null): void => {
        finish(
          new Error(`Local agent exited before startup completed (code=${code ?? 'unknown'})`),
        );
      };

      child.once('error', onError);
      child.once('exit', onExit);
      child.stderr.on('data', (chunk: Buffer) => {
        this.output.append(chunk.toString('utf8'));
      });
      reader.once('line', (line) => {
        try {
          const descriptor = parseDescriptor(line);
          finish(undefined, { ...descriptor, child, workspace });
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  private async request<T>(
    daemon: DaemonDescriptor,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('X-Hawk-Token', daemon.token);
    const response = await fetch(`${daemon.url}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new DaemonRequestError(response.status, await response.text());
    }
    return (await response.json()) as T;
  }

  private async aiAction(
    workspace: vscode.Uri,
    sessionId: string,
    action: string,
    body: Record<string, unknown>,
  ): Promise<AiSessionSummary> {
    const daemon = await this.start(workspace);
    return await this.request<AiSessionSummary>(
      daemon,
      `/v1/ai/sessions/${encodeURIComponent(sessionId)}/${action}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  }
}

class DaemonRequestError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Local agent request failed (${status}): ${body}`);
  }
}

function defaultDaemonCommand(): string {
  return process.platform === 'win32' ? 'hawk-ide-daemon.cmd' : 'hawk-ide-daemon';
}

function bundledDaemonPath(extensionUri?: vscode.Uri): string | undefined {
  if (!extensionUri) return undefined;
  const candidate = join(extensionUri.fsPath, 'dist', 'ide-daemon.cjs');
  return existsSync(candidate) ? candidate : undefined;
}

function parseDescriptor(line: string): DaemonDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('Local agent returned invalid startup JSON');
  }
  if (!value || typeof value !== 'object')
    throw new Error('Local agent returned an invalid descriptor');
  const record = value as Record<string, unknown>;
  if (
    typeof record.protocolVersion !== 'number' ||
    typeof record.url !== 'string' ||
    typeof record.token !== 'string' ||
    typeof record.workspaceRoot !== 'string'
  ) {
    throw new Error('Local agent descriptor is missing required fields');
  }
  if (!record.url.startsWith('http://127.0.0.1:') && !record.url.startsWith('http://localhost:')) {
    throw new Error('Refusing a non-loopback local agent URL');
  }
  const captureUrl = typeof record.captureUrl === 'string' ? record.captureUrl : undefined;
  const captureToken = typeof record.captureToken === 'string' ? record.captureToken : undefined;
  if (
    captureUrl &&
    !captureUrl.startsWith('http://127.0.0.1:') &&
    !captureUrl.startsWith('http://localhost:')
  ) {
    throw new Error('Refusing a non-loopback Hawk capture URL');
  }
  return {
    protocolVersion: record.protocolVersion,
    url: record.url,
    token: record.token,
    workspaceRoot: record.workspaceRoot,
    ...(captureUrl && captureToken ? { captureUrl, captureToken } : {}),
  };
}

function errorStatus(err: unknown): number | undefined {
  return err instanceof DaemonRequestError ? err.status : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum;
}
