import type { CapabilityDescriptor } from './smartTypes.js';

const CORE_CAPABILITIES: CapabilityDescriptor[] = [
  {
    id: 'context.workspace.snapshot',
    title: 'Workspace context snapshot',
    description:
      'Build a redacted snapshot of source routes, local signals, imported traffic, and repository posture.',
    category: 'context',
    risk: 'low',
    requiredActions: ['read-workspace'],
    deterministic: true,
    averageDurationSeconds: 2,
    estimatedCostUsd: 0,
    reliability: 0.99,
    evidenceKinds: ['workspace-snapshot'],
    provenance: 'hawk-core',
    version: '1.0.0',
    enabled: true,
  },
  {
    id: 'code.route.inventory',
    title: 'Route and attack-surface inventory',
    description: 'Passively map Express, Fastify, and Next.js routes from local source code.',
    category: 'code',
    risk: 'low',
    requiredActions: ['read-workspace'],
    deterministic: true,
    averageDurationSeconds: 3,
    estimatedCostUsd: 0,
    reliability: 0.96,
    evidenceKinds: ['route', 'file', 'symbol'],
    provenance: 'hawk-core',
    version: '1.0.0',
    enabled: true,
  },
  {
    id: 'code.static.audit',
    title: 'High-signal static security audit',
    description: 'Find suspicious local code patterns and preserve them as unverified signals.',
    category: 'code',
    risk: 'low',
    requiredActions: ['read-workspace'],
    deterministic: true,
    averageDurationSeconds: 8,
    estimatedCostUsd: 0,
    reliability: 0.86,
    evidenceKinds: ['finding', 'code-location'],
    provenance: 'hawk-core',
    version: '1.0.0',
    enabled: true,
  },
  {
    id: 'traffic.source.correlate',
    title: 'Source-to-request correlation',
    description:
      'Correlate redacted imported HTTP traffic with source routes without replaying requests.',
    category: 'traffic',
    risk: 'low',
    requiredActions: ['read-workspace'],
    deterministic: true,
    averageDurationSeconds: 5,
    estimatedCostUsd: 0,
    reliability: 0.9,
    evidenceKinds: ['request', 'route', 'correlation'],
    provenance: 'hawk-core',
    version: '1.0.0',
    enabled: true,
  },
  {
    id: 'supply-chain.health',
    title: 'Supply-chain posture',
    description:
      'Read sanitized local Hawk repository health, alert, SBOM, and governance evidence.',
    category: 'supply-chain',
    risk: 'low',
    requiredActions: ['read-workspace'],
    deterministic: true,
    averageDurationSeconds: 2,
    estimatedCostUsd: 0,
    reliability: 0.98,
    evidenceKinds: ['repository-risk', 'sbom-posture'],
    provenance: 'hawk-core',
    version: '1.0.0',
    enabled: true,
  },
  {
    id: 'proof.graph.build',
    title: 'ProofGraph builder',
    description:
      'Link code, routes, requests, findings, evidence, patches, tests, tools, and runs.',
    category: 'governance',
    risk: 'low',
    requiredActions: ['read-workspace'],
    deterministic: true,
    averageDurationSeconds: 3,
    estimatedCostUsd: 0,
    reliability: 0.99,
    evidenceKinds: ['proof-node', 'proof-edge'],
    provenance: 'hawk-core',
    version: '1.0.0',
    enabled: true,
  },
  {
    id: 'evidence.independent.verify',
    title: 'Independent evidence verifier',
    description:
      'Apply baseline, reproduction, identity, impact, scope, side-effect, and redaction gates.',
    category: 'validation',
    risk: 'medium',
    requiredActions: ['read-workspace'],
    deterministic: true,
    averageDurationSeconds: 5,
    estimatedCostUsd: 0,
    reliability: 0.97,
    evidenceKinds: ['verification', 'finding-lifecycle'],
    provenance: 'hawk-core',
    version: '1.0.0',
    enabled: true,
  },
  {
    id: 'runtime.authorized.validate',
    title: 'Authorized runtime validation',
    description:
      'Run a scoped validation inside an isolated worker after exact-plan operator approval.',
    category: 'validation',
    risk: 'high',
    requiredActions: ['run-container', 'network-access', 'active-security-test'],
    deterministic: false,
    averageDurationSeconds: 300,
    estimatedCostUsd: 0.1,
    reliability: 0.82,
    evidenceKinds: ['request', 'response', 'reproduction'],
    provenance: 'hawk-core',
    version: '1.0.0',
    enabled: true,
  },
  {
    id: 'patch.candidate.generate',
    title: 'Secure patch candidate',
    description:
      'Generate an isolated patch candidate bound to a verified finding and explicit diff.',
    category: 'remediation',
    risk: 'medium',
    requiredActions: ['read-workspace', 'write-workspace', 'run-container'],
    deterministic: false,
    averageDurationSeconds: 180,
    estimatedCostUsd: 0.15,
    reliability: 0.78,
    evidenceKinds: ['patch', 'diff'],
    provenance: 'hawk-core',
    version: '1.0.0',
    enabled: true,
  },
  {
    id: 'patch.regression.validate',
    title: 'Patch regression and security retest',
    description: 'Run tests and verify that a candidate fixes the finding without new regressions.',
    category: 'remediation',
    risk: 'medium',
    requiredActions: ['read-workspace', 'run-container'],
    deterministic: true,
    averageDurationSeconds: 240,
    estimatedCostUsd: 0,
    reliability: 0.91,
    evidenceKinds: ['test', 'retest', 'patch-score'],
    provenance: 'hawk-core',
    version: '1.0.0',
    enabled: true,
  },
];

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDescriptor>(
    CORE_CAPABILITIES.map((capability) => [capability.id, capability]),
  );

  list(): CapabilityDescriptor[] {
    return [...this.capabilities.values()].map((capability) => ({ ...capability }));
  }

  get(id: string): CapabilityDescriptor | undefined {
    const capability = this.capabilities.get(id);
    return capability ? { ...capability } : undefined;
  }

  register(capability: CapabilityDescriptor): void {
    if (!/^[a-z][a-z0-9.-]{2,127}$/.test(capability.id))
      throw new Error(`Invalid capability id: ${capability.id}`);
    this.capabilities.set(capability.id, { ...capability });
  }

  search(query: string, limit = 5): CapabilityDescriptor[] {
    const tokens = tokenize(query);
    return this.list()
      .filter((capability) => capability.enabled)
      .map((capability) => ({
        capability,
        score: scoreCapability(capability, tokens),
      }))
      .filter(({ score }) => tokens.length === 0 || score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.capability.reliability - a.capability.reliability ||
          a.capability.id.localeCompare(b.capability.id),
      )
      .slice(0, Math.max(1, Math.min(limit, 20)))
      .map(({ capability }) => capability);
  }
}

function scoreCapability(capability: CapabilityDescriptor, tokens: string[]): number {
  const id = capability.id.toLowerCase();
  const title = capability.title.toLowerCase();
  const description = capability.description.toLowerCase();
  const evidence = capability.evidenceKinds.join(' ').toLowerCase();
  return tokens.reduce((score, token) => {
    if (id.includes(token)) return score + 8;
    if (title.includes(token)) return score + 5;
    if (description.includes(token)) return score + 2;
    if (evidence.includes(token)) return score + 1;
    return score;
  }, 0);
}

function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 1),
    ),
  ];
}
