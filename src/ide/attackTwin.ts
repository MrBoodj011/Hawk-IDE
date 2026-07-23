import { createHash } from 'node:crypto';
import {
  type AttackTwinPath,
  type AttackTwinResponse,
  IDE_PROTOCOL_VERSION,
  type ProtocolSurfaceInventory,
  type SecurityFinding,
  type SecurityGraphResponse,
  type WorkspaceInventory,
} from './protocol.js';

export function buildAttackTwin(input: {
  inventory: WorkspaceInventory;
  protocols: ProtocolSurfaceInventory;
  graph: SecurityGraphResponse;
  findings: SecurityFinding[];
  now?: Date;
}): AttackTwinResponse {
  const entries = [
    ...input.inventory.routes.map((route) => ({
      key: `route:${route.method}:${route.path}:${route.file}`,
      label: `${route.method} ${route.path}`,
      protocol: 'http-route' as const,
      file: route.file,
      exposure: 'unknown' as const,
      authSignals: [] as string[],
    })),
    ...input.protocols.surfaces.map((surface) => ({
      key: surface.id,
      label: surface.label,
      protocol: surface.kind,
      file: surface.file,
      exposure: surface.exposure,
      authSignals: surface.authSignals,
    })),
  ];
  const paths = entries
    .map((entry) => attackPath(entry, input.findings, input.graph))
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, 250);
  const trustBoundaries = buildTrustBoundaries(input.protocols);
  const whatIf = buildWhatIf(paths);
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    summary: {
      entryPoints: entries.length,
      protocolSurfaces: input.protocols.summary.total,
      trustBoundaries: trustBoundaries.length,
      hypotheses: paths.filter((path) => path.status === 'hypothesis').length,
      reproducedPaths: paths.filter((path) => path.status === 'reproduced').length,
      verifiedPaths: paths.filter((path) => path.status === 'verified').length,
      highestScore: paths[0]?.score ?? 0,
    },
    paths,
    trustBoundaries,
    whatIf,
    statement:
      'Hawk Attack Twin is an evidence-aware model. Unreproduced paths remain hypotheses and are not vulnerability verdicts.',
  };
}

function attackPath(
  entry: {
    key: string;
    label: string;
    protocol: AttackTwinPath['protocol'];
    file: string;
    exposure: string;
    authSignals: string[];
  },
  findings: SecurityFinding[],
  graph: SecurityGraphResponse,
): AttackTwinPath {
  const related = findings.filter(
    (finding) =>
      finding.source?.file === entry.file ||
      (entry.protocol === 'http-route' &&
        finding.route &&
        entry.label.includes(finding.route.path)),
  );
  const findingNodeIds = graph.nodes
    .filter(
      (node) =>
        node.kind === 'finding' &&
        related.some((finding) => node.attributes.findingId === finding.id),
    )
    .map((node) => node.id);
  const evidenceNodeIds = graph.edges
    .filter(
      (edge) =>
        findingNodeIds.includes(edge.to) &&
        ['supports', 'documents', 'reproduces-signal'].includes(edge.relation),
    )
    .map((edge) => edge.from);
  const reproduced = graph.edges.some(
    (edge) => findingNodeIds.includes(edge.to) && edge.relation === 'reproduces-signal',
  );
  const verified = related.some((finding) => finding.status === 'retested');
  const severity = Math.max(0, ...related.map((finding) => severityScore(finding.severity)));
  const exposure = entry.exposure === 'public' ? 22 : entry.exposure === 'authenticated' ? 10 : 5;
  const score = Math.min(
    100,
    12 + severity + exposure + (reproduced ? 15 : 0) + (verified ? 8 : 0),
  );
  const status: AttackTwinPath['status'] = verified
    ? 'verified'
    : reproduced
      ? 'reproduced'
      : 'hypothesis';
  return {
    id: `attack-path-${hash(entry.key)}`,
    title: `${entry.label} -> ${related[0]?.title ?? 'unverified security boundary'}`,
    score,
    status,
    entryPoint: entry.label,
    protocol: entry.protocol,
    assets: [entry.file],
    findingIds: related.map((finding) => finding.id),
    evidenceNodeIds: [...new Set(evidenceNodeIds)],
    sourceFiles: [entry.file],
    rationale: [
      `${entry.protocol} entry point discovered in source`,
      `${related.length} source-linked security signal${related.length === 1 ? '' : 's'}`,
      entry.authSignals.length > 0
        ? `Auth signals: ${entry.authSignals.join(', ')}`
        : 'No nearby auth control was proven by static discovery',
      `${evidenceNodeIds.length} evidence node${evidenceNodeIds.length === 1 ? '' : 's'} linked`,
    ],
    recommendedNextGate:
      status === 'verified'
        ? 'Retest the fixed path before release.'
        : status === 'reproduced'
          ? 'Require independent reproduction and impact verification.'
          : 'Create an isolated, approval-bound reproduction plan.',
  };
}

function buildTrustBoundaries(
  protocols: ProtocolSurfaceInventory,
): AttackTwinResponse['trustBoundaries'] {
  const groups: Array<{
    id: string;
    label: string;
    kind: AttackTwinResponse['trustBoundaries'][number]['kind'];
    kinds: string[];
  }> = [
    {
      id: 'boundary-identity',
      label: 'Identity provider boundary',
      kind: 'identity',
      kinds: ['oauth-oidc', 'saml'],
    },
    {
      id: 'boundary-network',
      label: 'Public and realtime network boundary',
      kind: 'network',
      kinds: ['graphql', 'websocket', 'grpc', 'openapi', 'mobile-api'],
    },
    {
      id: 'boundary-runtime',
      label: 'Container orchestration boundary',
      kind: 'runtime',
      kinds: ['kubernetes'],
    },
    {
      id: 'boundary-cloud',
      label: 'Cloud control-plane boundary',
      kind: 'cloud',
      kinds: ['terraform', 'cloud-iam'],
    },
  ];
  return groups
    .map((group) => ({
      id: group.id,
      label: group.label,
      kind: group.kind,
      sourceFiles: [
        ...new Set(
          protocols.surfaces
            .filter((surface) => group.kinds.includes(surface.kind))
            .map((surface) => surface.file),
        ),
      ],
    }))
    .filter((group) => group.sourceFiles.length > 0);
}

function buildWhatIf(paths: AttackTwinPath[]): AttackTwinResponse['whatIf'] {
  const publicIds = paths.filter((path) => path.score >= 50).map((path) => path.id);
  const authIds = paths
    .filter((path) => ['oauth-oidc', 'saml'].includes(path.protocol))
    .map((path) => path.id);
  return [
    {
      id: 'what-if-public-entry',
      premise: 'A high-risk external entry point becomes reachable',
      affectedPathIds: publicIds,
      estimatedBlastRadius: publicIds.length,
      statement: 'This is a static scenario estimate, not a confirmed exploit path.',
    },
    {
      id: 'what-if-identity-bypass',
      premise: 'An identity trust boundary is misconfigured',
      affectedPathIds: authIds,
      estimatedBlastRadius: authIds.length,
      statement: 'Hawk requires authorized reproduction before promoting this scenario.',
    },
  ].filter((scenario) => scenario.affectedPathIds.length > 0);
}

function severityScore(severity: SecurityFinding['severity']): number {
  return { critical: 58, high: 45, medium: 30, low: 15, info: 5 }[severity];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}
