import { describe, expect, it } from 'vitest';
import type { CapturedInteraction } from '../browser/store.js';
import { analyzeBehavioralSecurity, createBehavioralExperimentPlan } from './behavioralSecurity.js';
import { analyzeInteractionChaos } from './interactionChaos.js';
import type { TrafficInventory, WorkspaceInventory } from './protocol.js';

const epoch = Date.parse('2026-07-29T10:00:00.000Z');

describe('behavioral security', () => {
  it('builds every behavioral capability from captured and static evidence', () => {
    const interactions = interactionFixture();
    const traffic = trafficFixture();
    const chaos = analyzeInteractionChaos(
      interactions,
      [capturedRequest('raw-1', 150, 201), capturedRequest('raw-2', 220, 500)],
      { now: new Date(epoch + 1_000) },
    );
    const chaosSignal = chaos.signals[0];
    expect(chaosSignal).toBeDefined();
    if (chaosSignal) chaosSignal.requestIds = ['request-1', 'request-2'];
    const report = analyzeBehavioralSecurity({
      inventory: inventoryFixture(),
      traffic,
      interactions,
      interactionChaos: chaos,
      findings: [
        {
          id: 'finding-auth',
          ruleId: 'authorization-signal',
          title: 'Possible ownership validation gap',
          severity: 'high',
          status: 'suspected',
          confidence: 'signal',
          createdAt: new Date(epoch).toISOString(),
          description: 'signal',
          remediation: 'validate ownership',
          evidence: [{ kind: 'code', summary: 'route handler' }],
          source: { file: 'src/orders.ts', line: 10 },
        },
      ],
      now: new Date(epoch + 2_000),
    });

    expect(report.summary).toMatchObject({
      capabilities: 12,
      states: expect.any(Number),
      workflows: 2,
      invariantSignals: expect.any(Number),
      raceExperiments: 1,
      replays: 1,
      clientStateExperiments: 5,
      signals: expect.any(Number),
    });
    expect(report.capabilities.every((capability) => capability.status === 'ready')).toBe(true);
    expect(report.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'hawk.behavior.inconsistent-outcome' }),
        expect.objectContaining({ ruleId: 'hawk.behavior.disabled-control-activated' }),
        expect.objectContaining({ ruleId: 'hawk.behavior.non-native-button' }),
        expect.objectContaining({ ruleId: 'hawk.behavior.keyboard-double-activation' }),
      ]),
    );
    expect(report.digitalTwin).toMatchObject({
      actors: expect.arrayContaining([expect.objectContaining({ id: 'actor-admin' })]),
      learningFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(report.timeline.some((event) => event.kind === 'failure')).toBe(true);
    expect(report.mutationPlans.length).toBeGreaterThan(0);
  });

  it('creates immutable passive and active plans with strict scope budgets', () => {
    const report = analyzeBehavioralSecurity({
      inventory: inventoryFixture(),
      traffic: trafficFixture(),
      interactions: interactionFixture(),
      now: new Date(epoch),
    });
    const passive = createBehavioralExperimentPlan(report, {
      objective: 'Analyze the captured order workflow',
      mode: 'passive',
      now: new Date(epoch),
    });
    expect(passive).toMatchObject({
      networkPolicy: 'captured-only',
      maxRequests: 0,
      requiresApproval: true,
      approvalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const active = createBehavioralExperimentPlan(report, {
      objective: 'Validate the authorized order race',
      mode: 'authorized-active',
      allowedHosts: ['https://app.example.test/orders', 'APP.EXAMPLE.TEST'],
      maxConcurrency: 99,
      maxRequests: 999,
      now: new Date(epoch),
    });
    expect(active).toMatchObject({
      allowedHosts: ['app.example.test'],
      maxConcurrency: 10,
      maxRequests: 100,
      networkPolicy: 'restricted',
    });
    expect(() =>
      createBehavioralExperimentPlan(report, {
        objective: 'active test',
        mode: 'authorized-active',
      }),
    ).toThrow('allowed host');
    expect(() =>
      createBehavioralExperimentPlan(report, {
        objective: 'passive test',
        mode: 'passive',
        maxRequests: 1,
      }),
    ).toThrow('cannot generate requests');
    expect(() => createBehavioralExperimentPlan(report, { objective: ' ' })).toThrow('objective');
  });
});

function inventoryFixture(): WorkspaceInventory {
  return {
    protocolVersion: 13,
    root: '/workspace',
    indexedAt: new Date(epoch).toISOString(),
    sourceFiles: 4,
    routes: [
      {
        method: 'POST',
        path: '/api/orders',
        file: 'src/orders.ts',
        line: 10,
        framework: 'express',
      },
      {
        method: 'POST',
        path: '/admin/coupons',
        file: 'src/admin.ts',
        line: 20,
        framework: 'express',
      },
    ],
  };
}

function trafficFixture(): TrafficInventory {
  return {
    protocolVersion: 13,
    importedAt: new Date(epoch).toISOString(),
    source: 'live',
    hosts: ['app.example.test'],
    truncated: false,
    live: true,
    requests: [
      {
        id: 'request-1',
        method: 'POST',
        url: 'https://app.example.test/api/orders',
        host: 'app.example.test',
        status: 201,
        startedAt: new Date(epoch + 150).toISOString(),
        source: 'browser',
      },
      {
        id: 'request-2',
        method: 'POST',
        url: 'https://app.example.test/api/orders',
        host: 'app.example.test',
        status: 500,
        startedAt: new Date(epoch + 220).toISOString(),
        source: 'browser',
      },
    ],
  };
}

function interactionFixture(): CapturedInteraction[] {
  return [
    interaction('i-1', 0, '/orders', 0, false, 'div'),
    interaction('i-2', 100, '/orders', 0, false, 'div'),
    interaction('i-3', 180, '/orders', 1, true, 'button'),
  ];
}

function interaction(
  id: string,
  offset: number,
  path: string,
  detail: number,
  disabled: boolean,
  tag: string,
): CapturedInteraction {
  return {
    id,
    kind: 'click',
    url: `https://app.example.test${path}`,
    tabId: 7,
    occurredAt: epoch + offset,
    receivedAt: epoch + offset,
    trusted: true,
    detail,
    target: {
      fingerprint: 'main > div[role="button"]',
      tag,
      role: tag === 'div' ? 'button' : undefined,
      inputType: 'button',
      disabled,
    },
  };
}

function capturedRequest(id: string, offset: number, status: number) {
  return {
    id,
    source: 'fetch' as const,
    tabId: 7,
    method: 'POST',
    url: 'https://app.example.test/api/orders',
    initiator: 'https://app.example.test/orders',
    status,
    timeStart: epoch + offset,
    receivedAt: epoch + offset,
  };
}
