import { createHash } from 'node:crypto';

export type HawkHookEvent =
  | 'sessionStart'
  | 'sessionEnd'
  | 'userPromptSubmitted'
  | 'preToolUse'
  | 'postToolUse'
  | 'agentStop'
  | 'subagentStop'
  | 'errorOccurred';

export type HawkHookDecision = 'allow' | 'deny' | 'require-approval' | 'allow-with-gates';

export interface HawkHookInput {
  event: HawkHookEvent;
  tool?: string;
  arguments?: Record<string, unknown>;
  approved?: boolean;
  outcome?: 'success' | 'failure';
  error?: string;
}

export interface HawkHookResult {
  id: string;
  event: HawkHookEvent;
  decision: HawkHookDecision;
  matchedRules: string[];
  requiredGates: string[];
  redactions: string[];
  audit: {
    inputSha256: string;
    recordedAt: string;
    retainedArguments: false;
  };
  statement: string;
}

const SECRET_PATH =
  /(?:^|[\\/])(?:\.env(?:\.|$)|id_(?:rsa|ed25519)|credentials|secrets?)(?:[\\/]|$)/i;
const DANGEROUS_TOOL = /(?:shell|terminal|command|exec|delete|network|browser|replay|race)/i;
const WRITE_TOOL = /(?:write|edit|delete|apply|patch)/i;

export function evaluateHawkHook(input: HawkHookInput, now = new Date()): HawkHookResult {
  const tool = String(input.tool ?? '').slice(0, 160);
  const serialized = JSON.stringify(input.arguments ?? {});
  const matchedRules: string[] = [];
  const requiredGates: string[] = [];
  const redactions = secretLike(serialized) ? ['secret-like argument content'] : [];
  let decision: HawkHookDecision = 'allow';

  if (input.event === 'preToolUse' && containsSensitivePath(input.arguments)) {
    matchedRules.push('hawk-hook-sensitive-path');
    decision = input.approved === true ? 'allow-with-gates' : 'require-approval';
    requiredGates.push('operator approval', 'secret redaction');
  }
  if (input.event === 'preToolUse' && DANGEROUS_TOOL.test(tool)) {
    matchedRules.push('hawk-hook-sensitive-tool');
    if (input.approved !== true) decision = 'require-approval';
    requiredGates.push('scope validation', 'audit event');
  }
  if (input.event === 'preToolUse' && destructiveCommand(serialized)) {
    matchedRules.push('hawk-hook-destructive-command');
    decision = 'deny';
    requiredGates.push('manual operator execution outside the agent');
  }
  if (input.event === 'postToolUse' && WRITE_TOOL.test(tool)) {
    matchedRules.push('hawk-hook-post-edit-gates');
    decision = 'allow-with-gates';
    requiredGates.push(
      'diff review',
      'tests',
      'semantic review',
      'reproduction when security-related',
    );
  }
  if (input.event === 'errorOccurred' || input.outcome === 'failure') {
    matchedRules.push('hawk-hook-failure-recovery');
    decision = 'allow-with-gates';
    requiredGates.push('checkpoint preservation', 'bounded retry', 'failure timeline');
  }
  if (['agentStop', 'subagentStop', 'sessionEnd'].includes(input.event)) {
    matchedRules.push('hawk-hook-stop-verification');
    decision = 'allow-with-gates';
    requiredGates.push('artifact integrity', 'audit chain', 'unfinished task detection');
  }

  const inputSha256 = createHash('sha256')
    .update(
      JSON.stringify({
        event: input.event,
        tool,
        argumentsSha256: createHash('sha256').update(serialized).digest('hex'),
        approved: input.approved === true,
        outcome: input.outcome,
      }),
    )
    .digest('hex');
  return {
    id: `hook-${inputSha256.slice(0, 20)}`,
    event: input.event,
    decision,
    matchedRules: [...new Set(matchedRules)],
    requiredGates: [...new Set(requiredGates)],
    redactions,
    audit: {
      inputSha256,
      recordedAt: now.toISOString(),
      retainedArguments: false,
    },
    statement:
      'Hawk hooks are deterministic policy decisions. Raw tool arguments are not retained in the hook result.',
  };
}

function destructiveCommand(value: string): boolean {
  return /(?:rm\s+-rf|git\s+reset\s+--hard|format\s+[a-z]:|diskpart|remove-item[^\n]*-recurse)/i.test(
    value,
  );
}

function secretLike(value: string): boolean {
  return /(?:api[_-]?key|authorization|bearer|password|secret|private[_-]?key)/i.test(value);
}

function containsSensitivePath(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === 'string') return SECRET_PATH.test(value.replaceAll('\\', '/'));
  if (Array.isArray(value)) return value.some((item) => containsSensitivePath(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((item) => containsSensitivePath(item, depth + 1));
}
