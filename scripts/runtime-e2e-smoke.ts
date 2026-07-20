import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface DaemonDescriptor {
  protocolVersion: number;
  url: string;
  token: string;
}

const extensionDist = resolve('extensions', 'hawk-security-ide', 'dist');
const daemonEntry = join(extensionDist, 'ide-daemon.cjs');
const mcpEntry = join(extensionDist, 'ide-mcp.cjs');
const extensionEntry = join(extensionDist, 'extension.js');
for (const artifact of [daemonEntry, mcpEntry, extensionEntry]) {
  if (!existsSync(artifact)) throw new Error(`Runtime E2E artifact is missing: ${artifact}`);
}

const workspace = await mkdtemp(join(tmpdir(), 'hawk-runtime-e2e-'));
let daemon: ChildProcessWithoutNullStreams | undefined;
let client: Client | undefined;
try {
  await writeFile(
    join(workspace, 'server.ts'),
    "import express from 'express';\nconst app = express();\napp.get('/api/health', handler);\n",
    'utf8',
  );
  daemon = spawn(process.execPath, [daemonEntry, '--workspace', workspace], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const descriptor = await daemonDescriptor(daemon);
  const headers = { 'X-Hawk-Token': descriptor.token };
  const health = await fetch(`${descriptor.url}/v1/health`, { headers });
  assert(health.status === 200, `daemon health failed with ${health.status}`);
  assert(
    health.headers.get('x-hawk-trace-id')?.startsWith('trace-') === true,
    'daemon did not return a trace id',
  );

  const inventory = await fetch(`${descriptor.url}/v1/workspace/index`, {
    method: 'POST',
    headers,
  });
  const inventoryBody = (await inventory.json()) as {
    routes?: Array<{ method?: string; path?: string }>;
  };
  assert(
    inventoryBody.routes?.some(
      (route) => route.method === 'GET' && route.path === '/api/health',
    ) === true,
    'embedded daemon did not index the fixture route',
  );
  const metrics = await fetch(`${descriptor.url}/v1/diagnostics/metrics`, { headers });
  const metricsBody = (await metrics.json()) as { totals?: { requests?: number } };
  assert((metricsBody.totals?.requests ?? 0) >= 2, 'daemon metrics did not observe requests');
  const bundle = await fetch(`${descriptor.url}/v1/diagnostics/bundle`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved: true }),
  });
  const bundleBody = (await bundle.json()) as { sha256?: string; path?: string };
  assert(/^[a-f0-9]{64}$/.test(bundleBody.sha256 ?? ''), 'debug bundle digest is invalid');
  assert(Boolean(bundleBody.path && existsSync(bundleBody.path)), 'debug bundle was not written');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry, '--workspace', workspace],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  client = new Client({ name: 'hawk-runtime-e2e', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  assert(
    tools.tools.some((tool) => tool.name === 'ide_route_inventory'),
    'embedded MCP tool inventory is incomplete',
  );
  const routeResult = await client.callTool({
    name: 'ide_route_inventory',
    arguments: { path_contains: '/api/health' },
  });
  assert(routeResult.isError !== true, 'embedded MCP route inventory returned an error');
  assert(
    JSON.stringify(routeResult.content).includes('/api/health'),
    'embedded MCP did not read the same workspace route',
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      protocolVersion: descriptor.protocolVersion,
      embeddedDaemon: true,
      embeddedMcp: true,
      extensionBundle: true,
      traceId: health.headers.get('x-hawk-trace-id'),
    })}\n`,
  );
} finally {
  await client?.close().catch(() => undefined);
  if (daemon) await stopChild(daemon);
  await rm(workspace, { recursive: true, force: true });
}

async function daemonDescriptor(
  child: ChildProcessWithoutNullStreams,
): Promise<DaemonDescriptor> {
  return await new Promise<DaemonDescriptor>((resolveDescriptor, reject) => {
    const reader = createInterface({ input: child.stdout });
    const errors: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk.toString('utf8')));
    const timer = setTimeout(() => {
      reader.close();
      reject(new Error(`embedded daemon startup timed out: ${errors.join('').slice(0, 2_000)}`));
    }, 15_000);
    reader.once('line', (line) => {
      clearTimeout(timer);
      reader.close();
      try {
        const value = JSON.parse(line) as DaemonDescriptor;
        assert(value.url.startsWith('http://127.0.0.1:'), 'daemon URL is not loopback');
        assert(value.token.length >= 32, 'daemon token is too short');
        resolveDescriptor(value);
      } catch (error) {
        reject(error);
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(`embedded daemon exited during startup (${code}): ${errors.join('').slice(0, 2_000)}`),
      );
    });
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => resolveStop(), 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    if (!child.killed) child.kill();
  });
}
