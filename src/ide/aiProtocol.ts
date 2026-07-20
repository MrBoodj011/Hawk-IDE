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

export interface AiCheckpointSummary {
  id: string;
  label: string;
  createdAt: string;
  patchHash: string;
  files: number;
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
  background: boolean;
  autoResume: boolean;
  resumeCount: number;
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

export interface AiCreateSessionRequest {
  prompt: string;
  context?: string;
  background?: boolean;
  autoResume?: boolean;
}

export interface AiContinueSessionRequest {
  prompt: string;
  context?: string;
}

export interface AiRunTestsRequest {
  approved: true;
  gateIds: string[];
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
}

export interface AiParallelBatchResponse {
  batchId: string;
  createdAt: string;
  sessions: AiSessionSummary[];
}

export interface AiMergeBatchRequest {
  sessionIds: string[];
  objective?: string;
  context?: string;
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
