import { createHash } from 'node:crypto';
import type { BehavioralSecurityReport } from './behavioralSecurity.js';
import { IDE_PROTOCOL_VERSION } from './protocol.js';

export type HawkSpecialistRole =
  | 'business-logic'
  | 'race-condition'
  | 'authorization'
  | 'frontend-reliability'
  | 'api-contract'
  | 'debug'
  | 'fix'
  | 'independent-verifier';

export interface HawkSpecialistNode {
  id: string;
  role: HawkSpecialistRole;
  title: string;
  objective: string;
  tools: string[];
  dependencies: string[];
  parallelGroup: number;
  authority: 'read-only' | 'isolated-write' | 'approval-gated-active';
  successCriteria: string[];
}

export interface HawkSpecialistSwarmPlan {
  protocolVersion: number;
  id: string;
  createdAt: string;
  objective: string;
  maxParallel: number;
  nodes: HawkSpecialistNode[];
  requiredFinalGates: string[];
  planHash: string;
  statement: string;
}

export function planSpecialistSwarm(input: {
  objective: string;
  report?: BehavioralSecurityReport;
  maxParallel?: number;
  now?: Date;
}): HawkSpecialistSwarmPlan {
  const objective = input.objective.trim().slice(0, 1_000);
  if (!objective) throw new Error('specialist swarm objective is required');
  const maxParallel = Math.max(1, Math.min(8, Math.floor(input.maxParallel ?? 4)));
  const signalCount = input.report?.summary.signals ?? 0;
  const invariantCount = input.report?.summary.invariants ?? 0;
  const roles: HawkSpecialistRole[] = [
    'business-logic',
    'race-condition',
    'authorization',
    'frontend-reliability',
    'api-contract',
    'debug',
    'fix',
    'independent-verifier',
  ];
  const nodes = roles.map((role, index) =>
    specialistNode(role, objective, index, signalCount, invariantCount),
  );
  const createdAt = (input.now ?? new Date()).toISOString();
  const canonical = JSON.stringify({ objective, maxParallel, nodes, createdAt });
  const planHash = createHash('sha256').update(canonical).digest('hex');
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    id: `swarm-${planHash.slice(0, 20)}`,
    createdAt,
    objective,
    maxParallel,
    nodes,
    requiredFinalGates: [
      'independent evidence review',
      'reproduction',
      'regression tests',
      'semantic review',
      'secret redaction',
      'manual Apply',
    ],
    planHash,
    statement:
      'This plan scopes eight specialist agents. It does not start workers or grant active-testing authority.',
  };
}

function specialistNode(
  role: HawkSpecialistRole,
  objective: string,
  index: number,
  signals: number,
  invariants: number,
): HawkSpecialistNode {
  const base = {
    'business-logic': {
      title: 'Business Logic Agent',
      tools: ['workspace graph', 'behavioral state machine', 'invariants'],
      authority: 'read-only' as const,
      success: ['map invalid workflow transitions', 'cite invariant evidence'],
    },
    'race-condition': {
      title: 'Race Condition Agent',
      tools: ['interaction chaos', 'captured traffic', 'race planner'],
      authority: 'approval-gated-active' as const,
      success: ['produce exact bounded race plan', 'measure durable side effects'],
    },
    authorization: {
      title: 'Authorization Agent',
      tools: ['route inventory', 'identity replay', 'security graph'],
      authority: 'approval-gated-active' as const,
      success: ['separate identity from ownership', 'preserve exact host scope'],
    },
    'frontend-reliability': {
      title: 'Frontend Reliability Agent',
      tools: ['DOM fingerprints', 'accessibility chaos', 'client-state scenarios'],
      authority: 'read-only' as const,
      success: ['identify duplicate activation paths', 'produce deterministic replay'],
    },
    'api-contract': {
      title: 'API Contract Agent',
      tools: ['routes', 'captured requests', 'protocol intelligence'],
      authority: 'read-only' as const,
      success: ['map mutation contracts', 'identify unstable outcomes'],
    },
    debug: {
      title: 'Debug Agent',
      tools: ['failure timeline', 'terminal capture', 'DAP snapshot'],
      authority: 'isolated-write' as const,
      success: ['reproduce the failure', 'isolate the root cause'],
    },
    fix: {
      title: 'Fix Agent',
      tools: ['isolated worktree', 'mutation tests', 'semantic merge'],
      authority: 'isolated-write' as const,
      success: ['produce minimal patch', 'add invariant regression test'],
    },
    'independent-verifier': {
      title: 'Independent Verification Agent',
      tools: ['evidence pack', 'reproduction gates', 'PR review'],
      authority: 'read-only' as const,
      success: ['reject unsupported claims', 'verify tests and provenance'],
    },
  } satisfies Record<
    HawkSpecialistRole,
    {
      title: string;
      tools: string[];
      authority: HawkSpecialistNode['authority'];
      success: string[];
    }
  >;
  const descriptor = base[role];
  const dependencies =
    role === 'debug'
      ? ['agent-business-logic', 'agent-race-condition', 'agent-frontend-reliability']
      : role === 'fix'
        ? ['agent-debug', 'agent-api-contract']
        : role === 'independent-verifier'
          ? ['agent-fix']
          : [];
  return {
    id: `agent-${role}`,
    role,
    title: descriptor.title,
    objective: `${objective} (${signals} current signals; ${invariants} declared invariants)`,
    tools: descriptor.tools,
    dependencies,
    parallelGroup: index < 5 ? 1 : role === 'debug' ? 2 : role === 'fix' ? 3 : 4,
    authority: descriptor.authority,
    successCriteria: descriptor.success,
  };
}
