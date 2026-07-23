import { randomUUID } from 'node:crypto';
import type { CapabilityRegistry } from './capabilityRegistry.js';
import { HawkModelRouter } from './modelRouter.js';
import { stableHash } from './scopePolicy.js';
import type { CapabilityDescriptor, GoalSpec, HawkPlan, HawkRisk, PlanNode } from './smartTypes.js';

const RISK_WEIGHT: Record<HawkRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export class SmartPlanner {
  private readonly modelRouter: HawkModelRouter;

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly now: () => Date = () => new Date(),
    modelRouter: HawkModelRouter = new HawkModelRouter(),
  ) {
    this.modelRouter = modelRouter;
  }

  create(goal: GoalSpec, requestedCapabilities: string[] = []): HawkPlan {
    const capabilityIds =
      requestedCapabilities.length > 0
        ? [...new Set(requestedCapabilities)]
        : selectCapabilities(goal.objective);
    const capabilities = capabilityIds.map((id) => {
      const capability = this.registry.get(id);
      if (!capability || !capability.enabled)
        throw new Error(`Unknown or disabled capability: ${id}`);
      return capability;
    });
    if (capabilities.length === 0) throw new Error('The plan needs at least one capability');

    const nodes = buildNodes(capabilities, goal, this.modelRouter);
    const estimatedSeconds = criticalPathSeconds(nodes, capabilities);
    const estimatedCostUsd = capabilities.reduce(
      (total, capability) => total + capability.estimatedCostUsd,
      0,
    );
    const approvalReasons = nodes
      .filter((node) => node.approvalRequired)
      .map((node) => `${node.title} is ${node.risk} risk`);
    const planBase = {
      protocolVersion: 1 as const,
      id: `plan-${randomUUID()}`,
      goalId: goal.id,
      goalHash: stableHash(goal),
      objective: goal.objective,
      nodes,
      maxParallel: Math.min(goal.budgets.maxParallel, Math.max(1, nodes.length)),
      estimatedMinutes: Math.max(1, Math.ceil(estimatedSeconds / 60)),
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
      approvalRequired: approvalReasons.length > 0 || goal.approvalMode === 'always',
      approvalReasons:
        goal.approvalMode === 'always'
          ? ['Goal policy requires approval for every plan', ...approvalReasons]
          : approvalReasons,
      createdAt: this.now().toISOString(),
    };
    return { ...planBase, planHash: stableHash(planBase) };
  }
}

function selectCapabilities(objective: string): string[] {
  const normalized = objective.toLowerCase();
  const selected = new Set<string>([
    'context.workspace.snapshot',
    'code.route.inventory',
    'code.static.audit',
  ]);
  if (/\b(?:traffic|request|api|idor|bola|auth|tenant)\b/.test(normalized))
    selected.add('traffic.source.correlate');
  if (/\b(?:dependency|dependencies|sbom|supply|package|repository|repos)\b/.test(normalized))
    selected.add('supply-chain.health');
  selected.add('proof.graph.build');
  selected.add('evidence.independent.verify');
  if (/\b(?:validate|reproduce|exploit|runtime|live)\b/.test(normalized))
    selected.add('runtime.authorized.validate');
  if (/\b(?:fix|patch|remediate|repair)\b/.test(normalized)) {
    selected.add('patch.candidate.generate');
    selected.add('patch.regression.validate');
  }
  return [...selected];
}

function buildNodes(
  capabilities: CapabilityDescriptor[],
  goal: GoalSpec,
  modelRouter: HawkModelRouter,
): PlanNode[] {
  const selected = new Set(capabilities.map((capability) => capability.id));
  const nodes = capabilities.map((capability, index) => {
    const dependsOn = dependenciesFor(capability.id, selected);
    const risky = RISK_WEIGHT[capability.risk] >= RISK_WEIGHT.high;
    const routing = modelRouter.route(capability, goal);
    return {
      id: `step-${String(index + 1).padStart(2, '0')}-${capability.id.replaceAll('.', '-')}`,
      title: capability.title,
      capabilityId: capability.id,
      dependsOn: dependsOn
        .map((id) => capabilities.findIndex((candidate) => candidate.id === id))
        .filter((dependencyIndex) => dependencyIndex >= 0)
        .map(
          (dependencyIndex) =>
            `step-${String(dependencyIndex + 1).padStart(2, '0')}-${capabilities[
              dependencyIndex
            ]?.id.replaceAll('.', '-')}`,
        ),
      parallelGroup: parallelGroupFor(capability.id),
      risk: capability.risk,
      approvalRequired: goal.approvalMode === 'always' || risky,
      expectedEvidence: [...capability.evidenceKinds],
      timeoutSeconds: Math.max(10, capability.averageDurationSeconds * 4),
      retries: capability.deterministic ? 1 : 0,
      ...routing,
    };
  });
  assertAcyclic(nodes);
  return nodes;
}

function dependenciesFor(id: string, selected: Set<string>): string[] {
  const candidates: Record<string, string[]> = {
    'traffic.source.correlate': ['context.workspace.snapshot', 'code.route.inventory'],
    'proof.graph.build': [
      'code.route.inventory',
      'code.static.audit',
      'traffic.source.correlate',
      'supply-chain.health',
    ],
    'evidence.independent.verify': ['proof.graph.build'],
    'runtime.authorized.validate': ['proof.graph.build'],
    'patch.candidate.generate': ['evidence.independent.verify'],
    'patch.regression.validate': ['patch.candidate.generate'],
  };
  return (candidates[id] ?? []).filter((candidate) => selected.has(candidate));
}

function parallelGroupFor(id: string): string {
  if (id.startsWith('code.') || id.startsWith('traffic.') || id.startsWith('supply-chain.'))
    return 'observe';
  if (id.startsWith('patch.')) return 'remediate';
  if (id.startsWith('runtime.') || id.startsWith('evidence.')) return 'verify';
  return 'govern';
}

function criticalPathSeconds(nodes: PlanNode[], capabilities: CapabilityDescriptor[]): number {
  const duration = new Map(
    nodes.map((node) => [
      node.id,
      capabilities.find((capability) => capability.id === node.capabilityId)
        ?.averageDurationSeconds ?? 1,
    ]),
  );
  const finishes = new Map<string, number>();
  for (const node of nodes) {
    const dependencyFinish = Math.max(0, ...node.dependsOn.map((id) => finishes.get(id) ?? 0));
    finishes.set(node.id, dependencyFinish + (duration.get(node.id) ?? 1));
  }
  return Math.max(...finishes.values());
}

function assertAcyclic(nodes: PlanNode[]): void {
  const remaining = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn)]));
  let removed = 0;
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0);
    if (ready.length === 0) throw new Error('Planner produced a dependency cycle');
    for (const [id] of ready) {
      remaining.delete(id);
      removed += 1;
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  if (removed !== nodes.length) throw new Error('Planner produced an invalid graph');
}
