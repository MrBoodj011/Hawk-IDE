export type HawkRisk = 'low' | 'medium' | 'high' | 'critical';
export type HawkApprovalMode = 'never' | 'on-risk' | 'always';
export type HawkAction =
  | 'read-workspace'
  | 'write-workspace'
  | 'run-local'
  | 'run-container'
  | 'network-access'
  | 'credential-access'
  | 'active-security-test';

export interface GoalScope {
  repositories: string[];
  hosts: string[];
  routes: string[];
  identities: string[];
}

export interface GoalBudgets {
  maxParallel: number;
  maxMinutes: number;
  maxTokens: number;
  maxCostUsd: number;
  requestsPerSecond: number;
}

export interface GoalSpec {
  protocolVersion: 1;
  id: string;
  objective: string;
  workspaceRoot: string;
  scope: GoalScope;
  allowedActions: HawkAction[];
  forbiddenActions: HawkAction[];
  budgets: GoalBudgets;
  modelPolicy: {
    dataPolicy: 'local-only' | 'allow-hosted';
    preferredModels: Record<string, string>;
  };
  approvalMode: HawkApprovalMode;
  successCriteria: string[];
  retentionDays: number;
  createdAt: string;
}

export interface CapabilityDescriptor {
  id: string;
  title: string;
  description: string;
  category:
    | 'context'
    | 'code'
    | 'traffic'
    | 'supply-chain'
    | 'validation'
    | 'remediation'
    | 'governance';
  risk: HawkRisk;
  requiredActions: HawkAction[];
  deterministic: boolean;
  averageDurationSeconds: number;
  estimatedCostUsd: number;
  reliability: number;
  evidenceKinds: string[];
  provenance: 'hawk-core' | 'mcp-server' | 'external-agent';
  version: string;
  enabled: boolean;
}

export interface PlanNode {
  id: string;
  title: string;
  capabilityId: string;
  dependsOn: string[];
  parallelGroup: string;
  risk: HawkRisk;
  approvalRequired: boolean;
  expectedEvidence: string[];
  timeoutSeconds: number;
  retries: number;
  agentRole:
    | 'context'
    | 'code-review'
    | 'traffic-analysis'
    | 'supply-chain'
    | 'evidence-verifier'
    | 'runtime-validator'
    | 'patch-engineer'
    | 'regression-judge';
  modelRoute: {
    modelClass: 'deterministic' | 'local-small' | 'local-code' | 'hosted-reasoning' | 'hosted-code';
    providerModel?: string;
    dataPolicy: 'local-only' | 'allow-hosted';
    rationale: string;
  };
  independentVerifierModelClass?: 'deterministic' | 'local-small' | 'hosted-reasoning';
}

export interface HawkPlan {
  protocolVersion: 1;
  id: string;
  goalId: string;
  goalHash: string;
  objective: string;
  nodes: PlanNode[];
  maxParallel: number;
  estimatedMinutes: number;
  estimatedCostUsd: number;
  approvalRequired: boolean;
  approvalReasons: string[];
  planHash: string;
  createdAt: string;
}

export type PolicyDecision = 'allow' | 'require-approval' | 'deny';

export interface PolicyEvaluation {
  decision: PolicyDecision;
  reasons: string[];
  missingActions: HawkAction[];
  planHash: string;
}

export interface PlanApproval {
  id: string;
  goalId: string;
  planId: string;
  planHash: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
}

export type SmartRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting-approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type SmartRunNodeStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface SmartRunNode {
  id: string;
  title: string;
  capabilityId: string;
  status: SmartRunNodeStatus;
  dependsOn: string[];
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  artifactUri?: string;
  resultDigest?: string;
  error?: string;
}

export interface SmartRun {
  protocolVersion: 1;
  id: string;
  goalId: string;
  planId: string;
  planHash: string;
  status: SmartRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  pauseRequested: boolean;
  cancelRequested: boolean;
  executionInputs: Record<string, unknown>;
  lease?: {
    owner: string;
    heartbeatAt: string;
    expiresAt: string;
  };
  eventCount: number;
  lastEventHash: string;
  nodes: SmartRunNode[];
  summary: {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    skipped: number;
    cancelled: number;
  };
}

export interface SmartRunEvent {
  protocolVersion: 1;
  runId: string;
  sequence: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export type ProofNodeKind =
  | 'repository'
  | 'commit'
  | 'file'
  | 'symbol'
  | 'route'
  | 'identity'
  | 'request'
  | 'response'
  | 'finding'
  | 'evidence'
  | 'patch'
  | 'test'
  | 'run'
  | 'agent'
  | 'tool'
  | 'model';

export interface ProofNode {
  id: string;
  kind: ProofNodeKind;
  label: string;
  attributes: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface ProofEdge {
  id: string;
  from: string;
  to: string;
  relation: string;
  attributes: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface ProofGraphSnapshot {
  protocolVersion: 1;
  updatedAt: string;
  nodes: ProofNode[];
  edges: ProofEdge[];
}

export type FindingLifecycle =
  | 'signal'
  | 'hypothesis'
  | 'reproduced'
  | 'verified'
  | 'fixed'
  | 'retested'
  | 'rejected';

export interface VerificationInput {
  findingId: string;
  baselineObserved: boolean;
  reproduced: boolean;
  independentReproduction: boolean;
  identityValid: boolean;
  impactDemonstrated: boolean;
  withinScope: boolean;
  noUnsafeSideEffects: boolean;
  secretsRedacted: boolean;
  evidenceUris: string[];
  verifier: string;
  notes?: string;
}

export interface VerificationResult {
  findingId: string;
  lifecycle: FindingLifecycle;
  verified: boolean;
  confidence: number;
  failedGates: string[];
  evidenceUris: string[];
  verifiedAt: string;
  verifier: string;
  notes?: string;
}

export interface GovernedMemoryEntry {
  id: string;
  layer: 'run' | 'project' | 'organization';
  key: string;
  value: string;
  sourceUri: string;
  evidenceUris: string[];
  confidence: number;
  verified: boolean;
  reviewer: string;
  createdAt: string;
  expiresAt: string;
  contentHash: string;
}

export interface SentinelFinding {
  id: string;
  severity: HawkRisk;
  category:
    | 'tool-poisoning'
    | 'rug-pull'
    | 'secret-exposure'
    | 'prompt-injection'
    | 'unsafe-egress'
    | 'unsigned-server';
  message: string;
  location: string;
}

export interface SentinelReport {
  protocolVersion: 1;
  fingerprint: string;
  trusted: boolean;
  findings: SentinelFinding[];
  checkedAt: string;
}
