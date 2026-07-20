import { type ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const children: ChildProcess[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('Hawk restricted egress proxy', () => {
  it('requires proxy authentication and enforces exact host and port scope', async () => {
    const target = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('approved target');
    });
    servers.push(target);
    const targetPort = await listen(target);
    const token = 'hawk-test-token';
    const proxy = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../docker/hawk-egress-proxy/proxy.mjs', import.meta.url))],
      {
        env: {
          ...process.env,
          HAWK_PROXY_TOKEN: token,
          HAWK_PROXY_PORT: '0',
          HAWK_ALLOWED_HOSTS: '127.0.0.1',
          HAWK_ALLOWED_PORTS: String(targetPort),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    children.push(proxy);
    const proxyPort = await readyPort(proxy);

    await expect(
      proxyRequest(proxyPort, `http://127.0.0.1:${targetPort}/health`, token),
    ).resolves.toMatchObject({ status: 200, body: 'approved target' });
    await expect(
      proxyRequest(proxyPort, `http://localhost:${targetPort}/health`, token),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      proxyRequest(proxyPort, `http://127.0.0.1:${targetPort}/health`),
    ).resolves.toMatchObject({ status: 407 });
    await expect(
      proxyRequest(proxyPort, `http://user:password@127.0.0.1:${targetPort}/health`, token),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      proxyRequest(proxyPort, `https://127.0.0.1:${targetPort}/health`, token),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      proxyRequest(proxyPort, `http://127.0.0.1:${targetPort + 1}/health`, token),
    ).resolves.toMatchObject({ status: 403 });
    await expect(proxyRequest(proxyPort, '/relative/path', token)).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      proxyRequest(proxyPort, `http://127.0.0.1:${targetPort}/health`, `${token}-suffix`),
    ).resolves.toMatchObject({ status: 407 });
    await expect(
      proxyRequest(proxyPort, `http://127.0.0.1:${targetPort}/health`, token, 'TRACE'),
    ).resolves.toMatchObject({ status: 405 });
  });

  it('does not let a wildcard match the root domain or a suffix lookalike', async () => {
    const token = 'hawk-wildcard-token';
    const proxyPort = await startProxy({
      token,
      allowedHosts: '*.example.test',
      allowedPorts: '80',
    });
    await expect(
      proxyRequest(proxyPort, 'http://example.test/health', token),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      proxyRequest(proxyPort, 'http://evil-example.test/health', token),
    ).resolves.toMatchObject({ status: 403 });
  });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Target server has no TCP address');
  return address.port;
}

async function readyPort(child: ChildProcess): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Egress proxy did not become ready')), 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const event = JSON.parse(buffer.slice(0, newline)) as { port?: number };
        if (!event.port) throw new Error('Egress proxy did not report its port');
        resolve(event.port);
      } catch (error) {
        reject(error);
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Egress proxy exited early with ${code}`)));
  });
}

async function startProxy(input: {
  token: string;
  allowedHosts: string;
  allowedPorts: string;
}): Promise<number> {
  const proxy = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../docker/hawk-egress-proxy/proxy.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        HAWK_PROXY_TOKEN: input.token,
        HAWK_PROXY_PORT: '0',
        HAWK_ALLOWED_HOSTS: input.allowedHosts,
        HAWK_ALLOWED_PORTS: input.allowedPorts,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  children.push(proxy);
  return await readyPort(proxy);
}

async function proxyRequest(
  proxyPort: number,
  target: string,
  token?: string,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        method,
        path: target,
        headers: token
          ? { 'Proxy-Authorization': `Basic ${Buffer.from(`hawk:${token}`).toString('base64')}` }
          : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.once('error', reject);
    request.end();
  });
}
