import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type GovernanceDecision = 'allow' | 'require-approval' | 'deny';

export interface HawkGovernancePolicy {
  schemaVersion: 1;
  defaultDecision: 'require-approval';
  requireApprovalFor: string[];
  allowedTemplates: string[];
  maxHosts: number;
  maxRequestsPerSecond: number;
  maxParallel: number;
  allowedNetworkPolicies: Array<'offline' | 'captured-only'>;
  requireEvidenceForPromotion: boolean;
}

export interface GovernanceEvaluation {
  decision: GovernanceDecision;
  reasons: string[];
  policyHash: string;
}

export interface GovernanceRequest {
  templateId: string;
  hosts: string[];
  requestsPerSecond: number;
  networkPolicy: 'offline' | 'captured-only';
  approved: boolean;
}

const DEFAULT_POLICY: HawkGovernancePolicy = {
  schemaVersion: 1,
  defaultDecision: 'require-approval',
  requireApprovalFor: ['static-code', 'route-coverage', 'dependency-manifest', 'sandbox-signal'],
  allowedTemplates: ['static-code', 'route-coverage', 'dependency-manifest', 'sandbox-signal'],
  maxHosts: 32,
  maxRequestsPerSecond: 10,
  maxParallel: 8,
  allowedNetworkPolicies: ['offline', 'captured-only'],
  requireEvidenceForPromotion: true,
};

export function createDefaultGovernancePolicy(): HawkGovernancePolicy {
  return clone(DEFAULT_POLICY);
}

export async function loadGovernancePolicy(workspaceRoot: string): Promise<HawkGovernancePolicy> {
  try {
    const raw = JSON.parse(
      await readFile(join(resolve(workspaceRoot), '.hawk', 'governance.json'), 'utf8'),
    );
    return validatePolicy(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createDefaultGovernancePolicy();
    throw error;
  }
}

export async function writeGovernancePolicy(
  workspaceRoot: string,
  policy: HawkGovernancePolicy,
): Promise<void> {
  const validated = validatePolicy(policy);
  const directory = join(resolve(workspaceRoot), '.hawk');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'governance.json'),
    `${JSON.stringify(validated, null, 2)}\n`,
    'utf8',
  );
}

export function governancePolicyHash(policy: HawkGovernancePolicy): string {
  return createHash('sha256').update(stableJson(policy)).digest('hex');
}

export function evaluateGovernance(
  policy: HawkGovernancePolicy,
  request: GovernanceRequest,
): GovernanceEvaluation {
  const policyHash = governancePolicyHash(policy);
  const reasons: string[] = [];
  if (!policy.allowedTemplates.includes(request.templateId)) {
    reasons.push(`Template is not allow-listed: ${request.templateId}`);
  }
  if (request.hosts.length > policy.maxHosts) {
    reasons.push(`Host scope exceeds governance limit of ${policy.maxHosts}`);
  }
  if (request.requestsPerSecond > policy.maxRequestsPerSecond) {
    reasons.push(
      `Rate limit ${request.requestsPerSecond}/s exceeds governance limit of ${policy.maxRequestsPerSecond}/s`,
    );
  }
  if (!policy.allowedNetworkPolicies.includes(request.networkPolicy)) {
    reasons.push(`Network policy is not allowed: ${request.networkPolicy}`);
  }
  if (reasons.length > 0) return { decision: 'deny', reasons, policyHash };
  if (policy.requireApprovalFor.includes(request.templateId) && !request.approved) {
    return {
      decision: 'require-approval',
      reasons: ['Operator approval is required by the workspace governance policy'],
      policyHash,
    };
  }
  return {
    decision: 'allow',
    reasons: ['Request satisfies the workspace governance policy'],
    policyHash,
  };
}

function validatePolicy(value: unknown): HawkGovernancePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('governance policy must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) throw new Error('unsupported governance policy schema');
  const policy: HawkGovernancePolicy = {
    schemaVersion: 1,
    defaultDecision: 'require-approval',
    requireApprovalFor: boundedStrings(candidate.requireApprovalFor, 'requireApprovalFor'),
    allowedTemplates: boundedStrings(candidate.allowedTemplates, 'allowedTemplates'),
    maxHosts: boundedInteger(candidate.maxHosts, 1, 128, 'maxHosts'),
    maxRequestsPerSecond: boundedNumber(
      candidate.maxRequestsPerSecond,
      0.01,
      1_000,
      'maxRequestsPerSecond',
    ),
    maxParallel: boundedInteger(candidate.maxParallel, 1, 32, 'maxParallel'),
    allowedNetworkPolicies: boundedNetworkPolicies(candidate.allowedNetworkPolicies),
    requireEvidenceForPromotion: candidate.requireEvidenceForPromotion === true,
  };
  if (policy.allowedTemplates.length === 0) throw new Error('allowedTemplates cannot be empty');
  return policy;
}

function boundedStrings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new Error(`${field} must be a bounded string list`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function boundedNetworkPolicies(value: unknown): Array<'offline' | 'captured-only'> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new Error('allowedNetworkPolicies must be a non-empty list');
  }
  if (!value.every((item) => item === 'offline' || item === 'captured-only')) {
    throw new Error('unsupported network policy in governance configuration');
  }
  return [...new Set(value)] as Array<'offline' | 'captured-only'>;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function clone(policy: HawkGovernancePolicy): HawkGovernancePolicy {
  return {
    ...policy,
    requireApprovalFor: [...policy.requireApprovalFor],
    allowedTemplates: [...policy.allowedTemplates],
    allowedNetworkPolicies: [...policy.allowedNetworkPolicies],
  };
}
