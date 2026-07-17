import type { CapabilityDescriptor, GoalSpec, PlanNode } from './smartTypes.js';

export type AgentRole = PlanNode['agentRole'];

export interface ModelRoutingDecision {
  agentRole: AgentRole;
  modelRoute: PlanNode['modelRoute'];
  independentVerifierModelClass?: PlanNode['independentVerifierModelClass'];
}

export class HawkModelRouter {
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
        ...(preferred ? { providerModel: preferred } : {}),
        dataPolicy: goal.modelPolicy.dataPolicy,
        rationale: deterministic
          ? 'Deterministic analysis is cheaper, reproducible, and preferred over an LLM for this step.'
          : hosted
            ? 'Hosted reasoning is allowed by the goal data policy for this non-deterministic step.'
            : 'The goal is local-only, so Hawk selected a local model class.',
      },
      ...(verification ? { independentVerifierModelClass: verification } : {}),
    };
  }
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
