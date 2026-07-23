/**
 * Stable data contracts shared by the desktop client and the local agent
 * daemon. The first milestone deliberately keeps the protocol small:
 * workspace inventory, health, and findings. New capabilities should extend
 * this module instead of coupling UI code to the agent runtime.
 */

export const IDE_PROTOCOL_VERSION = 13;

export type RouteFramework = 'express' | 'fastify' | 'next-app' | 'next-pages';

export interface WorkspaceRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: RouteFramework;
}

export interface WorkspaceInventory {
  protocolVersion: number;
  root: string;
  indexedAt: string;
  sourceFiles: number;
  routes: WorkspaceRoute[];
}

export type FindingStatus = 'suspected' | 'validated' | 'fixed' | 'retested';

export interface SecurityFinding {
  id: string;
  ruleId: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  status: FindingStatus;
  confidence: 'signal';
  createdAt: string;
  description: string;
  remediation: string;
  evidence: EvidenceSnippet[];
  route?: Pick<WorkspaceRoute, 'method' | 'path'>;
  source?: Pick<WorkspaceRoute, 'file' | 'line'>;
}

export interface EvidenceSnippet {
  kind: 'code';
  summary: string;
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

export interface IdentityReplayCredentialInput {
  id: string;
  label: string;
  headers: Record<string, string>;
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
  identities: Array<{
    id: string;
    label: string;
    headerNames: string[];
  }>;
  rateLimit: {
    maxRequests: number;
    maxRequestsPerSecond: number;
  };
  statement: string;
}

export interface IdentityReplayObservation {
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
}

export interface IdentityReplayResult {
  protocolVersion: number;
  id: string;
  planId: string;
  requestId: string;
  host: string;
  startedAt: string;
  completedAt: string;
  observations: IdentityReplayObservation[];
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

/** Sanitized, local-only import of a Hawk organization health report. */
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

/** A governed scan recipe. Templates never grant authority outside their declared policy. */
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

/** A transparent scan plan that is bound to an exact approval hash. */
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

/** Result of an approved governed scan. It is not a vulnerability verdict. */
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

export type EvidencePackFormat = 'markdown' | 'html' | 'json' | 'sarif';

export interface EvidencePackArtifact {
  format: EvidencePackFormat;
  path: string;
  bytes: number;
  sha256: string;
  previousSha256?: string;
  entrySha256?: string;
}

/** Sanitized, portable evidence bundle generated only after explicit operator approval. */
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

export type SandboxReproductionGateId = 'baseline' | 'control' | 'reproduction';
export type SandboxReproductionMode = 'offline-signal' | 'generic-sandbox';
export type GenericReproductionMode =
  | 'command'
  | 'http'
  | 'unit-test'
  | 'fuzz'
  | 'protocol'
  | 'dependency';

/** A user-supplied, offline command scenario for findings without a Hawk rule adapter. */
export interface GenericReproductionScenario {
  mode?: GenericReproductionMode;
  control: string[];
  reproduction: string[];
  controlExpectedExitCode?: number;
  reproductionExpectedExitCode?: number;
  label?: string;
}

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
  mode: SandboxReproductionMode;
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

/** A sandbox observation, never an automatic vulnerability verdict. */
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

export interface SecurityGraphNode {
  id: string;
  kind:
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
    | 'pull-request'
    | 'protocol'
    | 'infrastructure'
    | 'trust-boundary';
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

/** A bounded native view of Hawk's local source-to-runtime proof graph. */
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
    pullRequests: number;
    tests: number;
    protocols: number;
    infrastructure: number;
    trustBoundaries: number;
    reproductions: number;
    correlatedRequests: number;
    sourceLinkedFindings: number;
    evidenceLinkedFindings: number;
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

export interface ProtocolSurface {
  id: string;
  kind: ProtocolSurfaceKind;
  label: string;
  file: string;
  line: number;
  exposure: 'public' | 'authenticated' | 'internal' | 'unknown';
  authSignals: string[];
  evidence: string;
  provenance: 'hawk-protocol-intelligence';
}

export interface ProtocolSurfaceInventory {
  protocolVersion: number;
  scannedAt: string;
  sourceFiles: number;
  surfaces: ProtocolSurface[];
  summary: {
    total: number;
    public: number;
    authenticated: number;
    infrastructure: number;
    byKind: Partial<Record<ProtocolSurfaceKind, number>>;
  };
  truncated: boolean;
}

export interface AttackTwinPath {
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
}

/** An evidence-aware attack model. Hypotheses never become verdicts without reproduction gates. */
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
  paths: AttackTwinPath[];
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

export interface FleetNodeSnapshot {
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
}

export interface FleetSnapshot {
  protocolVersion: number;
  generatedAt: string;
  nodes: FleetNodeSnapshot[];
  summary: {
    total: number;
    online: number;
    availableSlots: number;
    activeTasks: number;
    capabilities: string[];
  };
}

export interface FleetDispatchPlan {
  protocolVersion: number;
  id: string;
  createdAt: string;
  expiresAt: string;
  strategy: 'balanced' | 'latency' | 'throughput';
  workspaceDigest: string;
  imageDigest: string;
  assignments: Array<{
    taskId: string;
    nodeId: string;
    endpoint: string;
    fingerprint: string;
    score: number;
    reasons: string[];
    dispatchHash: string;
  }>;
  unassignedTaskIds: string[];
  statement: string;
}

export interface McpTrustVerdict {
  protocolVersion: number;
  name: string;
  version: string;
  artifactSha256: string;
  manifestFingerprint: string;
  trusted: boolean;
  signature: 'verified' | 'missing' | 'invalid';
  decision: 'allow' | 'require-approval' | 'deny';
  findings: string[];
  capabilities: string[];
  checkedAt: string;
}

export type GovernedMissionProfile = 'review' | 'remediate' | 'authorized-validation';

export interface GovernedMissionNode {
  id: string;
  title: string;
  capabilityId: string;
  dependsOn: string[];
  parallelGroup: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  approvalRequired: boolean;
  modelClass: string;
}

/** A persisted Smart MCP-compatible plan. Creating it never starts execution. */
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
  nodes: GovernedMissionNode[];
  reportPath: string;
  createdAt: string;
}

export interface DaemonHealth {
  ok: true;
  protocolVersion: number;
  workspaceRoot: string;
}
