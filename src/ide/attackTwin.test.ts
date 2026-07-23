import { describe, expect, it } from 'vitest';
import { buildAttackTwin } from './attackTwin.js';
import type {
  ProtocolSurfaceInventory,
  SecurityFinding,
  SecurityGraphResponse,
  WorkspaceInventory,
} from './protocol.js';

describe('Hawk Attack Twin', () => {
  it('keeps static paths hypothetical and promotes only reproduced evidence', () => {
    const inventory: WorkspaceInventory = {
      protocolVersion: 13,
      root: '/workspace',
      indexedAt: '2026-07-21T10:00:00Z',
      sourceFiles: 1,
      routes: [{ method: 'GET', path: '/admin', file: 'server.ts', line: 4, framework: 'express' }],
    };
    const protocols: ProtocolSurfaceInventory = {
      protocolVersion: 13,
      scannedAt: inventory.indexedAt,
      sourceFiles: 1,
      surfaces: [],
      summary: { total: 0, public: 0, authenticated: 0, infrastructure: 0, byKind: {} },
      truncated: false,
    };
    const finding: SecurityFinding = {
      id: 'F-1',
      ruleId: 'auth',
      title: 'Missing authorization',
      severity: 'high',
      status: 'validated',
      confidence: 'signal',
      createdAt: inventory.indexedAt,
      description: 'signal',
      remediation: 'authorize',
      evidence: [{ kind: 'code', summary: 'no guard' }],
      source: { file: 'server.ts', line: 4 },
      route: { method: 'GET', path: '/admin' },
    };
    const graph: SecurityGraphResponse = {
      protocolVersion: 13,
      updatedAt: inventory.indexedAt,
      summary: {
        nodes: 2,
        edges: 1,
        sourceFiles: 1,
        symbols: 0,
        routes: 1,
        requests: 0,
        findings: 1,
        evidence: 1,
        patches: 0,
        tests: 0,
        protocols: 0,
        infrastructure: 0,
        trustBoundaries: 0,
        reproductions: 1,
        correlatedRequests: 0,
        sourceLinkedFindings: 1,
        evidenceLinkedFindings: 1,
      },
      nodes: [
        {
          id: 'finding-node',
          kind: 'finding',
          label: finding.title,
          attributes: { findingId: finding.id },
        },
        { id: 'repro', kind: 'evidence', label: 'repro', attributes: {} },
      ],
      edges: [
        {
          id: 'e',
          from: 'repro',
          to: 'finding-node',
          relation: 'reproduces-signal',
          attributes: { verified: false },
        },
      ],
      truncated: false,
    };
    const twin = buildAttackTwin({ inventory, protocols, graph, findings: [finding] });
    expect(twin.paths[0]).toMatchObject({ status: 'reproduced', protocol: 'http-route' });
    expect(twin.summary.verifiedPaths).toBe(0);
    expect(twin.statement).toMatch(/not vulnerability verdicts/i);
  });
});
