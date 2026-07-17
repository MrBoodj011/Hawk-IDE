import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanWorkspaceRoutes } from './routeScanner.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pentesterflow-ide-routes-'));
  temporaryRoots.push(root);
  return root;
}

describe('scanWorkspaceRoutes', () => {
  it('indexes Express, Fastify, and Next.js API routes without running project code', async () => {
    const root = await fixture();
    await mkdir(join(root, 'src', 'app', 'api', 'orders', '[id]'), { recursive: true });
    await mkdir(join(root, 'src', 'pages', 'api', 'users'), { recursive: true });
    await writeFile(
      join(root, 'src', 'server.ts'),
      [
        "app.get('/api/orders/:id', getOrder);",
        "router.post('/api/orders', createOrder);",
        "fastify.delete('/api/orders/:id', removeOrder);",
        "router.route('/api/health').get(status);",
      ].join('\n'),
    );
    await writeFile(
      join(root, 'src', 'app', 'api', 'orders', '[id]', 'route.ts'),
      'export async function GET() {}\nexport async function PATCH() {}\n',
    );
    await writeFile(
      join(root, 'src', 'pages', 'api', 'users', 'index.ts'),
      'export default function handler() {}\n',
    );

    const result = await scanWorkspaceRoutes(root);

    expect(result.sourceFiles).toBe(3);
    expect(result.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'GET', path: '/api/orders/:id', framework: 'express' }),
        expect.objectContaining({ method: 'POST', path: '/api/orders', framework: 'express' }),
        expect.objectContaining({
          method: 'DELETE',
          path: '/api/orders/:id',
          framework: 'fastify',
        }),
        expect.objectContaining({ method: 'GET', path: '/api/health', framework: 'express' }),
        expect.objectContaining({ method: 'GET', path: '/api/orders/:id', framework: 'next-app' }),
        expect.objectContaining({
          method: 'PATCH',
          path: '/api/orders/:id',
          framework: 'next-app',
        }),
        expect.objectContaining({ method: 'ANY', path: '/api/users', framework: 'next-pages' }),
      ]),
    );
  });
});
