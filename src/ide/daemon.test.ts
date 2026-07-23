import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startIdeDaemon } from './daemon.js';
import type {
  OrchestrationSnapshot,
  OrchestrationSpec,
  OrchestrationTaskSnapshot,
} from './orchestrator.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('startIdeDaemon', () => {
  it('keeps the local API token-gated and returns a route inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-ide-daemon-'));
    temporaryRoots.push(root);
    await writeFile(join(root, 'server.ts'), "app.get('/api/profile', handler);\n");
    const daemon = await startIdeDaemon({
      workspaceRoot: root,
      token: 'test-token',
      reproductionOrchestrator: new SuccessfulReproductionOrchestrator(root),
    });
    try {
      const blocked = await fetch(`${daemon.url}/v1/health`);
      expect(blocked.status).toBe(401);

      const headers = { 'X-Hawk-Token': daemon.token };
      const health = await fetch(`${daemon.url}/v1/health`, { headers });
      expect(health.status).toBe(200);
      expect(health.headers.get('cache-control')).toBe('no-store');
      expect(health.headers.get('x-content-type-options')).toBe('nosniff');
      expect(health.headers.get('x-hawk-trace-id')).toMatch(/^trace-/);
      expect(await health.json()).toMatchObject({ ok: true, protocolVersion: 13 });

      const metrics = await fetch(`${daemon.url}/v1/diagnostics/metrics`, { headers });
      expect(metrics.status).toBe(200);
      await expect(metrics.json()).resolves.toMatchObject({
        schemaVersion: 1,
        totals: {
          requests: expect.any(Number),
          active: expect.any(Number),
        },
        routes: expect.arrayContaining([
          expect.objectContaining({
            method: 'GET',
            route: '/v1/health',
            requests: expect.any(Number),
          }),
        ]),
      });

      const blockedBundle = await fetch(`${daemon.url}/v1/diagnostics/bundle`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: false }),
      });
      expect(blockedBundle.status).toBe(400);
      const bundle = await fetch(`${daemon.url}/v1/diagnostics/bundle`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      expect(bundle.status).toBe(201);
      await expect(bundle.json()).resolves.toMatchObject({
        schemaVersion: 1,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bytes: expect.any(Number),
      });

      const predictionEvaluation = await fetch(`${daemon.url}/v1/ai/edit-prediction/evaluation`, {
        headers,
      });
      expect(predictionEvaluation.status).toBe(200);
      await expect(predictionEvaluation.json()).resolves.toMatchObject({
        cache: { enabled: true, requests: 0 },
        totals: { generations: 0, feedbackSamples: 0 },
        models: [],
      });

      const indexed = await fetch(`${daemon.url}/v1/workspace/index`, { method: 'POST', headers });
      expect(indexed.status).toBe(200);
      await expect(indexed.json()).resolves.toMatchObject({
        sourceFiles: 1,
        routes: [expect.objectContaining({ method: 'GET', path: '/api/profile' })],
      });

      await writeFile(join(root, 'risky.ts'), 'eval(untrustedInput);\n');
      const audit = await fetch(`${daemon.url}/v1/audit/static`, { method: 'POST', headers });
      expect(audit.status).toBe(200);
      const audited = (await audit.json()) as { findings: Array<{ id: string; ruleId: string }> };
      expect(audited.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'dynamic-code-execution' })]),
      );

      const finding = audited.findings.find((item) => item.ruleId === 'dynamic-code-execution');
      expect(finding).toBeDefined();
      const reproductionPlanResponse = await fetch(
        `${daemon.url}/v1/findings/${finding?.id}/reproduction-plan`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: 'hawk-worker:test' }),
        },
      );
      expect(reproductionPlanResponse.status).toBe(201);
      const reproductionPlan = (await reproductionPlanResponse.json()) as {
        id: string;
        planHash: string;
      };
      expect(reproductionPlan).toMatchObject({
        id: expect.stringMatching(/^repro-plan-/),
        planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const reproductionResponse = await fetch(
        `${daemon.url}/v1/findings/${finding?.id}/reproduce`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            approved: true,
            planId: reproductionPlan.id,
            planHash: reproductionPlan.planHash,
          }),
        },
      );
      expect(reproductionResponse.status).toBe(200);
      await expect(reproductionResponse.json()).resolves.toMatchObject({
        status: 'reproduced',
        lifecycle: 'reproduced',
        promotedToVerified: false,
      });
      const reproductions = await fetch(`${daemon.url}/v1/reproductions`, { headers });
      expect(reproductions.status).toBe(200);
      await expect(reproductions.json()).resolves.toMatchObject({
        reproductions: [
          expect.objectContaining({
            findingId: finding?.id,
            status: 'reproduced',
            promotedToVerified: false,
          }),
        ],
      });
      const reproducedGraph = await fetch(`${daemon.url}/v1/security/graph`, { headers });
      expect(reproducedGraph.status).toBe(200);
      await expect(reproducedGraph.json()).resolves.toMatchObject({
        summary: { reproductions: 1 },
        edges: expect.arrayContaining([
          expect.objectContaining({
            relation: 'reproduces-signal',
            attributes: expect.objectContaining({ verified: false }),
          }),
        ]),
      });
      await writeFile(join(root, 'risky.ts'), 'const safe = true;\n');
      const retest = await fetch(`${daemon.url}/v1/findings/${finding?.id}/retest`, {
        method: 'POST',
        headers,
      });
      expect(retest.status).toBe(200);
      await expect(retest.json()).resolves.toMatchObject({
        present: false,
        finding: { status: 'fixed' },
      });

      const traffic = await fetch(`${daemon.url}/v1/traffic/import/har`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          log: {
            entries: [
              {
                request: {
                  method: 'GET',
                  url: 'https://api.example.test/api/profile?token=private',
                },
                response: { status: 200 },
              },
            ],
          },
        }),
      });
      expect(traffic.status).toBe(200);
      await expect(traffic.json()).resolves.toMatchObject({
        requests: [
          expect.objectContaining({
            url: 'https://api.example.test/api/profile?token=REDACTED',
          }),
        ],
      });

      const captured = await fetch(`${daemon.captureUrl}/ingest`, {
        method: 'POST',
        headers: {
          'X-Hawk-Token': daemon.captureToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'burp',
          id: 44,
          method: 'POST',
          url: 'https://api.example.test/orders?authorization=private',
          status: 201,
          timeStart: Date.now() - 25,
          timeEnd: Date.now(),
          elapsedMs: 25,
        }),
      });
      expect(captured.status).toBe(202);
      const liveTraffic = await fetch(`${daemon.url}/v1/traffic`, { headers });
      expect(liveTraffic.status).toBe(200);
      const liveTrafficBody = (await liveTraffic.json()) as {
        source: string;
        live: boolean;
        requests: Array<{ id: string; source?: string; url: string }>;
      };
      expect(liveTrafficBody).toMatchObject({
        source: 'mixed',
        live: true,
        requests: expect.arrayContaining([
          expect.objectContaining({
            source: 'burp',
            url: 'https://api.example.test/orders?authorization=REDACTED',
          }),
        ]),
      });
      const capturedRequestId = liveTrafficBody.requests.find(
        (request) => request.source === 'burp',
      )?.id;
      const replayPlan = await fetch(`${daemon.url}/v1/traffic/replay/plan`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: capturedRequestId,
          allowedHost: 'api.example.test',
          maxRequestsPerSecond: 2,
          identities: [
            {
              id: 'owner',
              label: 'Owner',
              headers: { Authorization: 'Bearer owner-secret' },
            },
            {
              id: 'other',
              label: 'Other user',
              headers: { Authorization: 'Bearer other-secret' },
            },
          ],
        }),
      });
      expect(replayPlan.status).toBe(201);
      const replayPlanText = await replayPlan.text();
      expect(replayPlanText).toContain('"approvalHash"');
      expect(replayPlanText).not.toContain('owner-secret');
      expect(replayPlanText).not.toContain('other-secret');

      const hawk = await fetch(`${daemon.url}/v1/hawk/health/import`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization: 'example-org',
          summary: { repositories: 1, criticalSecurityAlerts: 1 },
          repositories: [
            {
              name: 'payments-api',
              securityAlerts: 1,
              securityBreakdown: { critical: 1 },
              securitySla: { total: 1 },
              sbom: { packageCount: 24, unknownLicenses: 0 },
            },
          ],
        }),
      });
      expect(hawk.status).toBe(200);
      await expect(hawk.json()).resolves.toMatchObject({
        organization: 'example-org',
        priorityQueue: [expect.objectContaining({ name: 'payments-api', level: 'critical' })],
      });
      await expect(fetch(`${daemon.url}/v1/hawk/health`, { headers })).resolves.toMatchObject({
        status: 200,
      });

      const scanTemplates = await fetch(`${daemon.url}/v1/scans/templates`, { headers });
      expect(scanTemplates.status).toBe(200);
      await expect(scanTemplates.json()).resolves.toMatchObject({
        templates: [
          expect.objectContaining({ id: 'passive-workspace' }),
          expect.objectContaining({ id: 'runtime-observe' }),
          expect.objectContaining({ id: 'release-gate' }),
        ],
      });
      const scanPlan = await fetch(`${daemon.url}/v1/scans/plan?templateId=passive-workspace`, {
        headers,
      });
      expect(scanPlan.status).toBe(200);
      const plan = (await scanPlan.json()) as {
        templateId: string;
        approvalHash: string;
        requiresApproval: boolean;
      };
      expect(plan).toMatchObject({
        templateId: 'passive-workspace',
        requiresApproval: true,
        approvalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const rejectedScan = await fetch(`${daemon.url}/v1/scans/run`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: false,
          templateId: plan.templateId,
          approvalHash: plan.approvalHash,
        }),
      });
      expect(rejectedScan.status).toBe(400);
      const completedScan = await fetch(`${daemon.url}/v1/scans/run`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: true,
          templateId: plan.templateId,
          approvalHash: plan.approvalHash,
        }),
      });
      expect(completedScan.status).toBe(200);
      await expect(completedScan.json()).resolves.toMatchObject({
        scope: 'passive-workspace',
        reportPath: expect.stringMatching(/^\.hawk\/reports\//),
      });
      const securityTemplates = await fetch(`${daemon.url}/v1/security-tests/templates`, {
        headers,
      });
      expect(securityTemplates.status).toBe(200);
      await expect(securityTemplates.json()).resolves.toMatchObject({
        templates: expect.arrayContaining([
          expect.objectContaining({ id: 'static-code', requiresApproval: true }),
          expect.objectContaining({ id: 'sandbox-signal', execution: 'sandbox-plan' }),
        ]),
      });
      const securityPlanResponse = await fetch(
        `${daemon.url}/v1/security-tests/plan?templateId=static-code`,
        { headers },
      );
      expect(securityPlanResponse.status).toBe(200);
      const securityPlan = (await securityPlanResponse.json()) as {
        templateId: string;
        approvalHash: string;
        policyHash: string;
      };
      expect(securityPlan).toMatchObject({
        templateId: 'static-code',
        approvalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        policyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const securityRun = await fetch(`${daemon.url}/v1/security-tests/run`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: true,
          templateId: securityPlan.templateId,
          approvalHash: securityPlan.approvalHash,
        }),
      });
      expect(securityRun.status).toBe(200);
      await expect(securityRun.json()).resolves.toMatchObject({
        status: 'completed',
        templateId: 'static-code',
        reportPath: expect.stringMatching(/^\.hawk\/security-tests\//),
      });
      const governance = await fetch(`${daemon.url}/v1/governance/policy`, { headers });
      expect(governance.status).toBe(200);
      await expect(governance.json()).resolves.toMatchObject({
        policy: { defaultDecision: 'require-approval' },
        policyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const registry = await fetch(`${daemon.url}/v1/mcp/registry`, { headers });
      expect(registry.status).toBe(200);
      await expect(registry.json()).resolves.toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'hawk_security_test_run', requiresApproval: true }),
        ]),
      });
      const profiles = await fetch(`${daemon.url}/v1/docker/agent-profiles`, { headers });
      expect(profiles.status).toBe(200);
      await expect(profiles.json()).resolves.toMatchObject({
        profiles: expect.arrayContaining([
          expect.objectContaining({ id: 'security-sandbox', networkMode: 'none' }),
        ]),
      });
      const evidence = await fetch(`${daemon.url}/v1/reports/evidence`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      expect(evidence.status).toBe(200);
      await expect(evidence.json()).resolves.toMatchObject({
        status: 'completed',
        primaryReportPath: expect.stringMatching(/^\.hawk\/reports\/evidence-.+\/report\.md$/),
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            format: 'sarif',
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ]),
      });
      const securityGraph = await fetch(`${daemon.url}/v1/security/graph`, { headers });
      expect(securityGraph.status).toBe(200);
      await expect(securityGraph.json()).resolves.toMatchObject({
        protocolVersion: 13,
        summary: {
          routes: 1,
          requests: expect.any(Number),
          correlatedRequests: 1,
          reproductions: 1,
        },
        nodes: expect.arrayContaining([
          expect.objectContaining({ kind: 'route' }),
          expect.objectContaining({ kind: 'request' }),
          expect.objectContaining({ kind: 'evidence' }),
        ]),
      });
      const protocols = await fetch(`${daemon.url}/v1/security/protocols`, { headers });
      expect(protocols.status).toBe(200);
      await expect(protocols.json()).resolves.toMatchObject({
        protocolVersion: 13,
        summary: { total: expect.any(Number) },
      });
      const attackTwin = await fetch(`${daemon.url}/v1/security/attack-twin`, { headers });
      expect(attackTwin.status).toBe(200);
      await expect(attackTwin.json()).resolves.toMatchObject({
        summary: { entryPoints: expect.any(Number), hypotheses: expect.any(Number) },
        statement: expect.stringMatching(/not vulnerability verdicts/i),
      });
      const autopilotPlanResponse = await fetch(`${daemon.url}/v1/security/autopilot/plan`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: 'Map the local workspace', networkPolicy: 'offline' }),
      });
      expect(autopilotPlanResponse.status).toBe(201);
      const autopilotPlan = (await autopilotPlanResponse.json()) as {
        id: string;
        planHash: string;
      };
      const autopilotRun = await fetch(`${daemon.url}/v1/security/autopilot/run`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: autopilotPlan.id,
          planHash: autopilotPlan.planHash,
          approved: true,
        }),
      });
      expect(autopilotRun.status).toBe(200);
      await expect(autopilotRun.json()).resolves.toMatchObject({
        status: 'completed-with-gates',
        stages: expect.arrayContaining([
          expect.objectContaining({ id: 'attack-twin', status: 'completed' }),
          expect.objectContaining({ id: 'reproduction-gates', status: 'awaiting-approval' }),
        ]),
      });
      const fleet = await fetch(`${daemon.url}/v1/fleet`, { headers });
      expect(fleet.status).toBe(200);
      await expect(fleet.json()).resolves.toMatchObject({ summary: { total: 0, online: 0 } });
      const trust = await fetch(`${daemon.url}/v1/mcp/trust`, { headers });
      expect(trust.status).toBe(200);
      await expect(trust.json()).resolves.toMatchObject({ pins: 0, denied: 0 });
      const memory = await fetch(`${daemon.url}/v1/memory/posture`, { headers });
      expect(memory.status).toBe(200);
      await expect(memory.json()).resolves.toMatchObject({ active: 0, stale: 0, revoked: 0 });
      const mission = await fetch(`${daemon.url}/v1/missions/plan`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objective: 'Review authentication routes and preserve evidence',
          profile: 'review',
          hosts: [],
        }),
      });
      expect(mission.status).toBe(200);
      await expect(mission.json()).resolves.toMatchObject({
        profile: 'review',
        allowedActions: ['read-workspace'],
        planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        reportPath: expect.stringMatching(/^\.hawk\/plans\/plan-.+\.md$/),
      });
    } finally {
      await daemon.close();
    }
  });
});

class SuccessfulReproductionOrchestrator {
  private snapshot: OrchestrationSnapshot | undefined;

  constructor(private readonly root: string) {}

  async start(spec: OrchestrationSpec): Promise<OrchestrationSnapshot> {
    const sourceDigest = createHash('sha256')
      .update(readFileSync(join(this.root, 'risky.ts')))
      .digest('hex');
    const tasks = (['baseline', 'control', 'reproduction'] as const).map((id) =>
      successfulTask(id, this.root, sourceDigest),
    );
    this.snapshot = {
      protocolVersion: 2,
      id: 'run-daemon-reproduction',
      status: 'succeeded',
      image: spec.image,
      workspaceRoot: this.root,
      outputRoot: join(this.root, '.hawk', 'orchestrations', 'run-daemon-reproduction'),
      maxParallel: 1,
      cpuPerWorker: 0.5,
      memoryMbPerWorker: 256,
      artifactMbPerWorker: 32,
      networkMode: 'none',
      inheritedEnv: [],
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      cancelRequested: false,
      scheduler: {
        strategy: 'latency',
        leaseSeconds: 30,
        instances: [],
        decisions: [],
      },
      summary: {
        total: 3,
        pending: 0,
        running: 0,
        succeeded: 3,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      },
      tasks,
    };
    return this.snapshot;
  }

  get(): OrchestrationSnapshot | undefined {
    return this.snapshot;
  }

  async shutdown(): Promise<void> {}
}

function successfulTask(
  id: 'baseline' | 'control' | 'reproduction',
  root: string,
  sourceDigest: string,
): OrchestrationTaskSnapshot {
  return {
    id,
    title: id,
    status: 'succeeded',
    dependsOn: id === 'baseline' ? [] : [id === 'control' ? 'baseline' : 'control'],
    attempt: 1,
    artifactDirectory: join(root, '.hawk', id),
    assignedInstanceId: 'reproduction-sandbox',
    reassignments: 0,
    durationMs: 5,
    output: JSON.stringify({
      gate: id,
      observed: true,
      digest: id === 'baseline' ? sourceDigest : 'a'.repeat(64),
    }),
  };
}
