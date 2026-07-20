import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableStore } from './durableStore.js';
import { ProofGraph } from './proofGraph.js';
import type { SandboxReproductionResult, SecurityFinding, WorkspaceInventory } from './protocol.js';
import { buildUnifiedSecurityGraph } from './securityGraph.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('buildUnifiedSecurityGraph', () => {
  it('links a source symbol, route, HTTP request, finding, and evidence with provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-security-graph-'));
    temporaryRoots.push(root);
    const inventory: WorkspaceInventory = {
      protocolVersion: 9,
      root,
      indexedAt: '2026-07-20T12:00:00.000Z',
      sourceFiles: 1,
      routes: [
        {
          method: 'GET',
          path: '/api/orders/:id',
          file: 'src/orders.ts',
          line: 14,
          framework: 'express',
        },
      ],
    };
    const finding: SecurityFinding = {
      id: 'unsafe-orders',
      ruleId: 'unsafe-orders',
      title: 'Unsafe order lookup',
      severity: 'high',
      status: 'suspected',
      confidence: 'signal',
      createdAt: '2026-07-20T12:00:00.000Z',
      description: 'A static signal requiring validation.',
      remediation: 'Validate ownership.',
      source: { file: 'src/orders.ts', line: 15 },
      route: { method: 'GET', path: '/api/orders/:id' },
      evidence: [{ kind: 'code', summary: 'Lookup uses an untrusted route parameter.' }],
    };
    const reproduction: SandboxReproductionResult = {
      protocolVersion: 10,
      id: 'reproduction-orders',
      planId: 'repro-plan-11111111-1111-4111-8111-111111111111',
      planHash: 'a'.repeat(64),
      findingId: finding.id,
      ruleId: finding.ruleId,
      status: 'reproduced',
      lifecycle: 'reproduced',
      promotedToVerified: false,
      image: 'hawk-worker:test',
      orchestrationRunId: 'run-reproduction-orders',
      startedAt: '2026-07-20T12:00:00.000Z',
      completedAt: '2026-07-20T12:00:01.000Z',
      gates: [
        {
          id: 'baseline',
          status: 'passed',
          durationMs: 5,
          message: 'Baseline identified the signal.',
        },
        {
          id: 'control',
          status: 'passed',
          durationMs: 5,
          message: 'Safe control stayed negative.',
        },
        {
          id: 'reproduction',
          status: 'passed',
          durationMs: 5,
          message: 'Signal reproduced.',
        },
      ],
      missingVerificationGates: [
        'independent reproduction',
        'identity',
        'impact',
        'scope',
        'review',
      ],
      statement: 'Offline signal reproduced. Verification gates remain mandatory.',
    };

    const response = await buildUnifiedSecurityGraph(
      new ProofGraph(new DurableStore(root), () => new Date('2026-07-20T12:00:00.000Z')),
      {
        inventory,
        findings: [finding],
        reproductions: [reproduction],
        traffic: {
          protocolVersion: 9,
          importedAt: '2026-07-20T12:00:00.000Z',
          source: 'har',
          hosts: ['localhost'],
          requests: [
            {
              id: 'req-1',
              method: 'GET',
              url: 'http://localhost/api/orders/42',
              host: 'localhost',
              status: 200,
              startedAt: '2026-07-20T12:00:00.000Z',
              source: 'har',
            },
          ],
          truncated: false,
          live: false,
        },
      },
    );

    expect(response.summary).toMatchObject({
      sourceFiles: 1,
      symbols: 1,
      routes: 1,
      requests: 1,
      findings: 1,
      evidence: 2,
      correlatedRequests: 1,
      sourceLinkedFindings: 1,
      evidenceLinkedFindings: 2,
      reproductions: 1,
    });
    expect(response.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: 'defines' }),
        expect.objectContaining({ relation: 'handles' }),
        expect.objectContaining({ relation: 'observed-at' }),
        expect.objectContaining({ relation: 'source-context-for' }),
        expect.objectContaining({ relation: 'runtime-context-for' }),
        expect.objectContaining({ relation: 'supports' }),
        expect.objectContaining({
          relation: 'reproduces-signal',
          attributes: expect.objectContaining({ verified: false }),
        }),
      ]),
    );
    expect(
      response.edges.find((edge) => edge.relation === 'runtime-context-for')?.attributes,
    ).toMatchObject({
      provenance: 'hawk-source-request-correlation',
      verdict: false,
    });
  });

  it('does not correlate requests to findings from another source file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-security-graph-isolation-'));
    temporaryRoots.push(root);
    const response = await buildUnifiedSecurityGraph(new ProofGraph(new DurableStore(root)), {
      inventory: {
        protocolVersion: 9,
        root,
        indexedAt: new Date().toISOString(),
        sourceFiles: 2,
        routes: [
          {
            method: 'GET',
            path: '/health',
            file: 'src/health.ts',
            line: 1,
            framework: 'express',
          },
        ],
      },
      findings: [
        {
          id: 'other-file-signal',
          ruleId: 'signal',
          title: 'Other file signal',
          severity: 'low',
          status: 'suspected',
          confidence: 'signal',
          createdAt: new Date().toISOString(),
          description: 'Signal',
          remediation: 'Review',
          source: { file: 'src/admin.ts', line: 1 },
          evidence: [],
        },
      ],
      traffic: {
        protocolVersion: 9,
        importedAt: new Date().toISOString(),
        source: 'live',
        hosts: ['localhost'],
        requests: [
          {
            id: 'health-request',
            method: 'GET',
            url: 'http://localhost/health',
            host: 'localhost',
            startedAt: new Date().toISOString(),
          },
        ],
        truncated: false,
        live: true,
      },
    });

    expect(response.edges.some((edge) => edge.relation === 'runtime-context-for')).toBe(false);
  });
});
