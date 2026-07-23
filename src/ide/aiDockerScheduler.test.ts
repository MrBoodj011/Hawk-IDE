import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HawkAiDockerScheduler } from './aiDockerScheduler.js';

describe('HawkAiDockerScheduler', () => {
  it('places every AI lane and creates a hardened direct Docker launch', async () => {
    const commands: string[][] = [];
    const scheduler = new HawkAiDockerScheduler({
      daemonEntry: join(process.cwd(), 'dist', 'ide-daemon.js'),
      daemonEnvironment: {
        HAWK_IDE_BACKEND: 'ollama',
        HAWK_IDE_MODEL: 'qwen3-coder',
        HAWK_IDE_API_KEY: 'secret-not-for-command-line',
        HAWK_IDE_BASE_URL: 'http://127.0.0.1:11434',
      },
      runner: {
        exec: async (args) => {
          commands.push(args);
          if (args[0] === 'version') return { stdout: '27.1.1\n', stderr: '' };
          if (args[0] === 'image') {
            return { stdout: `sha256:${'a'.repeat(64)}\n`, stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      },
    });
    const plan = await scheduler.planBatch(
      'batch-1',
      [
        { id: 'lane-1', role: 'Architecture', capabilities: ['code', 'general'] },
        { id: 'lane-2', role: 'Implementation', capabilities: ['code'] },
        { id: 'lane-3', role: 'Verification', capabilities: ['security', 'test'] },
      ],
      {
        image: 'hawk-worker:local',
        strategy: 'latency',
        cpuPerLane: 1.5,
        memoryMbPerLane: 1536,
      },
    );

    expect(plan.dockerVersion).toBe('27.1.1');
    expect([...plan.executions.values()].map((item) => item.instanceId)).toEqual([
      'agent-01',
      'agent-02',
      'agent-03',
    ]);
    const execution = plan.executions.get('lane-1');
    expect(execution).toMatchObject({
      kind: 'docker',
      laneId: 'lane-1',
      image: 'hawk-worker:local',
      resolvedImage: `sha256:${'a'.repeat(64)}`,
      cpu: 1.5,
      memoryMb: 1536,
      networkMode: 'provider-egress',
    });
    if (!execution) throw new Error('missing placement');

    const launch = await scheduler.launch({
      id: 'lane-1',
      workerRoot: join(process.cwd(), 'worktree'),
      agentSessionPath: join(process.cwd(), 'agent', 'lane-1.json'),
      execution,
    });
    const commandLine = launch.args.join(' ');
    expect(launch.command).toBe('docker');
    expect(commandLine).toContain('--read-only');
    expect(commandLine).toContain('--cap-drop ALL');
    expect(commandLine).toContain('--security-opt no-new-privileges');
    expect(commandLine).toContain('--network bridge');
    expect(commandLine).toContain('host.docker.internal:host-gateway');
    expect(commandLine).toContain(`sha256:${'a'.repeat(64)} node /hawk-ide-daemon.js --ai-worker`);
    expect(commandLine).not.toContain('secret-not-for-command-line');
    expect(commandLine).not.toContain('docker.sock');
    expect(launch.env?.HAWK_IDE_BASE_URL).toBe('http://host.docker.internal:11434');
    expect(launch.requestWorkspaceRoot).toBe('/workspace');
    expect(launch.requestAgentSessionPath).toBe('/hawk-agent/lane-1.json');

    await launch.cancel?.();
    expect(commands).toContainEqual(['rm', '--force', 'hawk-ai-lane-1']);
  });

  it('refuses to launch a placement that is bound to another AI session', async () => {
    const scheduler = new HawkAiDockerScheduler({
      daemonEntry: join(process.cwd(), 'dist', 'ide-daemon.js'),
      runner: { exec: async () => ({ stdout: '', stderr: '' }) },
    });
    await expect(
      scheduler.launch({
        id: 'lane-2',
        workerRoot: join(process.cwd(), 'worktree'),
        agentSessionPath: join(process.cwd(), 'agent', 'lane-2.json'),
        execution: {
          kind: 'docker',
          laneId: 'lane-1',
          batchId: 'batch-1',
          image: 'hawk-worker:local',
          resolvedImage: `sha256:${'a'.repeat(64)}`,
          instanceId: 'agent-01',
          schedulingScore: 1,
          schedulingReasons: [],
          criticalPathSeconds: 600,
          cpu: 1,
          memoryMb: 1024,
          networkMode: 'none',
        },
      }),
    ).rejects.toThrow('bound to a different session');
  });

  it('refuses to start a batch when the Docker image is unavailable', async () => {
    const scheduler = new HawkAiDockerScheduler({
      daemonEntry: join(process.cwd(), 'dist', 'ide-daemon.js'),
      runner: {
        exec: async (args) => {
          if (args[0] === 'version') return { stdout: '27.1.1', stderr: '' };
          throw new Error('No such image');
        },
      },
    });
    await expect(
      scheduler.planBatch(
        'batch-1',
        [{ id: 'lane-1', role: 'Implementation', capabilities: ['code'] }],
        { image: 'missing:local' },
      ),
    ).rejects.toThrow('docker build -t missing:local docker/hawk-worker');
  });
});
