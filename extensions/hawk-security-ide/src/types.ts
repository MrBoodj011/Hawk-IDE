export interface DaemonDescriptor {
  protocolVersion: number;
  url: string;
  token: string;
  workspaceRoot: string;
  captureUrl?: string;
  captureToken?: string;
}

export interface DaemonHealth {
  ok: true;
  protocolVersion: number;
  workspaceRoot: string;
}

export interface WorkspaceRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;
}

export interface WorkspaceInventory {
  protocolVersion: number;
  root: string;
  indexedAt: string;
  sourceFiles: number;
  routes: WorkspaceRoute[];
}

export interface SemanticIndexStats {
  indexedAt: string;
  files: number;
  chunks: number;
  symbols: number;
  types: number;
  imports: number;
  calls: number;
  bytes: number;
  durationMs: number;
  truncated: boolean;
  reusedFiles: number;
  changedFiles: number;
  persistent: boolean;
  memory: {
    residentBytes: number;
    budgetBytes: number;
  };
  embedding: {
    enabled: boolean;
    model?: string;
    chunks: number;
    dimensions: number;
    status: 'disabled' | 'ready' | 'unavailable';
    error?: string;
  };
}

export interface SemanticSearchResult {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  symbols: string[];
  types: string[];
  imports: string[];
  preview: string;
  match: 'lexical' | 'hybrid';
}

export interface SemanticSearchResponse {
  query: string;
  results: SemanticSearchResult[];
  stats?: SemanticIndexStats;
}

export interface InlineCompletionResponse {
  text: string;
  provider?: string;
  model?: string;
  latencyMs: number;
  contextFiles: string[];
}

export interface EditPredictionResponse extends InlineCompletionResponse {
  replaceText: string;
  kind: 'next-edit';
  confidence: number;
  predictionId: string;
  cached: boolean;
  cacheKind: 'miss' | 'exact' | 'continuation' | 'in-flight';
}

export interface MultiFileEditPredictionDocument {
  file: string;
  languageId: string;
  content: string;
}

export interface MultiFilePredictedEdit {
  file: string;
  oldText: string;
  newText: string;
  baseSha256: string;
}

export interface MultiFileEditPredictionResponse {
  kind: 'multi-file-next-edit';
  summary: string;
  confidence: number;
  edits: MultiFilePredictedEdit[];
  provider?: string;
  model?: string;
  latencyMs: number;
  contextFiles: string[];
  predictionId: string;
  cached: boolean;
  cacheKind: 'miss' | 'exact' | 'in-flight';
}

export interface EditPredictionModelEvaluation {
  provider: string;
  model: string;
  generations: number;
  validSuggestions: number;
  suggestionsServed: number;
  cacheServed: number;
  inFlightServed: number;
  accepted: number;
  rejected: number;
  feedbackSamples: number;
  feedbackCoverage: number;
  validRate: number;
  acceptanceRate?: number;
  p50GenerationMs?: number;
  p95GenerationMs?: number;
  score: number;
  confidence: 'low' | 'medium' | 'high';
}

export interface EditPredictionEvaluationReport {
  measuredAt: string;
  privacy: string;
  cache: {
    enabled: boolean;
    entries: number;
    maxEntries: number;
    ttlMs: number;
    requests: number;
    exactHits: number;
    continuationHits: number;
    inFlightJoins: number;
    misses: number;
    hitRate: number;
  };
  totals: {
    generations: number;
    validSuggestions: number;
    suggestionsServed: number;
    feedbackSamples: number;
  };
  recommended?: {
    provider: string;
    model: string;
    score: number;
    confidence: 'low' | 'medium' | 'high';
  };
  models: EditPredictionModelEvaluation[];
}

export interface CodingCoreBenchmark {
  measuredAt: string;
  semanticIndex: SemanticIndexStats;
  search: {
    samples: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    resultsReturned: number;
  };
  completion: {
    samples: number;
    p50Ms?: number;
    p95Ms?: number;
  };
  process: {
    baselineRssBytes: number;
    rssBytes: number;
    peakRssBytes: number;
    rssDeltaBytes: number;
    heapUsedBytes: number;
    memoryBudgetBytes: number;
  };
  gates: {
    indexUnderFiveSeconds: boolean;
    searchP95UnderFiftyMs: boolean;
    rssUnder500Mb: boolean;
  };
}

export interface SecurityFinding {
  id: string;
  ruleId: string;
  title: string;
  severity: string;
  status: string;
  confidence: 'signal';
  createdAt: string;
  description: string;
  remediation: string;
  evidence: Array<{ kind: 'code'; summary: string }>;
  source?: { file: string; line: number };
}

export interface FindingsResponse {
  findings: SecurityFinding[];
}

export interface StaticAuditReport {
  protocolVersion: number;
  scannedAt: string;
  sourceFiles: number;
  findings: SecurityFinding[];
}

export interface RetestResult {
  finding: SecurityFinding;
  present: boolean;
}

export type SandboxReproductionGateId = 'baseline' | 'control' | 'reproduction';

export interface SandboxReproductionPlan {
  protocolVersion: number;
  id: string;
  findingId: string;
  ruleId: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  planHash: string;
  image: string;
  mode: 'offline-signal';
  source: { file: string; line: number; sha256: string };
  isolation: {
    workspace: 'read-only';
    rootFilesystem: 'read-only';
    network: 'none';
    capabilities: 'dropped';
    maxCpu: number;
    maxMemoryMb: number;
    maxSeconds: number;
    maxArtifactMb: number;
  };
  gates: Array<{
    id: SandboxReproductionGateId;
    title: string;
    purpose: string;
  }>;
  statement: string;
}

export interface SandboxReproductionGateResult {
  id: SandboxReproductionGateId;
  status: 'passed' | 'failed';
  durationMs: number;
  instanceId?: string;
  evidenceDigest?: string;
  message: string;
}

export interface SandboxReproductionResult {
  protocolVersion: number;
  id: string;
  planId: string;
  planHash: string;
  findingId: string;
  ruleId: string;
  image: string;
  orchestrationRunId: string;
  status: 'reproduced' | 'not-reproduced' | 'failed';
  lifecycle: 'signal' | 'reproduced';
  promotedToVerified: false;
  startedAt: string;
  completedAt: string;
  gates: SandboxReproductionGateResult[];
  missingVerificationGates: string[];
  statement: string;
}

export interface SandboxReproductionsResponse {
  reproductions: SandboxReproductionResult[];
}

export interface TrafficRequest {
  id: string;
  method: string;
  url: string;
  host: string;
  status?: number;
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  source?: 'har' | 'browser' | 'burp';
  initiator?: string;
  type?: string;
}

export interface TrafficInventory {
  protocolVersion: number;
  importedAt: string;
  source: 'har' | 'live' | 'mixed';
  hosts: string[];
  requests: TrafficRequest[];
  truncated: boolean;
  live: boolean;
}

export interface IdentityReplayPlan {
  protocolVersion: number;
  id: string;
  createdAt: string;
  expiresAt: string;
  approvalHash: string;
  request: {
    id: string;
    method: string;
    url: string;
    host: string;
  };
  identities: Array<{ id: string; label: string; headerNames: string[] }>;
  rateLimit: { maxRequests: number; maxRequestsPerSecond: number };
  statement: string;
}

export interface IdentityReplayResult {
  protocolVersion: number;
  id: string;
  planId: string;
  requestId: string;
  host: string;
  startedAt: string;
  completedAt: string;
  observations: Array<{
    identityId: string;
    label: string;
    status?: number;
    elapsedMs: number;
    contentType?: string;
    location?: string;
    bodyBytesObserved: number;
    bodyPrefixSha256?: string;
    truncated: boolean;
    matchesBaseline?: boolean;
    error?: string;
  }>;
  statement: string;
}

export interface HawkHealthSummary {
  repositories: number;
  maintenanceScore?: number;
  governanceScore?: number;
  highRiskRepositories: number;
  failedUpdatePulls: number;
  overdueSecurityAlerts: number;
  securityAlerts: number;
  criticalSecurityAlerts: number;
  highSecurityAlerts: number;
  sbomRepositories: number;
  trackedPackages: number;
  unknownPackageLicenses: number;
  securityUnknown: number;
  inspectionErrors: number;
}

export interface HawkRepositoryRisk {
  name: string;
  url?: string;
  score: number;
  level: 'critical' | 'high' | 'moderate' | 'low' | 'unknown';
  reasons: string[];
  securityAlerts: number | null;
  criticalAlerts: number;
  highAlerts: number;
  overdueSecurityAlerts: number;
  failedChecks: number;
  sbomPackages: number;
  unknownLicenses: number;
}

export interface HawkHealthReport {
  protocolVersion: number;
  source: 'hawk-health-json';
  importedAt: string;
  generatedAt?: string;
  organization?: string;
  outcome?: string;
  summary: HawkHealthSummary;
  priorityQueue: HawkRepositoryRisk[];
}

export type WorkspaceScanTemplateId = 'passive-workspace' | 'runtime-observe' | 'release-gate';

export interface WorkspaceScanRateLimit {
  maxRequestsPerSecond: number;
  maxRequests: number;
}

export interface WorkspaceScanTemplate {
  id: WorkspaceScanTemplateId;
  title: string;
  description: string;
  scope: WorkspaceScanTemplateId;
  mode: 'passive' | 'observe';
  requiresApproval: true;
  networkPolicy: 'offline' | 'captured-only';
  rateLimit: WorkspaceScanRateLimit;
  checks: string[];
}

export interface WorkspaceScanTemplatesResponse {
  protocolVersion: number;
  templates: WorkspaceScanTemplate[];
}

export interface WorkspaceScanPlan {
  protocolVersion: number;
  createdAt: string;
  templateId: WorkspaceScanTemplateId;
  title: string;
  scope: WorkspaceScanTemplateId;
  workspaceRoot: string;
  requiresApproval: true;
  approvalHash: string;
  networkPolicy: 'offline' | 'captured-only';
  rateLimit: WorkspaceScanRateLimit;
  statement: string;
  checks: string[];
}

export interface WorkspaceScanReport {
  protocolVersion: number;
  id: string;
  status: 'completed';
  templateId: WorkspaceScanTemplateId;
  title: string;
  scope: WorkspaceScanTemplateId;
  approvalHash: string;
  createdAt: string;
  completedAt: string;
  reportPath: string;
  sourceFiles: number;
  routes: number;
  findings: SecurityFinding[];
  trafficRequests: number;
  hawkOrganization?: string;
  statement: string;
}

export type SecurityTestTemplateId =
  | 'static-code'
  | 'route-coverage'
  | 'dependency-manifest'
  | 'sandbox-signal';

export interface SecurityTestTemplate {
  id: SecurityTestTemplateId;
  title: string;
  description: string;
  execution: 'offline' | 'captured-only' | 'sandbox-plan';
  networkPolicy: 'offline' | 'captured-only';
  requiresApproval: true;
  rateLimit: { maxRequestsPerSecond: number; maxRequests: number };
  checks: string[];
  safety: string;
}

export interface SecurityTestTemplatesResponse {
  protocolVersion: number;
  templates: SecurityTestTemplate[];
}

export interface SecurityTestPlan {
  protocolVersion: number;
  id: string;
  createdAt: string;
  templateId: SecurityTestTemplateId;
  title: string;
  workspaceRoot: string;
  scopeHosts: string[];
  execution: SecurityTestTemplate['execution'];
  networkPolicy: SecurityTestTemplate['networkPolicy'];
  rateLimit: { maxRequestsPerSecond: number; maxRequests: number };
  checks: string[];
  approvalHash: string;
  policyHash: string;
  governance: {
    decision: 'allow' | 'require-approval' | 'deny';
    reasons: string[];
    policyHash: string;
  };
  statement: string;
}

export interface SecurityTestResult {
  protocolVersion: number;
  id: string;
  planId: string;
  templateId: SecurityTestTemplateId;
  status: 'completed';
  approvalHash: string;
  policyHash: string;
  startedAt: string;
  completedAt: string;
  sourceFiles: number;
  routes: number;
  findings: SecurityFinding[];
  trafficRequests: number;
  observedRoutes: number;
  dependency?: {
    manifests: string[];
    lockfiles: string[];
    installScripts: string[];
    packageManagers: string[];
  };
  reportPath: string;
  statement: string;
}

export interface EvidencePackArtifact {
  format: 'markdown' | 'html' | 'json' | 'sarif';
  path: string;
  bytes: number;
  sha256: string;
  previousSha256?: string;
  entrySha256?: string;
}

export interface EvidencePackReport {
  protocolVersion: number;
  id: string;
  status: 'completed';
  createdAt: string;
  directoryPath: string;
  primaryReportPath: string;
  statement: string;
  sourceFiles: number;
  routes: number;
  observedRoutes: number;
  trafficRequests: number;
  findings: number;
  artifacts: EvidencePackArtifact[];
  chainVersion?: 1;
  chainRootSha256?: string;
}

export type SecurityGraphNodeKind =
  | 'repository'
  | 'file'
  | 'symbol'
  | 'route'
  | 'request'
  | 'finding'
  | 'evidence'
  | 'patch'
  | 'test'
  | 'agent'
  | 'protocol'
  | 'infrastructure'
  | 'trust-boundary';

export interface SecurityGraphNode {
  id: string;
  kind: SecurityGraphNodeKind;
  label: string;
  attributes: Record<string, string | number | boolean>;
}

export interface SecurityGraphEdge {
  id: string;
  from: string;
  to: string;
  relation: string;
  attributes: Record<string, string | number | boolean>;
}

export interface SecurityGraphResponse {
  protocolVersion: number;
  updatedAt: string;
  summary: {
    nodes: number;
    edges: number;
    sourceFiles: number;
    symbols: number;
    routes: number;
    requests: number;
    findings: number;
    evidence: number;
    patches: number;
    tests: number;
    protocols: number;
    infrastructure: number;
    trustBoundaries: number;
    correlatedRequests: number;
    sourceLinkedFindings: number;
    evidenceLinkedFindings: number;
    reproductions: number;
  };
  nodes: SecurityGraphNode[];
  edges: SecurityGraphEdge[];
  truncated: boolean;
}

export type ProtocolSurfaceKind =
  | 'graphql'
  | 'websocket'
  | 'grpc'
  | 'openapi'
  | 'oauth-oidc'
  | 'saml'
  | 'kubernetes'
  | 'terraform'
  | 'cloud-iam'
  | 'mobile-api';

export interface ProtocolSurfaceInventory {
  protocolVersion: number;
  scannedAt: string;
  sourceFiles: number;
  surfaces: Array<{
    id: string;
    kind: ProtocolSurfaceKind;
    label: string;
    file: string;
    line: number;
    exposure: 'public' | 'authenticated' | 'internal' | 'unknown';
    authSignals: string[];
    evidence: string;
    provenance: 'hawk-protocol-intelligence';
  }>;
  summary: {
    total: number;
    public: number;
    authenticated: number;
    infrastructure: number;
    byKind: Partial<Record<ProtocolSurfaceKind, number>>;
  };
  truncated: boolean;
}

export interface AttackTwinResponse {
  protocolVersion: number;
  generatedAt: string;
  summary: {
    entryPoints: number;
    protocolSurfaces: number;
    trustBoundaries: number;
    hypotheses: number;
    reproducedPaths: number;
    verifiedPaths: number;
    highestScore: number;
  };
  paths: Array<{
    id: string;
    title: string;
    score: number;
    status: 'hypothesis' | 'reproduced' | 'verified';
    entryPoint: string;
    protocol: ProtocolSurfaceKind | 'http-route';
    assets: string[];
    findingIds: string[];
    evidenceNodeIds: string[];
    sourceFiles: string[];
    rationale: string[];
    recommendedNextGate: string;
  }>;
  trustBoundaries: Array<{
    id: string;
    label: string;
    kind: 'identity' | 'network' | 'runtime' | 'cloud';
    sourceFiles: string[];
  }>;
  whatIf: Array<{
    id: string;
    premise: string;
    affectedPathIds: string[];
    estimatedBlastRadius: number;
    statement: string;
  }>;
  statement: string;
}

export interface AutonomousSecurityPlan {
  protocolVersion: number;
  id: string;
  createdAt: string;
  expiresAt: string;
  workspaceRoot: string;
  objective: string;
  planHash: string;
  networkPolicy: 'offline' | 'captured-only';
  scopeHosts: string[];
  stages: Array<{
    id: 'inventory' | 'protocols' | 'static-audit' | 'attack-twin' | 'reproduction-gates';
    title: string;
    execution: 'automatic' | 'approval-gate';
    risk: 'low' | 'medium' | 'high';
  }>;
  statement: string;
}

export interface AutonomousSecurityRun {
  protocolVersion: number;
  id: string;
  planId: string;
  planHash: string;
  status: 'completed' | 'completed-with-gates';
  startedAt: string;
  completedAt: string;
  stages: Array<{
    id: AutonomousSecurityPlan['stages'][number]['id'];
    status: 'completed' | 'awaiting-approval';
    startedAt: string;
    completedAt: string;
    summary: string;
    artifactDigest: string;
  }>;
  summary: {
    sourceFiles: number;
    protocolSurfaces: number;
    findings: number;
    attackPaths: number;
    reproductionGates: number;
  };
  statement: string;
}

export interface FleetSnapshot {
  protocolVersion: number;
  generatedAt: string;
  nodes: Array<{
    id: string;
    label: string;
    endpoint: string;
    fingerprint: string;
    capabilities: string[];
    platform: string;
    arch: string;
    maxConcurrent: number;
    activeTasks: number;
    cpuPercent: number;
    memoryMbAvailable: number;
    status: 'online' | 'draining' | 'offline' | 'revoked';
    registeredAt: string;
    lastHeartbeatAt: string;
  }>;
  summary: {
    total: number;
    online: number;
    availableSlots: number;
    activeTasks: number;
    capabilities: string[];
  };
}

export interface McpTrustPosture {
  protocolVersion: number;
  pins: number;
  verdicts: number;
  allowed: number;
  requireApproval: number;
  denied: number;
}

export interface GovernedMemoryPosture {
  protocolVersion: number;
  active: number;
  stale: number;
  revoked: number;
  checkedAt: string;
}

export type GovernedMissionProfile = 'review' | 'remediate' | 'authorized-validation';

export interface GovernedMissionPlan {
  protocolVersion: number;
  id: string;
  goalId: string;
  profile: GovernedMissionProfile;
  objective: string;
  planHash: string;
  decision: 'allow' | 'require-approval' | 'deny';
  reasons: string[];
  allowedActions: string[];
  hosts: string[];
  maxParallel: number;
  estimatedMinutes: number;
  estimatedCostUsd: number;
  approvalRequired: boolean;
  nodes: Array<{
    id: string;
    title: string;
    capabilityId: string;
    dependsOn: string[];
    parallelGroup: string;
    risk: 'low' | 'medium' | 'high' | 'critical';
    approvalRequired: boolean;
    modelClass: string;
  }>;
  reportPath: string;
  createdAt: string;
}

export type AiSessionStatus =
  | 'preparing'
  | 'running'
  | 'paused'
  | 'testing'
  | 'awaiting-review'
  | 'applied'
  | 'rejected'
  | 'reverted'
  | 'cancelled'
  | 'failed';

export interface AiSessionEvent {
  id: number;
  at: string;
  type:
    | 'status'
    | 'plan'
    | 'assistant-delta'
    | 'assistant-text'
    | 'tool-call'
    | 'tool-result'
    | 'test-output'
    | 'diff-ready'
    | 'error'
    | 'done';
  text: string;
  tool?: string;
  durationMs?: number;
}

export interface AiDiffSummary {
  patchHash: string;
  files: number;
  insertions: number;
  deletions: number;
  bytes: number;
  truncated: boolean;
}

export interface AiTestGate {
  id: string;
  label: string;
  command: string;
  args: string[];
}

export interface AiTestResult {
  gateId: string;
  label: string;
  status: 'passed' | 'failed' | 'cancelled';
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface AiVerificationAttempt {
  attempt: number;
  startedAt: string;
  completedAt: string;
  patchHash?: string;
  outcome: 'passed' | 'failed' | 'cancelled';
  results: AiTestResult[];
}

export interface AiCheckpointSummary {
  id: string;
  label: string;
  createdAt: string;
  patchHash: string;
  files: number;
}

export interface AiDockerExecutionSummary {
  kind: 'docker';
  /** Scheduler lane/session identity; omitted only on legacy persisted runs. */
  laneId?: string;
  batchId: string;
  image: string;
  resolvedImage: string;
  instanceId: string;
  schedulingScore: number;
  schedulingReasons: string[];
  criticalPathSeconds: number;
  cpu: number;
  memoryMb: number;
  networkMode: 'provider-egress' | 'none';
  strategy?: 'balanced' | 'latency' | 'throughput';
  dockerVersion?: string;
}

export interface AiSessionSummary {
  id: string;
  title: string;
  prompt: string;
  status: AiSessionStatus;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  model?: string;
  execution?: AiDockerExecutionSummary;
  background: boolean;
  autoResume: boolean;
  resumeCount: number;
  autoVerify: boolean;
  maxAutoFixAttempts: number;
  autoFixAttempt: number;
  verificationHistory: AiVerificationAttempt[];
  error?: string;
  diff?: AiDiffSummary;
  checkpoints: AiCheckpointSummary[];
  sandboxPath?: string;
  testGates: AiTestGate[];
  testResults: AiTestResult[];
  canApply: boolean;
  canReject: boolean;
  canRevert: boolean;
  canCheckpoint: boolean;
  canPause: boolean;
  canResume: boolean;
  canOpenTerminal: boolean;
}

export interface AiSessionList {
  sessions: AiSessionSummary[];
}

export interface AiEventPage {
  events: AiSessionEvent[];
  next: number;
  session: AiSessionSummary;
}

export interface AiDiffResponse {
  sessionId: string;
  patch: string;
  summary: AiDiffSummary;
}

export interface AiParallelBatchResponse {
  batchId: string;
  createdAt: string;
  scheduler: {
    runtime: 'docker';
    strategy: 'balanced' | 'latency' | 'throughput';
    dockerVersion?: string;
  };
  sessions: AiSessionSummary[];
}

export type AiBatchLifecycle =
  | 'preparing'
  | 'running'
  | 'paused'
  | 'awaiting-review'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AiBatchStatus {
  batchId: string;
  createdAt: string;
  updatedAt: string;
  lifecycle: AiBatchLifecycle;
  scheduler: AiParallelBatchResponse['scheduler'];
  counts: Partial<Record<AiSessionStatus, number>>;
  sessions: AiSessionSummary[];
}

export interface AiBatchEvent extends AiSessionEvent {
  sessionId: string;
  batchId: string;
  laneId?: string;
}

export interface AiBatchEventPage {
  events: AiBatchEvent[];
  next: Record<string, number>;
  batch: AiBatchStatus;
}

export interface AiMergeBatchResponse {
  mergeSession: AiSessionSummary;
  candidates: Array<{ sessionId: string; score: number; reasons: string[] }>;
  semanticMerge: {
    engine: 'typescript-ast-v1' | 'hawk-semantic-v2';
    primaryCandidateId: string;
    candidateIds: string[];
    filesAnalyzed: number;
    astFilesAnalyzed: number;
    automaticallyMergedUnits: Array<{
      path: string;
      unit: string;
      candidateId: string;
      strategy: 'whole-file' | 'ast-add' | 'ast-update' | 'ast-delete';
    }>;
    conflicts: Array<{
      path: string;
      unit: string;
      candidateIds: string[];
      reason: string;
    }>;
  };
}

export interface ObservabilitySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  uptimeSeconds: number;
  totals: {
    requests: number;
    errors: number;
    active: number;
    status2xx: number;
    status4xx: number;
    status5xx: number;
  };
  process: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
  routes: Array<{
    method: string;
    route: string;
    requests: number;
    errors: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
  }>;
  recentTraces: Array<{
    id: string;
    method: string;
    route: string;
    status: number;
    startedAt: string;
    completedAt: string;
    durationMs: number;
  }>;
}

export interface DebugBundleResult {
  schemaVersion: 1;
  generatedAt: string;
  path: string;
  manifestPath: string;
  sha256: string;
  bytes: number;
}
