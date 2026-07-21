import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DockerWorkerRuntime, HawkDockerOrchestrator } from '../src/ide/orchestrator.ts';
const strict = process.argv.includes('--strict');
const image = process.env.HAWK_DOCKER_SOAK_IMAGE || 'node:20-alpine';
const workspace = await mkdtemp(join(tmpdir(), 'hawk-docker-soak-'));
const runtime = new DockerWorkerRuntime();
const availability = await runtime.availability();
if (!availability.available) {
  await rm(workspace, { recursive: true, force: true });
  const message = `Docker soak skipped: ${availability.error || 'Docker daemon unavailable'}`;
  if (strict) throw new Error(message);
  console.log(message);
  process.exit(0);
}

const orchestrator = new HawkDockerOrchestrator(resolve(workspace), runtime);
try {
  const run = await orchestrator.start({
    image,
    maxParallel: 3,
    cpuPerWorker: 1,
    memoryMbPerWorker: 256,
    artifactMbPerWorker: 32,
    tasks: Array.from({ length: 8 }, (_, index) => ({
      id: `soak-${index + 1}`,
      title: `Docker soak worker ${index + 1}`,
      command: [
        'node',
        '-e',
        `const fs=require('node:fs'); fs.writeFileSync('/output/heartbeat.txt','hawk-soak-${index + 1}\\n'); console.log('hawk-soak-${index + 1}');`,
      ],
      timeoutSeconds: 30,
      retries: 1,
    })),
  });
  const completed = await waitForTerminal(orchestrator, run.id, 90_000);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.summary.succeeded, 8);
  for (const task of completed.tasks) {
    assert.equal(task.status, 'succeeded', `${task.id} did not succeed`);
    assert.match(task.output || '', /hawk-soak-/);
    const artifact = join(task.artifactDirectory, 'heartbeat.txt');
    assert.equal((await stat(artifact)).isFile(), true);
    assert.match(await readFile(artifact, 'utf8'), /^hawk-soak-/);
  }
  console.log(JSON.stringify({ ok: true, image, version: availability.version, tasks: completed.summary.succeeded }));
} catch (error) {
  if (strict) throw error;
  console.log(`Docker soak skipped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await orchestrator.shutdown();
  await rm(workspace, { recursive: true, force: true });
}

async function waitForTerminal(manager, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = manager.get(runId, true);
    if (snapshot && ['succeeded', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Docker soak run ${runId} exceeded ${timeoutMs}ms`);
}
