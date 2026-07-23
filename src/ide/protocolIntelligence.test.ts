import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectFile, scanProtocolSurfaces } from './protocolIntelligence.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('protocol intelligence', () => {
  it('discovers application, identity, infrastructure and mobile surfaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawk-protocols-'));
    roots.push(root);
    await Promise.all([
      writeFile(
        join(root, 'schema.graphql'),
        'type Query { viewer: User }\ntype Mutation { pay: Boolean }\n',
      ),
      writeFile(
        join(root, 'identity.ts'),
        "import { Issuer } from 'openid-client';\nconst authorization_endpoint = issuer;\n",
      ),
      writeFile(join(root, 'main.tf'), 'resource "aws_iam_role" "api" { name = "api" }\n'),
      writeFile(join(root, 'mobile.kt'), '@GET("/v1/profile")\nsuspend fun profile(): User\n'),
    ]);
    const result = await scanProtocolSurfaces(root, new Date('2026-07-21T10:00:00Z'));
    expect(result.protocolVersion).toBe(13);
    expect(result.summary.byKind).toMatchObject({
      graphql: 2,
      'oauth-oidc': 2,
      terraform: 1,
      'mobile-api': 1,
    });
    expect(result.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'graphql', file: 'schema.graphql' }),
        expect.objectContaining({ kind: 'terraform', file: 'main.tf', exposure: 'internal' }),
      ]),
    );
  });

  it('redacts long token-like evidence', () => {
    const found = detectFile(
      'auth.ts',
      "const authorization_endpoint = 'abcdefghijklmnopqrstuvwxyz1234567890';",
    );
    expect(found[0]?.evidence).toContain('[REDACTED]');
  });
});
