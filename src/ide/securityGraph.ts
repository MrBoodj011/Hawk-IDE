import { createHash } from 'node:crypto';
import type { AiSessionSummary } from './aiProtocol.js';
import type { ProofEdgeInput, ProofGraph, ProofNodeInput } from './proofGraph.js';
import {
  type EvidencePackReport,
  IDE_PROTOCOL_VERSION,
  type ProtocolSurfaceInventory,
  type SandboxReproductionResult,
  type SecurityFinding,
  type SecurityGraphEdge,
  type SecurityGraphNode,
  type SecurityGraphResponse,
  type TrafficInventory,
  type TrafficRequest,
  type WorkspaceInventory,
  type WorkspaceRoute,
} from './protocol.js';
import type { ProofGraphSnapshot, ProofNodeKind } from './smartTypes.js';

const MAX_INPUT_ITEMS = 2_000;
const VISIBLE_NODE_KINDS = new Set<ProofNodeKind>([
  'repository',
  'file',
  'symbol',
  'route',
  'request',
  'finding',
  'evidence',
  'patch',
  'test',
  'agent',
  'protocol',
  'infrastructure',
  'trust-boundary',
]);

export interface SecurityGraphBuildInput {
  inventory: WorkspaceInventory;
  findings: SecurityFinding[];
  traffic?: TrafficInventory | null;
  evidencePacks?: EvidencePackReport[];
  sessions?: AiSessionSummary[];
  reproductions?: SandboxReproductionResult[];
  protocols?: ProtocolSurfaceInventory;
}

export interface SecurityTrafficCorrelation {
  request: TrafficRequest;
  route: WorkspaceRoute;
  confidence: number;
}

export async function buildUnifiedSecurityGraph(
  graph: ProofGraph,
  input: SecurityGraphBuildInput,
): Promise<SecurityGraphResponse> {
  const nodes = new Map<string, ProofNodeInput>();
  const edges = new Map<string, ProofEdgeInput>();
  const addNode = (node: ProofNodeInput): void => {
    nodes.set(node.id, node);
  };
  const addEdge = (edge: ProofEdgeInput): void => {
    edges.set(`${edge.from}\u0000${edge.to}\u0000${edge.relation}`, edge);
  };
  const repositoryId = 'repository-workspace';
  addNode({
    id: repositoryId,
    kind: 'repository',
    label: 'Current workspace',
    attributes: {
      root: input.inventory.root,
      sourceFiles: input.inventory.sourceFiles,
      provenance: 'hawk-workspace-index',
    },
  });

  const routes = input.inventory.routes.slice(0, MAX_INPUT_ITEMS);
  for (const route of routes) {
    const fileId = fileNodeId(route.file);
    const symbolId = symbolNodeId(route);
    const routeId = routeNodeId(route);
    addNode({
      id: fileId,
      kind: 'file',
      label: route.file,
      attributes: { file: route.file, provenance: 'hawk-workspace-index' },
    });
    addNode({
      id: symbolId,
      kind: 'symbol',
      label: `${route.method} ${route.path} handler`,
      attributes: {
        file: route.file,
        line: route.line,
        framework: route.framework,
        provenance: 'hawk-route-scanner',
      },
    });
    addNode({
      id: routeId,
      kind: 'route',
      label: `${route.method} ${route.path}`,
      attributes: {
        method: route.method,
        path: route.path,
        file: route.file,
        line: route.line,
        framework: route.framework,
        provenance: 'hawk-route-scanner',
      },
    });
    addEdge({
      from: repositoryId,
      to: fileId,
      relation: 'contains',
      attributes: { confidence: 1, provenance: 'hawk-workspace-index' },
    });
    addEdge({
      from: fileId,
      to: symbolId,
      relation: 'defines',
      attributes: { confidence: 1, provenance: 'hawk-route-scanner' },
    });
    addEdge({
      from: symbolId,
      to: routeId,
      relation: 'handles',
      attributes: { confidence: 1, provenance: 'hawk-route-scanner' },
    });
  }

  for (const surface of input.protocols?.surfaces.slice(0, MAX_INPUT_ITEMS) ?? []) {
    const fileId = fileNodeId(surface.file);
    const surfaceId = `protocol-${stableHash(surface.id)}`;
    const infrastructure = ['kubernetes', 'terraform', 'cloud-iam'].includes(surface.kind);
    addNode({
      id: fileId,
      kind: 'file',
      label: surface.file,
      attributes: { file: surface.file, provenance: 'hawk-protocol-intelligence' },
    });
    addNode({
      id: surfaceId,
      kind: infrastructure ? 'infrastructure' : 'protocol',
      label: surface.label,
      attributes: {
        protocolKind: surface.kind,
        file: surface.file,
        line: surface.line,
        exposure: surface.exposure,
        authSignals: surface.authSignals.join(','),
        provenance: surface.provenance,
      },
    });
    addEdge({
      from: repositoryId,
      to: fileId,
      relation: 'contains',
      attributes: { confidence: 1, provenance: 'hawk-protocol-intelligence' },
    });
    addEdge({
      from: fileId,
      to: surfaceId,
      relation: infrastructure ? 'configures' : 'exposes',
      attributes: { confidence: 0.9, provenance: 'hawk-protocol-intelligence' },
    });
    const boundaryKind = ['oauth-oidc', 'saml'].includes(surface.kind)
      ? 'identity'
      : infrastructure
        ? 'cloud-runtime'
        : 'network';
    const boundaryId = `trust-boundary-${boundaryKind}`;
    addNode({
      id: boundaryId,
      kind: 'trust-boundary',
      label: `${boundaryKind} trust boundary`,
      attributes: { boundaryKind, provenance: 'hawk-attack-twin' },
    });
    addEdge({
      from: surfaceId,
      to: boundaryId,
      relation: 'crosses',
      attributes: { confidence: 0.7, provenance: 'hawk-attack-twin', verified: false },
    });
  }

  const correlations = correlateSecurityTraffic(routes, input.traffic);
  for (const request of input.traffic?.requests.slice(0, MAX_INPUT_ITEMS) ?? []) {
    addNode({
      id: requestNodeId(request),
      kind: 'request',
      label: `${request.method} ${safePathname(request.url)}`,
      attributes: {
        requestId: request.id,
        method: request.method,
        host: request.host,
        status: request.status ?? 0,
        source: request.source ?? 'har',
        startedAt: request.startedAt,
        provenance: `hawk-${request.source ?? 'traffic'}-capture`,
      },
    });
  }
  for (const correlation of correlations) {
    addEdge({
      from: requestNodeId(correlation.request),
      to: routeNodeId(correlation.route),
      relation: 'observed-at',
      attributes: {
        confidence: correlation.confidence,
        provenance: 'hawk-source-request-correlation',
      },
    });
  }

  const findings = input.findings.slice(0, MAX_INPUT_ITEMS);
  for (const finding of findings) {
    addNode({
      id: findingNodeId(finding),
      kind: 'finding',
      label: finding.title,
      attributes: {
        findingId: finding.id,
        ruleId: finding.ruleId,
        severity: finding.severity,
        status: finding.status,
        confidence: finding.confidence,
        ...(finding.source ? { file: finding.source.file, line: finding.source.line } : {}),
        provenance: 'hawk-static-audit',
      },
    });
    if (finding.source) {
      const fileId = fileNodeId(finding.source.file);
      addNode({
        id: fileId,
        kind: 'file',
        label: finding.source.file,
        attributes: {
          file: finding.source.file,
          provenance: 'hawk-static-audit',
        },
      });
      addEdge({
        from: repositoryId,
        to: fileId,
        relation: 'contains',
        attributes: { confidence: 1, provenance: 'hawk-workspace-index' },
      });
      addEdge({
        from: fileId,
        to: findingNodeId(finding),
        relation: 'contains-signal',
        attributes: { confidence: 1, provenance: 'hawk-static-audit' },
      });
      const relatedRoutes = routes.filter((route) => findingMatchesRoute(finding, route));
      for (const route of relatedRoutes.slice(0, 20)) {
        const exactRoute = Boolean(
          finding.route &&
            finding.route.method === route.method &&
            finding.route.path === route.path,
        );
        addEdge({
          from: routeNodeId(route),
          to: findingNodeId(finding),
          relation: 'source-context-for',
          attributes: {
            confidence: exactRoute ? 0.98 : 0.7,
            provenance: exactRoute
              ? 'hawk-finding-route-reference'
              : 'hawk-shared-source-correlation',
          },
        });
        for (const correlation of correlations.filter(
          (candidate) => routeNodeId(candidate.route) === routeNodeId(route),
        )) {
          addEdge({
            from: requestNodeId(correlation.request),
            to: findingNodeId(finding),
            relation: 'runtime-context-for',
            attributes: {
              confidence: exactRoute ? 0.95 : 0.65,
              provenance: 'hawk-source-request-correlation',
              verdict: false,
            },
          });
        }
      }
    }
    for (const [index, evidence] of finding.evidence.slice(0, 50).entries()) {
      const evidenceId = evidenceNodeId(finding.id, index, evidence.summary);
      addNode({
        id: evidenceId,
        kind: 'evidence',
        label: evidence.summary,
        attributes: {
          kind: evidence.kind,
          findingId: finding.id,
          ...(finding.source ? { file: finding.source.file, line: finding.source.line } : {}),
          provenance: 'hawk-static-audit',
        },
      });
      addEdge({
        from: evidenceId,
        to: findingNodeId(finding),
        relation: 'supports',
        attributes: {
          confidence: 0.75,
          provenance: 'hawk-static-audit',
          verified: false,
        },
      });
    }
  }

  for (const pack of input.evidencePacks?.slice(-20) ?? []) {
    const packId = `evidence-pack-${stableHash(pack.id)}`;
    addNode({
      id: packId,
      kind: 'evidence',
      label: `Evidence pack ${pack.id}`,
      attributes: {
        path: pack.primaryReportPath,
        createdAt: pack.createdAt,
        artifacts: pack.artifacts.length,
        provenance: 'hawk-evidence-builder',
      },
    });
    for (const finding of findings.slice(0, 500)) {
      addEdge({
        from: packId,
        to: findingNodeId(finding),
        relation: 'documents',
        attributes: { confidence: 1, provenance: 'hawk-evidence-builder' },
      });
    }
  }

  for (const reproduction of input.reproductions?.slice(0, 500) ?? []) {
    const finding = findings.find((candidate) => candidate.id === reproduction.findingId);
    if (!finding) continue;
    const reproductionId = `evidence-reproduction-${stableHash(reproduction.id)}`;
    addNode({
      id: reproductionId,
      kind: 'evidence',
      label:
        reproduction.status === 'reproduced'
          ? `Sandbox reproduced ${finding.title}`
          : `Sandbox attempt: ${finding.title}`,
      attributes: {
        reproductionId: reproduction.id,
        status: reproduction.status,
        lifecycle: reproduction.lifecycle,
        promotedToVerified: false,
        planHash: reproduction.planHash,
        orchestrationRunId: reproduction.orchestrationRunId,
        file: finding.source?.file ?? '',
        line: finding.source?.line ?? 1,
        provenance: 'hawk-sandbox-reproducer',
      },
    });
    addEdge({
      from: reproductionId,
      to: findingNodeId(finding),
      relation:
        reproduction.status === 'reproduced' ? 'reproduces-signal' : 'attempted-reproduction',
      attributes: {
        confidence: reproduction.status === 'reproduced' ? 0.9 : 0.4,
        provenance: 'hawk-sandbox-reproducer',
        verified: false,
      },
    });
  }

  for (const session of input.sessions?.slice(0, 100) ?? []) {
    const agentId = `agent-${stableHash(session.id)}`;
    addNode({
      id: agentId,
      kind: 'agent',
      label: session.title,
      attributes: {
        sessionId: session.id,
        status: session.status,
        model: session.model ?? 'local-or-configured',
        background: session.background,
        provenance: 'hawk-agent-session',
      },
    });
    const patchId = session.diff ? `patch-${stableHash(session.diff.patchHash)}` : undefined;
    if (session.diff && patchId) {
      addNode({
        id: patchId,
        kind: 'patch',
        label: `${session.diff.files} file patch`,
        attributes: {
          patchHash: session.diff.patchHash,
          files: session.diff.files,
          insertions: session.diff.insertions,
          deletions: session.diff.deletions,
          provenance: 'hawk-agent-session',
        },
      });
      addEdge({
        from: patchId,
        to: agentId,
        relation: 'produced-by',
        attributes: { confidence: 1, provenance: 'hawk-agent-session' },
      });
    }
    for (const result of session.testResults.slice(-30)) {
      const testId = `test-${stableHash(`${session.id}\u0000${result.gateId}`)}`;
      addNode({
        id: testId,
        kind: 'test',
        label: result.label,
        attributes: {
          gateId: result.gateId,
          status: result.status,
          durationMs: result.durationMs,
          provenance: 'hawk-debug-agent',
        },
      });
      addEdge({
        from: testId,
        to: patchId ?? agentId,
        relation: patchId ? 'validates' : 'executed-by',
        attributes: {
          confidence: 1,
          provenance: 'hawk-debug-agent',
          passed: result.status === 'passed',
        },
      });
    }
  }

  const snapshot = await graph.merge([...nodes.values()], [...edges.values()]);
  return securityGraphResponse(snapshot);
}

export function securityGraphResponse(
  snapshot: ProofGraphSnapshot,
  maxNodes = 800,
  maxEdges = 2_000,
): SecurityGraphResponse {
  const eligibleNodes = snapshot.nodes.filter((node) => VISIBLE_NODE_KINDS.has(node.kind));
  const eligibleNodeIds = new Set(eligibleNodes.map((node) => node.id));
  const orderedNodes = [...eligibleNodes].sort(
    (left, right) => nodePriority(right.kind) - nodePriority(left.kind),
  );
  const visibleNodes = orderedNodes.slice(0, maxNodes);
  const nodeIds = new Set(visibleNodes.map((node) => node.id));
  const eligibleEdges = snapshot.edges.filter(
    (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to),
  );
  const visibleEdges = eligibleEdges.slice(-maxEdges);
  const nodes: SecurityGraphNode[] = visibleNodes.map((node) => ({
    id: node.id,
    kind: node.kind as SecurityGraphNode['kind'],
    label: node.label,
    attributes: node.attributes,
  }));
  const edges: SecurityGraphEdge[] = visibleEdges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    attributes: edge.attributes ?? {},
  }));
  const count = (kind: SecurityGraphNode['kind']): number =>
    eligibleNodes.filter((node) => node.kind === kind).length;
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    updatedAt: snapshot.updatedAt,
    summary: {
      nodes: eligibleNodes.length,
      edges: snapshot.edges.filter(
        (edge) => eligibleNodeIds.has(edge.from) && eligibleNodeIds.has(edge.to),
      ).length,
      sourceFiles: count('file'),
      symbols: count('symbol'),
      routes: count('route'),
      requests: count('request'),
      findings: count('finding'),
      evidence: count('evidence'),
      patches: count('patch'),
      tests: count('test'),
      protocols: count('protocol'),
      infrastructure: count('infrastructure'),
      trustBoundaries: count('trust-boundary'),
      reproductions: snapshot.edges.filter(
        (edge) =>
          edge.relation === 'reproduces-signal' || edge.relation === 'attempted-reproduction',
      ).length,
      correlatedRequests: snapshot.edges.filter((edge) => edge.relation === 'observed-at').length,
      sourceLinkedFindings: snapshot.edges.filter((edge) => edge.relation === 'source-context-for')
        .length,
      evidenceLinkedFindings: snapshot.edges.filter(
        (edge) =>
          edge.relation === 'supports' ||
          edge.relation === 'documents' ||
          edge.relation === 'reproduces-signal',
      ).length,
    },
    nodes,
    edges,
    truncated: eligibleNodes.length > nodes.length || eligibleEdges.length > edges.length,
  };
}

export function correlateSecurityTraffic(
  routes: WorkspaceRoute[],
  traffic?: TrafficInventory | null,
): SecurityTrafficCorrelation[] {
  const output: SecurityTrafficCorrelation[] = [];
  for (const request of traffic?.requests.slice(0, MAX_INPUT_ITEMS) ?? []) {
    const pathname = safePathname(request.url);
    const route = routes.find(
      (candidate) =>
        candidate.method.toUpperCase() === request.method.toUpperCase() &&
        routePattern(candidate.path).test(pathname),
    );
    if (route) {
      output.push({
        request,
        route,
        confidence: normalizePath(route.path) === normalizePath(pathname) ? 1 : 0.85,
      });
    }
  }
  return output;
}

function findingMatchesRoute(finding: SecurityFinding, route: WorkspaceRoute): boolean {
  if (!finding.source || finding.source.file !== route.file) return false;
  if (!finding.route) return true;
  return finding.route.method === route.method && finding.route.path === route.path;
}

function fileNodeId(file: string): string {
  return `file-${stableHash(file)}`;
}

function symbolNodeId(route: WorkspaceRoute): string {
  return `symbol-${stableHash(`${route.file}\u0000${route.line}\u0000${route.method}\u0000${route.path}`)}`;
}

function routeNodeId(route: WorkspaceRoute): string {
  return `route-${stableHash(`${route.method}\u0000${route.path}\u0000${route.file}\u0000${route.line}`)}`;
}

function requestNodeId(request: TrafficRequest): string {
  return `request-${stableHash(request.id)}`;
}

function findingNodeId(finding: SecurityFinding): string {
  return `finding-${stableHash(finding.id)}`;
}

function evidenceNodeId(findingId: string, index: number, summary: string): string {
  return `evidence-${stableHash(`${findingId}\u0000${index}\u0000${summary}`)}`;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith('/') ? (url.split('?')[0] ?? '/') : '/';
  }
}

function normalizePath(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function routePattern(route: string): RegExp {
  const escaped = route
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([a-zA-Z0-9_]+)/g, '[^/]+')
    .replace(/\\\[[.]{3}[^\]]+\\\]/g, '.+')
    .replace(/\\\[[^\]]+\\\]/g, '[^/]+');
  return new RegExp(`^${escaped}/?$`);
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function nodePriority(kind: ProofNodeKind): number {
  const priorities: Partial<Record<ProofNodeKind, number>> = {
    finding: 100,
    evidence: 95,
    request: 90,
    route: 85,
    symbol: 80,
    file: 75,
    patch: 70,
    test: 65,
    agent: 60,
    repository: 50,
    protocol: 88,
    infrastructure: 87,
    'trust-boundary': 86,
  };
  return priorities[kind] ?? 0;
}
