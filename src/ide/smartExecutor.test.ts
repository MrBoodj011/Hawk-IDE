import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HawkDockerOrchestrator } from './orchestrator.js';
import type { SmartMcpBrain } from './smartBrain.js';
import { createCoreCapabilityExecutor } from './smartExecutor.js';
import type { CapabilityExecutionContext } from './smartRunEngine.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('core capability executor', () => {
  it('creates a passive workspace snapshot and applies Sentinel redaction', async () => {
    const root = await fixture();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'server.ts'), "app.get('/api/users/:id', getUser);\n");
    const inspectResult = vi.fn((output: unknown) => ({
      safe: true,
      redacted: { protected: true, original: output },
      findings: [],
    }));
    const execute = createCoreCapabilityExecutor(root, orchestrator(), () => brain(inspectResult));

    const result = await execute(context('context.workspace.snapshot'));

    expect(result.summary).toContain('workspace context snapshot');
    expect(result.output).toEqual(
      expect.objectContaining({
        protected: true,
        original: expect.objectContaining({ sourceFiles: 1, routes: 1 }),
      }),
    );
    expect(inspectResult).toHaveBeenCalledOnce();
  });

  it('correlates imported HTTP traffic with source routes without replaying it', async () => {
    const root = await fixture();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.hawk'), { recursive: true });
    await writeFile(join(root, 'src', 'server.ts'), "app.get('/api/users/:id', getUser);\n");
    await writeFile(
      join(root, '.hawk', 'traffic.json'),
      JSON.stringify({
        protocolVersion: 1,
        importedAt: '2026-07-28T00:00:00.000Z',
        hosts: ['localhost'],
        requests: [
          {
            id: 'request-1',
            method: 'GET',
            url: 'http://localhost/api/users/42',
            headers: {},
          },
        ],
      }),
    );
    const execute = createCoreCapabilityExecutor(root, orchestrator(), () => brain());

    const result = await execute(context('traffic.source.correlate'));

    expect(result.output).toEqual(
      expect.objectContaining({
        replayedRequests: 0,
        unmatchedRequests: 0,
        correlations: [
          expect.objectContaining({
            requestId: 'request-1',
            route: '/api/users/:id',
            sourceFile: 'src/server.ts',
          }),
        ],
      }),
    );
  });

  it('enforces Docker network allowlists before dispatch', async () => {
    const start = vi.fn();
    const execute = createCoreCapabilityExecutor(await fixture(), orchestrator({ start }), () =>
      brain(),
    );

    await expect(
      execute(
        context('runtime.authorized.validate', {
          image: 'hawk-worker:test',
          command: ['node', 'validate.js'],
          network_mode: 'restricted',
        }),
      ),
    ).rejects.toThrow(/egress_allowed_hosts/);
    expect(start).not.toHaveBeenCalled();
  });

  it('returns bounded artifacts from a successful isolated Docker capability', async () => {
    const start = vi.fn(async () => ({ id: 'run-1' }));
    const get = vi.fn(() => ({
      id: 'run-1',
      status: 'succeeded',
      tasks: [
        {
          artifactDirectory: '.hawk/runs/run-1',
          exitCode: 0,
          output: 'verified',
          outputTruncated: false,
        },
      ],
    }));
    const execute = createCoreCapabilityExecutor(
      await fixture(),
      orchestrator({ start, get }),
      () => brain(),
    );

    const result = await execute(
      context('patch.regression.validate', {
        image: 'hawk-worker:test',
        command: ['npm', 'test'],
        timeout_seconds: 20,
      }),
    );

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ networkMode: 'none', approvedExternalAccess: false }),
    );
    expect(result.output).toEqual(
      expect.objectContaining({
        orchestrationRunId: 'run-1',
        status: 'succeeded',
        exitCode: 0,
        output: 'verified',
      }),
    );
  });

  it('blocks unsafe Sentinel output and unknown capabilities', async () => {
    const unsafeBrain = brain(() => ({
      safe: false,
      redacted: {},
      findings: [{ message: 'secret-shaped output' }],
    }));
    const execute = createCoreCapabilityExecutor(
      await fixture(),
      orchestrator(),
      () => unsafeBrain,
    );
    await expect(execute(context('evidence.independent.verify'))).rejects.toThrow(
      /blocked by MCP Sentinel/,
    );

    const normal = createCoreCapabilityExecutor(await fixture(), orchestrator(), () => brain());
    await expect(normal(context('unknown.capability'))).rejects.toThrow(/No executor/);
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hawk-smart-executor-'));
  roots.push(root);
  return root;
}

function context(capabilityId: string, input: unknown = {}): CapabilityExecutionContext {
  return {
    node: {
      id: `node-${capabilityId}`,
      title: capabilityId,
      capabilityId,
      status: 'running',
      dependsOn: [],
      attempt: 1,
    },
    input,
    signal: new AbortController().signal,
  } as CapabilityExecutionContext;
}

function brain(
  inspectResult: (output: unknown) => {
    safe: boolean;
    redacted: unknown;
    findings: Array<{ message: string }>;
  } = (output) => ({ safe: true, redacted: output, findings: [] }),
): SmartMcpBrain {
  return {
    sentinel: { inspectResult },
  } as unknown as SmartMcpBrain;
}

function orchestrator(
  overrides: {
    start?: ReturnType<typeof vi.fn>;
    get?: ReturnType<typeof vi.fn>;
    cancel?: ReturnType<typeof vi.fn>;
  } = {},
): HawkDockerOrchestrator {
  return {
    start: overrides.start ?? vi.fn(),
    get: overrides.get ?? vi.fn(),
    cancel: overrides.cancel ?? vi.fn(),
  } as unknown as HawkDockerOrchestrator;
}
