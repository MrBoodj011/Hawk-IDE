import { describe, expect, it } from 'vitest';
import {
  migrateAiSessionDocument,
  migrateOrchestrationSnapshotDocument,
  migrateOrchestrationSpecDocument,
  migrateSemanticIndexDocument,
} from './stateMigrations.js';

describe('Hawk state migrations', () => {
  it('upgrades legacy AI sessions without promoting or applying them', () => {
    const result = migrateAiSessionDocument(
      {
        id: 'session-1',
        title: 'Legacy task',
        prompt: 'Review auth',
        status: 'awaiting-review',
      },
      'session-1',
    );
    expect(result).toMatchObject({ migrated: true, fromVersion: 0, toVersion: 1 });
    expect(result.value).toMatchObject({
      version: 1,
      id: 'session-1',
      status: 'awaiting-review',
      background: false,
      autoResume: false,
      resumeCount: 0,
      checkpoints: [],
      touchedFiles: [],
      testGates: [],
      testResults: [],
    });
  });

  it('rejects future session state instead of guessing', () => {
    expect(() => migrateAiSessionDocument({ version: 99, id: 'session-1' }, 'session-1')).toThrow(
      'newer than this runtime',
    );
  });

  it('upgrades v4 semantic chunks with the v5 structural fields', () => {
    const result = migrateSemanticIndexDocument({
      version: 4,
      rootHash: 'root',
      stats: {},
      files: [
        {
          path: 'src/index.ts',
          chunks: [
            {
              id: 'chunk',
              content: 'export const value = 1;',
              symbols: ['value'],
            },
          ],
        },
      ],
    });
    expect(result).toMatchObject({ migrated: true, fromVersion: 4, toVersion: 5 });
    expect(result.value.files).toEqual([
      expect.objectContaining({
        chunks: [
          expect.objectContaining({
            symbols: ['value'],
            types: [],
            imports: [],
            calls: [],
            structural: '',
          }),
        ],
      }),
    ]);
  });

  it('migrates old Docker bridge state to no-network until re-approved', () => {
    const snapshot = migrateOrchestrationSnapshotDocument({
      protocolVersion: 2,
      id: 'run-1',
      networkMode: 'bridge',
      egressPolicy: { allowedHosts: ['example.test'] },
      tasks: [{ id: 'task', status: 'pending' }],
    });
    const spec = migrateOrchestrationSpecDocument(
      {
        image: 'hawk-worker:test',
        networkMode: 'bridge',
        inheritEnv: ['API_TOKEN'],
        approvedExternalAccess: true,
        tasks: [{ id: 'task', title: 'Task', command: ['node', '--version'] }],
      },
      snapshot.fromVersion,
    );
    expect(snapshot.value).toMatchObject({
      protocolVersion: 3,
      networkMode: 'none',
      artifactMbPerWorker: 32,
      tasks: [expect.objectContaining({ reassignments: 0, dependsOn: [] })],
    });
    expect(snapshot.value).not.toHaveProperty('egressPolicy');
    expect(spec.value).toMatchObject({
      networkMode: 'none',
      inheritEnv: [],
      approvedExternalAccess: false,
    });
    expect(spec.value).not.toHaveProperty('egressProxyToken');
  });
});
