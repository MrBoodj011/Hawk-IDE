import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGovernedMission } from './governedMission.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('governed mission planning', () => {
  it('persists an immutable review plan without executing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-mission-'));
    roots.push(root);
    const mission = await createGovernedMission({
      workspaceRoot: root,
      objective: 'Review authentication routes and build evidence',
      profile: 'review',
      now: new Date('2026-07-18T11:00:00.000Z'),
    });
    expect(mission).toMatchObject({
      profile: 'review',
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      allowedActions: ['read-workspace'],
      hosts: [],
    });
    expect(mission.nodes.length).toBeGreaterThan(3);
    const report = await readFile(join(root, ...mission.reportPath.split('/')), 'utf8');
    expect(report).toContain('This file is a plan, not an approval');
    await expect(
      readFile(join(root, '.hawk', 'brain', 'plans', `${mission.id}.json`), 'utf8'),
    ).resolves.toContain(mission.planHash);
  });

  it('requires an explicit host for an authorized live-validation plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-mission-live-'));
    roots.push(root);
    const denied = await createGovernedMission({
      workspaceRoot: root,
      objective: 'Validate the authentication boundary against the live runtime',
      profile: 'authorized-validation',
    });
    expect(denied.decision).toBe('deny');
    expect(denied.reasons.join(' ')).toContain('in-scope host');

    const scoped = await createGovernedMission({
      workspaceRoot: root,
      objective: 'Validate the authentication boundary against the live runtime',
      profile: 'authorized-validation',
      hosts: ['https://app.example.test/login'],
    });
    expect(scoped).toMatchObject({
      decision: 'require-approval',
      hosts: ['app.example.test'],
      approvalRequired: true,
    });
  });
});
