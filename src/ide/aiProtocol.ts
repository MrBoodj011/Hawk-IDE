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

export type AiEventType =
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

export interface AiSessionEvent {
  id: number;
  at: string;
  type: AiEventType;
  text: string;
  /** Stable linkage for events emitted by a parallel Docker lane. */
  sessionId?: string;
  batchId?: string;
  laneId?: string;
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

export type AiQualityGateStatus = 'pending' | 'passed' | 'failed' | 'not-run';

export interface AiSemanticReviewSummary {
  status: 'passed' | 'failed';
  engine: 'hawk-semantic-v2';
  filesChecked: number;
  astFilesChecked: number;
  conflicts: number;
  reviewHash: string;
  reviewedAt: string;
}

export interface AiReproductionSummary {
  status: 'passed' | 'failed';
  command: string[];
  exitCode: number | null;
  expectedExitCode: number;
  durationMs: number;
  output: string;
  reproducedAt: string;
}

export interface AiQualityGateSummary {
  reproduction: AiQualityGateStatus;
  tests: AiQualityGateStatus;
  semanticReview: AiQualityGateStatus;
  reproductionResult?: AiReproductionSummary;
  semanticReviewResult?: AiSemanticReviewSummary;
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
  /** Scheduler metadata is copied onto every lane so the UI can render the
   * batch placement without a second scheduler call. */
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
  branchScope?: string;
  testGates: AiTestGate[];
  testResults: AiTestResult[];
  quality: AiQualityGateSummary;
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

export interface AiCreateSessionRequest {
  prompt: string;
  context?: string;
  background?: boolean;
  autoResume?: boolean;
  autoVerify?: boolean;
  autoVerifyApproved?: true;
  maxAutoFixAttempts?: number;
}

export interface AiContinueSessionRequest {
  prompt: string;
  context?: string;
}

export interface AiRunTestsRequest {
  approved: true;
  gateIds: string[];
}

export interface AiReproduceRequest {
  approved: true;
  command: string[];
  expectedExitCode?: number;
}

export interface AiApplyRequest {
  approved: true;
  patchHash: string;
  allowFailingTests?: boolean;
}

export interface AiCheckpointRequest {
  label?: string;
}

export interface AiRestoreCheckpointRequest {
  checkpointId: string;
  approved: true;
}

export interface AiParallelBatchRequest {
  objective: string;
  context?: string;
  lanes?: number;
  approved?: true;
  dockerApproved?: true;
  docker?: {
    image?: string;
    strategy?: 'balanced' | 'latency' | 'throughput';
    cpuPerLane?: number;
    memoryMbPerLane?: number;
    networkMode?: 'provider-egress' | 'none';
  };
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
  /** Per-lane cursors avoid dropping events when lanes advance at different rates. */
  next: Record<string, number>;
  batch: AiBatchStatus;
}

export interface AiMergeBatchRequest {
  sessionIds: string[];
  objective?: string;
  context?: string;
  approved?: true;
}

export interface AiMergeCandidateScore {
  sessionId: string;
  score: number;
  reasons: string[];
}

export interface AiSemanticMergeAppliedUnit {
  path: string;
  unit: string;
  candidateId: string;
  strategy: 'whole-file' | 'ast-add' | 'ast-update' | 'ast-delete';
}

export interface AiSemanticMergeConflict {
  path: string;
  unit: string;
  candidateIds: string[];
  reason: string;
}

export interface AiSemanticMergePlan {
  engine: 'typescript-ast-v1' | 'hawk-semantic-v2';
  primaryCandidateId: string;
  candidateIds: string[];
  filesAnalyzed: number;
  astFilesAnalyzed: number;
  automaticallyMergedUnits: AiSemanticMergeAppliedUnit[];
  conflicts: AiSemanticMergeConflict[];
}

export interface AiMergeBatchResponse {
  mergeSession: AiSessionSummary;
  candidates: AiMergeCandidateScore[];
  semanticMerge: AiSemanticMergePlan;
}
