import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CapabilityRegistry } from './capabilityRegistry.js';
import { DurableStore } from './durableStore.js';
import type { GovernedMissionPlan, GovernedMissionProfile } from './protocol.js';
import { IDE_PROTOCOL_VERSION } from './protocol.js';
import { type GoalInput, ScopePolicyEngine, compileGoal } from './scopePolicy.js';
import { SmartPlanner } from './smartPlanner.js';
import type { HawkAction } from './smartTypes.js';

export interface GovernedMissionInput {
  workspaceRoot: string;
  objective: string;
  profile: GovernedMissionProfile;
  hosts?: string[];
  now?: Date;
}

/**
 * Compiles and persists a Smart MCP-compatible goal, plan, and policy.
 * Planning is deliberately separate from approval and execution.
 */
export async function createGovernedMission(
  input: GovernedMissionInput,
): Promise<GovernedMissionPlan> {
  const root = resolve(input.workspaceRoot);
  const now = input.now ?? new Date();
  const profile = profilePolicy(input.profile);
  const goalInput: GoalInput = {
    objective: input.objective,
    hosts: input.hosts,
    allowedActions: profile.allowed,
    forbiddenActions: profile.forbidden,
    maxParallel: profile.maxParallel,
    maxMinutes: profile.maxMinutes,
    maxTokens: profile.maxTokens,
    maxCostUsd: profile.maxCostUsd,
    requestsPerSecond: profile.requestsPerSecond,
    dataPolicy: 'local-only',
    approvalMode: profile.approvalMode,
    successCriteria: [
      'Produce evidence-backed findings only',
      'Preserve a reviewable plan and artifact trail',
      'Stop when scope, authority, or evidence is insufficient',
    ],
    retentionDays: 30,
  };
  const clock = () => now;
  const goal = compileGoal(root, goalInput, clock);
  const capabilities = new CapabilityRegistry();
  const plan = new SmartPlanner(capabilities, clock).create(goal);
  const selected = plan.nodes.map((node) => {
    const capability = capabilities.get(node.capabilityId);
    if (!capability) throw new Error(`Unknown capability in mission plan: ${node.capabilityId}`);
    return capability;
  });
  const policy = new ScopePolicyEngine().evaluate(goal, plan, selected);
  const store = new DurableStore(root);
  await Promise.all([
    store.writeJson('goals', goal.id, goal),
    store.writeJson('plans', plan.id, plan),
    store.writeJson('policies', plan.id, policy),
  ]);

  const reportPath = `.hawk/plans/${plan.id}.md`;
  const response: GovernedMissionPlan = {
    protocolVersion: IDE_PROTOCOL_VERSION,
    id: plan.id,
    goalId: goal.id,
    profile: input.profile,
    objective: goal.objective,
    planHash: plan.planHash,
    decision: policy.decision,
    reasons: policy.reasons,
    allowedActions: goal.allowedActions,
    hosts: goal.scope.hosts,
    maxParallel: plan.maxParallel,
    estimatedMinutes: plan.estimatedMinutes,
    estimatedCostUsd: plan.estimatedCostUsd,
    approvalRequired: plan.approvalRequired || policy.decision === 'require-approval',
    nodes: plan.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      capabilityId: node.capabilityId,
      dependsOn: node.dependsOn,
      parallelGroup: node.parallelGroup,
      risk: node.risk,
      approvalRequired: node.approvalRequired,
      modelClass: node.modelRoute.modelClass,
    })),
    reportPath,
    createdAt: plan.createdAt,
  };
  const directory = join(root, '.hawk', 'plans');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${plan.id}.md`), renderMission(response), 'utf8');
  return response;
}

function profilePolicy(profile: GovernedMissionProfile): {
  allowed: HawkAction[];
  forbidden: HawkAction[];
  maxParallel: number;
  maxMinutes: number;
  maxTokens: number;
  maxCostUsd: number;
  requestsPerSecond: number;
  approvalMode: 'on-risk' | 'always';
} {
  if (profile === 'review') {
    return {
      allowed: ['read-workspace'],
      forbidden: [
        'write-workspace',
        'run-local',
        'run-container',
        'network-access',
        'credential-access',
        'active-security-test',
      ],
      maxParallel: 8,
      maxMinutes: 60,
      maxTokens: 250_000,
      maxCostUsd: 25,
      requestsPerSecond: 1,
      approvalMode: 'on-risk',
    };
  }
  if (profile === 'remediate') {
    return {
      allowed: ['read-workspace', 'write-workspace', 'run-local', 'run-container'],
      forbidden: ['network-access', 'credential-access', 'active-security-test'],
      maxParallel: 8,
      maxMinutes: 120,
      maxTokens: 500_000,
      maxCostUsd: 50,
      requestsPerSecond: 1,
      approvalMode: 'always',
    };
  }
  return {
    allowed: ['read-workspace', 'run-container', 'network-access', 'active-security-test'],
    forbidden: ['write-workspace', 'run-local', 'credential-access'],
    maxParallel: 12,
    maxMinutes: 180,
    maxTokens: 500_000,
    maxCostUsd: 75,
    requestsPerSecond: 2,
    approvalMode: 'always',
  };
}

function renderMission(plan: GovernedMissionPlan): string {
  const lines = [
    '# Hawk governed mission',
    '',
    `- Objective: ${plan.objective}`,
    `- Profile: \`${plan.profile}\``,
    `- Policy decision: **${plan.decision.toUpperCase()}**`,
    `- Plan ID: \`${plan.id}\``,
    `- Exact plan hash: \`${plan.planHash}\``,
    `- Created: ${plan.createdAt}`,
    `- Parallel ceiling: ${plan.maxParallel}`,
    `- Estimate: ${plan.estimatedMinutes} minute(s), $${plan.estimatedCostUsd.toFixed(4)}`,
    `- Allowed actions: ${plan.allowedActions.map((action) => `\`${action}\``).join(', ')}`,
    `- In-scope hosts: ${plan.hosts.length ? plan.hosts.map((host) => `\`${host}\``).join(', ') : 'none'}`,
    '',
    '## Policy reasons',
    '',
    ...plan.reasons.map((reason) => `- ${reason}`),
    '',
    '## Execution DAG',
    '',
    '| Step | Capability | Risk | Parallel group | Approval | Depends on |',
    '| --- | --- | --- | --- | --- | --- |',
    ...plan.nodes.map(
      (node) =>
        `| ${node.title} | \`${node.capabilityId}\` | ${node.risk} | ${node.parallelGroup} | ${node.approvalRequired ? 'required' : 'not required'} | ${node.dependsOn.length ? node.dependsOn.map((dependency) => `\`${dependency}\``).join(', ') : '—'} |`,
    ),
    '',
    '## Safety boundary',
    '',
    'This file is a plan, not an approval and not an execution record. Use Hawk Smart MCP to inspect the stored goal and policy, approve the exact SHA-256 plan hash when required, and start a durable run. Any changed plan requires a new approval.',
    '',
  ];
  return lines.join('\n');
}
