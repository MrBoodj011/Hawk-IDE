import { randomUUID } from 'node:crypto';
import type { DurableStore } from './durableStore.js';
import type {
  FindingLifecycle,
  ProofEdge,
  ProofGraphSnapshot,
  ProofNode,
  ProofNodeKind,
  VerificationInput,
  VerificationResult,
} from './smartTypes.js';

const GRAPH_ID = 'workspace';

export interface ProofNodeInput {
  id: string;
  kind: ProofNodeKind;
  label: string;
  attributes?: ProofNode['attributes'];
}

export interface ProofEdgeInput {
  from: string;
  to: string;
  relation: string;
}

export class ProofGraph {
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: DurableStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async snapshot(): Promise<ProofGraphSnapshot> {
    return (
      (await this.store.readJson<ProofGraphSnapshot>('proof-graphs', GRAPH_ID)) ?? {
        protocolVersion: 1,
        updatedAt: this.now().toISOString(),
        nodes: [],
        edges: [],
      }
    );
  }

  async upsertNode(
    id: string,
    kind: ProofNodeKind,
    label: string,
    attributes: ProofNode['attributes'] = {},
  ): Promise<ProofNode> {
    return await this.serialize(async () => {
      const graph = await this.snapshot();
      const existing = graph.nodes.find((node) => node.id === id);
      const node: ProofNode = {
        id,
        kind,
        label: label.slice(0, 500),
        attributes: sanitizeAttributes(attributes),
        createdAt: existing?.createdAt ?? this.now().toISOString(),
      };
      graph.nodes = [...graph.nodes.filter((candidate) => candidate.id !== id), node].slice(
        -20_000,
      );
      graph.updatedAt = this.now().toISOString();
      await this.store.writeJson('proof-graphs', GRAPH_ID, graph);
      return node;
    });
  }

  async connect(from: string, to: string, relation: string): Promise<ProofEdge> {
    return await this.serialize(async () => {
      const graph = await this.snapshot();
      if (!graph.nodes.some((node) => node.id === from))
        throw new Error(`Unknown proof node: ${from}`);
      if (!graph.nodes.some((node) => node.id === to)) throw new Error(`Unknown proof node: ${to}`);
      const key = `${from}\u0000${to}\u0000${relation}`;
      const existing = graph.edges.find(
        (edge) => `${edge.from}\u0000${edge.to}\u0000${edge.relation}` === key,
      );
      if (existing) return existing;
      const edge: ProofEdge = {
        id: `edge-${randomUUID()}`,
        from,
        to,
        relation: relation.trim().slice(0, 100),
        createdAt: this.now().toISOString(),
      };
      graph.edges = [...graph.edges, edge].slice(-50_000);
      graph.updatedAt = this.now().toISOString();
      await this.store.writeJson('proof-graphs', GRAPH_ID, graph);
      return edge;
    });
  }

  async merge(nodes: ProofNodeInput[], edges: ProofEdgeInput[]): Promise<ProofGraphSnapshot> {
    if (nodes.length > 25_000)
      throw new Error('A ProofGraph merge is limited to 25,000 node inputs');
    if (edges.length > 25_000) throw new Error('A ProofGraph merge is limited to 25,000 edges');
    return await this.serialize(async () => {
      const graph = await this.snapshot();
      const incoming = new Map<string, ProofNode>();
      for (const candidate of nodes) {
        const existing =
          incoming.get(candidate.id) ?? graph.nodes.find((node) => node.id === candidate.id);
        incoming.set(candidate.id, {
          id: candidate.id,
          kind: candidate.kind,
          label: candidate.label.slice(0, 500),
          attributes: sanitizeAttributes(candidate.attributes ?? {}),
          createdAt: existing?.createdAt ?? this.now().toISOString(),
        });
      }
      graph.nodes = [
        ...graph.nodes.filter((node) => !incoming.has(node.id)),
        ...incoming.values(),
      ].slice(-20_000);
      const nodeIds = new Set(graph.nodes.map((node) => node.id));
      const edgeKeys = new Set(
        graph.edges.map((edge) => `${edge.from}\u0000${edge.to}\u0000${edge.relation}`),
      );
      const additions: ProofEdge[] = [];
      for (const candidate of edges) {
        if (!nodeIds.has(candidate.from)) throw new Error(`Unknown proof node: ${candidate.from}`);
        if (!nodeIds.has(candidate.to)) throw new Error(`Unknown proof node: ${candidate.to}`);
        const relation = candidate.relation.trim().slice(0, 100);
        const key = `${candidate.from}\u0000${candidate.to}\u0000${relation}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        additions.push({
          id: `edge-${randomUUID()}`,
          from: candidate.from,
          to: candidate.to,
          relation,
          createdAt: this.now().toISOString(),
        });
      }
      graph.edges = [...graph.edges, ...additions]
        .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
        .slice(-50_000);
      graph.updatedAt = this.now().toISOString();
      await this.store.writeJson('proof-graphs', GRAPH_ID, graph);
      return structuredClone(graph);
    });
  }

  async subgraph(nodeId: string, depth = 2): Promise<ProofGraphSnapshot> {
    const graph = await this.snapshot();
    const selected = new Set([nodeId]);
    for (let level = 0; level < Math.max(0, Math.min(depth, 5)); level += 1) {
      for (const edge of graph.edges) {
        if (selected.has(edge.from) || selected.has(edge.to)) {
          selected.add(edge.from);
          selected.add(edge.to);
        }
      }
    }
    return {
      ...graph,
      nodes: graph.nodes.filter((node) => selected.has(node.id)),
      edges: graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)),
    };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation, operation);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export class EvidenceVerifier {
  constructor(
    private readonly graph: ProofGraph,
    private readonly store: DurableStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verify(input: VerificationInput): Promise<VerificationResult> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(input.findingId))
      throw new Error('Finding id must be a safe local identifier');
    const verifier = input.verifier.trim().slice(0, 160);
    if (!verifier) throw new Error('Verification requires a named verifier');
    const evidenceUris = [...new Set(input.evidenceUris.map((uri) => uri.trim()))].slice(0, 100);
    if (evidenceUris.some((uri) => !uri.startsWith('hawk://')))
      throw new Error('Verification evidence must use a local hawk:// resource URI');
    const gates: Array<[string, boolean]> = [
      ['baseline or control observation is missing', input.baselineObserved],
      ['reproduction failed', input.reproduced],
      ['independent reproduction is missing', input.independentReproduction],
      ['test identity is invalid or unknown', input.identityValid],
      ['impact was not demonstrated', input.impactDemonstrated],
      ['evidence is outside declared scope', input.withinScope],
      ['unsafe side effects were observed', input.noUnsafeSideEffects],
      ['evidence may contain secrets', input.secretsRedacted],
      ['evidence URI is missing', evidenceUris.length > 0],
    ];
    const failedGates = gates.filter(([, passed]) => !passed).map(([message]) => message);
    const passed = gates.length - failedGates.length;
    const verified = failedGates.length === 0;
    const lifecycle: FindingLifecycle = verified
      ? 'verified'
      : input.reproduced
        ? 'reproduced'
        : 'hypothesis';
    const result: VerificationResult = {
      findingId: input.findingId,
      lifecycle,
      verified,
      confidence: Number((passed / gates.length).toFixed(3)),
      failedGates,
      evidenceUris,
      verifiedAt: this.now().toISOString(),
      verifier,
      ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 5_000) } : {}),
    };
    await this.store.writeJson('verifications', input.findingId, result);
    await this.graph.upsertNode(input.findingId, 'finding', input.findingId, {
      lifecycle,
      verified,
      confidence: result.confidence,
    });
    for (const uri of result.evidenceUris) {
      const evidenceId = `evidence-${shortHash(uri)}`;
      await this.graph.upsertNode(evidenceId, 'evidence', uri, { uri });
      await this.graph.connect(evidenceId, input.findingId, 'supports');
    }
    return result;
  }

  async get(findingId: string): Promise<VerificationResult | undefined> {
    return await this.store.readJson<VerificationResult>('verifications', findingId);
  }
}

function sanitizeAttributes(
  attributes: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes)
      .slice(0, 100)
      .map(([key, value]) => [
        key.slice(0, 100),
        typeof value === 'string' ? value.slice(0, 2_000) : value,
      ]),
  );
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
