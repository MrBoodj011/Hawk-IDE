import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentFleetRegistry } from './agentFleet.js';
import { DurableStore } from './durableStore.js';
import { GovernedMemory } from './governedMemory.js';
import { type McpSignedManifest, McpTrustPlatform, signingPayload } from './mcpTrust.js';

const roots: string[] = [];
async function store(): Promise<DurableStore> {
  const root = await mkdtemp(join(tmpdir(), 'hawk-governance-'));
  roots.push(root);
  return new DurableStore(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('advanced governance', () => {
  it('authenticates fleet heartbeats and detects stale nodes', async () => {
    let now = new Date('2026-07-21T10:00:00Z');
    const fleet = new AgentFleetRegistry(await store(), () => now, 10_000);
    const registered = await fleet.register({
      approved: true,
      label: 'GPU worker',
      endpoint: 'https://worker.example.test',
      fingerprint: 'a'.repeat(64),
      capabilities: ['code', 'security'],
      platform: 'linux',
      arch: 'x64',
      maxConcurrent: 8,
    });
    await expect(
      fleet.heartbeat({
        nodeId: registered.node.id,
        token: 'wrong',
        fingerprint: 'a'.repeat(64),
        activeTasks: 0,
        cpuPercent: 2,
        memoryMbAvailable: 2048,
      }),
    ).rejects.toThrow(/token/i);
    await fleet.heartbeat({
      nodeId: registered.node.id,
      token: registered.token,
      fingerprint: 'a'.repeat(64),
      activeTasks: 2,
      cpuPercent: 40,
      memoryMbAvailable: 4096,
    });
    expect((await fleet.snapshot()).summary.availableSlots).toBe(6);
    const dispatch = await fleet.planDispatch({
      workspaceDigest: 'b'.repeat(64),
      imageDigest: 'c'.repeat(64),
      tasks: [
        {
          id: 'review-auth',
          dependsOn: [],
          requiredCapabilities: ['security'],
          preferredCapabilities: ['code'],
          priority: 10,
          estimatedSeconds: 60,
          cpu: 1,
          memoryMb: 512,
        },
      ],
    });
    expect(dispatch.assignments[0]).toMatchObject({
      taskId: 'review-auth',
      nodeId: registered.node.id,
      dispatchHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    now = new Date('2026-07-21T10:00:20Z');
    expect((await fleet.snapshot()).nodes[0]?.status).toBe('offline');
  });

  it('pins signed MCP artifacts and denies digest drift', async () => {
    const trust = new McpTrustPlatform(await store(), () => new Date('2026-07-21T10:00:00Z'));
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const manifest: McpSignedManifest = {
      schemaVersion: 1,
      name: 'hawk-safe-tool',
      version: '1.0.0',
      command: 'node',
      args: ['server.js'],
      capabilities: ['workspace.read'],
      network: 'none',
      publisher: 'Hawk Labs',
      artifactSha256: 'b'.repeat(64),
      publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    };
    manifest.signatureBase64 = sign(
      null,
      Buffer.from(signingPayload(manifest)),
      privateKey,
    ).toString('base64');
    const approved = await trust.approve(manifest, manifest.artifactSha256, 'operator', true);
    expect(approved).toMatchObject({ trusted: true, decision: 'allow', signature: 'verified' });
    const changed = await trust.inspect(
      { ...manifest, artifactSha256: 'c'.repeat(64) },
      'c'.repeat(64),
    );
    expect(changed.decision).toBe('deny');
    expect(changed.findings.join(' ')).toMatch(/changed/i);
  });

  it('invalidates provenance memory when its source digest changes', async () => {
    const memory = new GovernedMemory(await store(), () => new Date('2026-07-21T10:00:00Z'));
    const entry = await memory.write({
      layer: 'run',
      key: 'route guard',
      value: 'Admin route uses a role guard.',
      sourceUri: 'file:///server.ts',
      evidenceUris: ['hawk://evidence/E-1'],
      confidence: 0.8,
      verified: false,
      reviewer: 'agent',
      sourceDigest: 'd'.repeat(64),
      branch: 'main',
    });
    const posture = await memory.auditProvenance({
      sourceDigests: { 'file:///server.ts': 'e'.repeat(64) },
      branch: 'main',
    });
    expect(posture.stale).toBe(1);
    expect(await memory.query('route guard')).toEqual([]);
    const revoked = await memory.revoke(entry.id, 'operator', 'superseded');
    expect(revoked.validationStatus).toBe('revoked');
  });
});
