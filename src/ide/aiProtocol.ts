export type AiSessionStatus =
  | 'preparing'
  | 'running'
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

export interface AiSessionSummary {
  id: string;
  title: string;
  prompt: string;
  status: AiSessionStatus;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  model?: string;
  error?: string;
  diff?: AiDiffSummary;
  testGates: AiTestGate[];
  testResults: AiTestResult[];
  canApply: boolean;
  canReject: boolean;
  canRevert: boolean;
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
