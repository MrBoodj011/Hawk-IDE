import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  CapabilityDescriptor,
  GoalSpec,
  HawkAction,
  HawkPlan,
  PlanApproval,
  PolicyEvaluation,
} from './smartTypes.js';

const ALL_ACTIONS: HawkAction[] = [
  'read-workspace',
  'write-workspace',
  'run-local',
  'run-container',
  'network-access',
  'credential-access',
  'active-security-test',
];

export interface GoalInput {
  objective: string;
  repositories?: string[];
  hosts?: string[];
  routes?: string[];
  identities?: string[];
  allowedActions?: HawkAction[];
  forbiddenActions?: HawkAction[];
  maxParallel?: number;
  maxMinutes?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  requestsPerSecond?: number;
  dataPolicy?: GoalSpec['modelPolicy']['dataPolicy'];
  preferredModels?: Record<string, string>;
  approvalMode?: GoalSpec['approvalMode'];
  successCriteria?: string[];
  retentionDays?: number;
}

export function compileGoal(
  workspaceRoot: string,
  input: GoalInput,
  now: () => Date = () => new Date(),
): GoalSpec {
  const objective = normalizeText(input.objective, 1_000);
  if (!objective) throw new Error('A concrete objective is required');
  const allowedActions = uniqueActions(input.allowedActions ?? ['read-workspace']);
  const forbiddenActions = uniqueActions(
    input.forbiddenActions ??
      (['credential-access', 'active-security-test'] as HawkAction[]).filter(
        (action) => !allowedActions.includes(action),
      ),
  );
  const overlap = allowedActions.find((action) => forbiddenActions.includes(action));
  if (overlap) throw new Error(`Action cannot be both allowed and forbidden: ${overlap}`);

  return {
    protocolVersion: 1,
    id: `goal-${randomUUID()}`,
    objective,
    workspaceRoot: resolve(workspaceRoot),
    scope: {
      repositories: uniqueStrings(input.repositories ?? ['workspace://current'], 64, 512),
      hosts: uniqueStrings(input.hosts ?? [], 128, 253).map(normalizeHost),
      routes: uniqueStrings(input.routes ?? [], 256, 2_048),
      identities: uniqueStrings(input.identities ?? [], 64, 160),
    },
    allowedActions,
    forbiddenActions,
    budgets: {
      maxParallel: boundedInteger(input.maxParallel, 1, 32, 8),
      maxMinutes: boundedInteger(input.maxMinutes, 1, 43_200, 60),
      maxTokens: boundedInteger(input.maxTokens, 0, 100_000_000, 250_000),
      maxCostUsd: boundedNumber(input.maxCostUsd, 0, 100_000, 25),
      requestsPerSecond: boundedNumber(input.requestsPerSecond, 0.01, 1_000, 2),
    },
    modelPolicy: {
      dataPolicy: input.dataPolicy ?? 'local-only',
      preferredModels: sanitizeModels(input.preferredModels ?? {}),
    },
    approvalMode: input.approvalMode ?? 'on-risk',
    successCriteria: uniqueStrings(
      input.successCriteria ?? ['Produce evidence-backed findings only'],
      32,
      500,
    ),
    retentionDays: boundedInteger(input.retentionDays, 1, 3_650, 30),
    createdAt: now().toISOString(),
  };
}

export class ScopePolicyEngine {
  evaluate(goal: GoalSpec, plan: HawkPlan, capabilities: CapabilityDescriptor[]): PolicyEvaluation {
    const required = new Set(capabilities.flatMap((capability) => capability.requiredActions));
    const missingActions = [...required].filter((action) => !goal.allowedActions.includes(action));
    const forbidden = [...required].filter((action) => goal.forbiddenActions.includes(action));
    const reasons: string[] = [];
    if (forbidden.length > 0)
      reasons.push(`Plan requests forbidden actions: ${forbidden.join(', ')}`);
    if (missingActions.length > 0)
      reasons.push(`Plan is not authorized for: ${missingActions.join(', ')}`);
    if (required.has('network-access') && goal.scope.hosts.length === 0)
      reasons.push('Network work requires at least one explicit in-scope host');
    if (plan.estimatedCostUsd > goal.budgets.maxCostUsd)
      reasons.push(
        `Estimated cost $${plan.estimatedCostUsd.toFixed(2)} exceeds $${goal.budgets.maxCostUsd.toFixed(2)} budget`,
      );
    if (plan.estimatedMinutes > goal.budgets.maxMinutes)
      reasons.push(
        `Estimated duration ${plan.estimatedMinutes}m exceeds ${goal.budgets.maxMinutes}m budget`,
      );

    const hardDenied =
      forbidden.length > 0 ||
      missingActions.length > 0 ||
      plan.estimatedCostUsd > goal.budgets.maxCostUsd ||
      plan.estimatedMinutes > goal.budgets.maxMinutes ||
      (required.has('network-access') && goal.scope.hosts.length === 0);
    if (hardDenied) return { decision: 'deny', reasons, missingActions, planHash: plan.planHash };

    const risky = capabilities.some(
      (capability) => capability.risk === 'high' || capability.risk === 'critical',
    );
    if (
      goal.approvalMode === 'always' ||
      required.has('active-security-test') ||
      (goal.approvalMode === 'on-risk' && risky)
    ) {
      if (reasons.length === 0) reasons.push('Exact-plan operator approval is required');
      return {
        decision: 'require-approval',
        reasons,
        missingActions,
        planHash: plan.planHash,
      };
    }
    return {
      decision: 'allow',
      reasons: ['Plan is inside declared scope, actions, and budgets'],
      missingActions: [],
      planHash: plan.planHash,
    };
  }

  approve(
    goal: GoalSpec,
    plan: HawkPlan,
    approvedBy: string,
    ttlMinutes = 30,
    now: () => Date = () => new Date(),
  ): PlanApproval {
    const principal = normalizeText(approvedBy, 160);
    if (!principal) throw new Error('approvedBy is required');
    const approvedAt = now();
    return {
      id: `approval-${randomUUID()}`,
      goalId: goal.id,
      planId: plan.id,
      planHash: plan.planHash,
      approvedBy: principal,
      approvedAt: approvedAt.toISOString(),
      expiresAt: new Date(
        approvedAt.getTime() + boundedInteger(ttlMinutes, 1, 1_440, 30) * 60_000,
      ).toISOString(),
    };
  }

  validateApproval(
    approval: PlanApproval | undefined,
    goal: GoalSpec,
    plan: HawkPlan,
    now: () => Date = () => new Date(),
  ): boolean {
    return Boolean(
      approval &&
        approval.goalId === goal.id &&
        approval.planId === plan.id &&
        approval.planHash === plan.planHash &&
        Date.parse(approval.expiresAt) > now().getTime(),
    );
  }
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? JSON.stringify(String(value));
}

function uniqueActions(actions: HawkAction[]): HawkAction[] {
  const unique = [...new Set(actions)];
  for (const action of unique) {
    if (!ALL_ACTIONS.includes(action)) throw new Error(`Unknown action: ${action}`);
  }
  return unique;
}

function uniqueStrings(values: string[], maximum: number, maxLength: number): string[] {
  if (values.length > maximum) throw new Error(`List is limited to ${maximum} entries`);
  return [...new Set(values.map((value) => normalizeText(value, maxLength)).filter(Boolean))];
}

function normalizeText(value: string, maxLength: number): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeHost(value: string): string {
  const withoutProtocol =
    value
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      ?.toLowerCase() ?? '';
  if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(withoutProtocol))
    throw new Error(`Invalid scope host: ${value}`);
  return withoutProtocol;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum)
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  return selected;
}

function boundedNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < minimum || selected > maximum)
    throw new Error(`Expected a number between ${minimum} and ${maximum}`);
  return selected;
}

function sanitizeModels(models: Record<string, string>): Record<string, string> {
  const entries = Object.entries(models);
  if (entries.length > 16) throw new Error('At most 16 preferred model routes are allowed');
  return Object.fromEntries(
    entries.map(([role, model]) => {
      const safeRole = normalizeText(role, 80);
      const safeModel = normalizeText(model, 160);
      if (!safeRole || !safeModel) throw new Error('Preferred model routes cannot be empty');
      return [safeRole, safeModel];
    }),
  );
}
