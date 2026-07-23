import { randomUUID } from 'node:crypto';
import { apply as redact } from '../redact/index.js';
import { stableHash } from './scopePolicy.js';

export type HawkIntegrationId =
  | 'github'
  | 'gitlab'
  | 'jira'
  | 'slack'
  | 'burp'
  | 'browser'
  | 'ci-cd'
  | 'docker'
  | 'kubernetes';

export interface HawkIntegrationDescriptor {
  id: HawkIntegrationId;
  title: string;
  capabilities: string[];
  auth: 'local-token' | 'loopback-pairing' | 'docker-socket' | 'kubeconfig' | 'oidc';
  execution: 'plan-and-approval' | 'capture-only' | 'read-only';
}

export interface HawkIntegrationPlan {
  id: string;
  integration: HawkIntegrationId;
  action: string;
  target: string;
  payloadSummary: string;
  planHash: string;
  createdAt: string;
  expiresAt: string;
  statement: string;
}

const DESCRIPTORS: HawkIntegrationDescriptor[] = [
  {
    id: 'github',
    title: 'GitHub',
    capabilities: ['issue', 'branch', 'review', 'pull-request', 'release'],
    auth: 'local-token',
    execution: 'plan-and-approval',
  },
  {
    id: 'gitlab',
    title: 'GitLab',
    capabilities: ['issue', 'branch', 'merge-request', 'pipeline'],
    auth: 'local-token',
    execution: 'plan-and-approval',
  },
  {
    id: 'jira',
    title: 'Jira',
    capabilities: ['issue', 'transition', 'evidence-link'],
    auth: 'oidc',
    execution: 'plan-and-approval',
  },
  {
    id: 'slack',
    title: 'Slack',
    capabilities: ['approval-request', 'alert', 'evidence-link'],
    auth: 'local-token',
    execution: 'plan-and-approval',
  },
  {
    id: 'burp',
    title: 'Burp Suite',
    capabilities: ['live-traffic', 'issues', 'replay'],
    auth: 'loopback-pairing',
    execution: 'capture-only',
  },
  {
    id: 'browser',
    title: 'Hawk Browser Companion',
    capabilities: ['live-traffic', 'cookies', 'storage', 'screenshots'],
    auth: 'loopback-pairing',
    execution: 'capture-only',
  },
  {
    id: 'ci-cd',
    title: 'CI/CD',
    capabilities: ['status', 'artifacts', 'sarif', 'gates'],
    auth: 'local-token',
    execution: 'read-only',
  },
  {
    id: 'docker',
    title: 'Docker',
    capabilities: ['isolated-workers', 'scheduler', 'artifacts', 'network-policy'],
    auth: 'docker-socket',
    execution: 'plan-and-approval',
  },
  {
    id: 'kubernetes',
    title: 'Kubernetes',
    capabilities: ['context', 'workload-read', 'logs', 'job-plan'],
    auth: 'kubeconfig',
    execution: 'plan-and-approval',
  },
];

export function listHawkIntegrations(): HawkIntegrationDescriptor[] {
  return DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    capabilities: [...descriptor.capabilities],
  }));
}

export function integrationDescriptor(id: HawkIntegrationId): HawkIntegrationDescriptor {
  const descriptor = DESCRIPTORS.find((candidate) => candidate.id === id);
  if (!descriptor) throw new Error(`Unsupported Hawk integration: ${id}`);
  return { ...descriptor, capabilities: [...descriptor.capabilities] };
}

export function createIntegrationPlan(input: {
  integration: HawkIntegrationId;
  action: string;
  target: string;
  payloadSummary?: string;
  now?: Date;
}): HawkIntegrationPlan {
  const descriptor = integrationDescriptor(input.integration);
  const action = bounded(input.action, 120);
  const target = bounded(input.target, 1_000);
  if (!action || !target) throw new Error('Integration action and target are required');
  if (target.includes('\n') || target.includes('\r'))
    throw new Error('Integration target cannot contain newlines');
  const now = input.now ?? new Date();
  const unsigned = {
    id: `integration-plan-${randomUUID()}`,
    integration: descriptor.id,
    action,
    target: redact(target),
    payloadSummary: redact(bounded(input.payloadSummary ?? '', 2_000)),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1_000).toISOString(),
    statement: `This plan is an approval-gated ${descriptor.title} integration action. Hawk keeps credentials outside the plan, redacts payload summaries, and never treats an external status as proof without local evidence.`,
  };
  return { ...unsigned, planHash: stableHash(unsigned) };
}

function bounded(value: string, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
