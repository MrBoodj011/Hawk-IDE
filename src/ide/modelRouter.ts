import type { CapabilityDescriptor, GoalSpec, PlanNode } from './smartTypes.js';

export type AgentRole = PlanNode['agentRole'];

export interface ModelRoutingDecision {
  agentRole: AgentRole;
  modelRoute: PlanNode['modelRoute'];
  independentVerifierModelClass?: PlanNode['independentVerifierModelClass'];
  scorecard?: {
    selectedScore: number;
    candidates: Array<{ providerModel: string; score: number; reasons: string[] }>;
    cacheKey: string;
    cacheTtlSeconds: number;
    shadowCandidate?: string;
  };
}

export interface ModelPerformanceProfile {
  providerModel: string;
  modelClass: PlanNode['modelRoute']['modelClass'];
  roles?: AgentRole[];
  quality: number;
  reliability: number;
  p95LatencyMs: number;
  costPerMillionTokensUsd: number;
  contextWindow: number;
  local: boolean;
  sampleSize: number;
  /** ISO timestamp of the newest evaluation used for this profile. */
  lastEvaluatedAt?: string;
}

export class HawkModelRouter {
  private profiles: ModelPerformanceProfile[];

  constructor(profiles: ModelPerformanceProfile[] = []) {
    this.profiles = [...profiles];
  }

  /**
   * Replace the measured profile snapshot used by subsequent route decisions.
   * Eval telemetry is intentionally kept outside the router; this small live
   * update boundary lets a running IDE adapt without rebuilding its planner.
   */
  setProfiles(profiles: ModelPerformanceProfile[]): void {
    this.profiles = [...profiles];
  }

  /** Return a defensive copy of the currently active evaluation snapshot. */
  getProfiles(): ModelPerformanceProfile[] {
    return [...this.profiles];
  }

  route(capability: CapabilityDescriptor, goal: GoalSpec): ModelRoutingDecision {
    const agentRole = roleFor(capability.id);
    const deterministic = capability.deterministic;
    const hosted = goal.modelPolicy.dataPolicy === 'allow-hosted';
    const modelClass = deterministic
      ? 'deterministic'
      : hosted
        ? capability.category === 'remediation'
          ? 'hosted-code'
          : 'hosted-reasoning'
        : capability.category === 'remediation'
          ? 'local-code'
          : 'local-small';
    const preferred =
      goal.modelPolicy.preferredModels[agentRole] ?? goal.modelPolicy.preferredModels[modelClass];
    const candidates = this.profiles
      .filter((profile) => profile.modelClass === modelClass)
      .filter((profile) => hosted || profile.local)
      .filter((profile) => !profile.roles || profile.roles.includes(agentRole))
      .map((profile) => scoreProfile(profile, capability, agentRole))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.profile.providerModel.localeCompare(right.profile.providerModel),
      );
    const measured =
      candidates.find((candidate) => candidate.profile.providerModel === preferred) ??
      candidates[0];
    const selectedModel = preferred ?? measured?.profile.providerModel;
    const verification =
      capability.category === 'validation' || capability.category === 'remediation'
        ? hosted
          ? 'hosted-reasoning'
          : deterministic
            ? 'deterministic'
            : 'local-small'
        : undefined;
    return {
      agentRole,
      modelRoute: {
        modelClass,
        ...(selectedModel ? { providerModel: selectedModel } : {}),
        dataPolicy: goal.modelPolicy.dataPolicy,
        rationale: deterministic
          ? 'Deterministic analysis is cheaper, reproducible, and preferred over an LLM for this step.'
          : hosted
            ? 'Hosted reasoning is allowed by the goal data policy for this non-deterministic step.'
            : 'The goal is local-only, so Hawk selected a local model class.',
      },
      ...(verification ? { independentVerifierModelClass: verification } : {}),
      ...(measured
        ? {
            scorecard: {
              selectedScore: measured.score,
              candidates: candidates.slice(0, 8).map((candidate) => ({
                providerModel: candidate.profile.providerModel,
                score: candidate.score,
                reasons: candidate.reasons,
              })),
              cacheKey: modelCacheKey(capability, goal, measured.profile.providerModel),
              cacheTtlSeconds: capability.deterministic ? 3_600 : 300,
              ...(candidates[1] ? { shadowCandidate: candidates[1].profile.providerModel } : {}),
            },
          }
        : {}),
    };
  }
}

function scoreProfile(
  profile: ModelPerformanceProfile,
  capability: CapabilityDescriptor,
  role: AgentRole,
): { profile: ModelPerformanceProfile; score: number; reasons: string[] } {
  const qualityWeight =
    capability.category === 'remediation' || role === 'code-review' ? 0.45 : 0.35;
  const reliabilityWeight =
    capability.risk === 'high' || capability.risk === 'critical' ? 0.35 : 0.25;
  const latencyScore = Math.max(0, 1 - profile.p95LatencyMs / 30_000);
  const costScore = Math.max(0, 1 - profile.costPerMillionTokensUsd / 100);
  const confidence = Math.min(1, profile.sampleSize / 50);
  const raw =
    profile.quality * qualityWeight +
    profile.reliability * reliabilityWeight +
    latencyScore * 0.15 +
    costScore * 0.1 +
    (profile.local ? 0.05 : 0);
  const score = Number((raw * (0.7 + confidence * 0.3) * 100).toFixed(3));
  return {
    profile,
    score,
    reasons: [
      `quality ${Math.round(profile.quality * 100)}%`,
      `reliability ${Math.round(profile.reliability * 100)}%`,
      `p95 ${Math.round(profile.p95LatencyMs)}ms`,
      `${profile.sampleSize} evaluation samples`,
      profile.local ? 'local privacy bonus' : 'hosted route permitted',
    ],
  };
}

function modelCacheKey(
  capability: CapabilityDescriptor,
  goal: GoalSpec,
  providerModel: string,
): string {
  const material = [
    capability.id,
    capability.version,
    goal.modelPolicy.dataPolicy,
    providerModel,
    goal.objective.trim().toLowerCase(),
  ].join('\u0000');
  let hash = 2166136261;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `model-route-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function roleFor(capabilityId: string): AgentRole {
  if (capabilityId.startsWith('context.') || capabilityId === 'proof.graph.build') return 'context';
  if (capabilityId.startsWith('code.')) return 'code-review';
  if (capabilityId.startsWith('traffic.')) return 'traffic-analysis';
  if (capabilityId.startsWith('supply-chain.')) return 'supply-chain';
  if (capabilityId.startsWith('evidence.')) return 'evidence-verifier';
  if (capabilityId.startsWith('runtime.')) return 'runtime-validator';
  if (capabilityId === 'patch.regression.validate') return 'regression-judge';
  return 'patch-engineer';
}
