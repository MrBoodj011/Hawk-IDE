import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import fg from 'fast-glob';
import {
  IDE_PROTOCOL_VERSION,
  type ProtocolSurface,
  type ProtocolSurfaceInventory,
  type ProtocolSurfaceKind,
} from './protocol.js';

const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SURFACES = 2_000;
const SOURCE_GLOBS = [
  '**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,java,kt,kts,swift,dart,rb,php,cs,rs}',
  '**/*.{graphql,gql,proto,json,yaml,yml,tf,hcl}',
];
const IGNORED = [
  '**/.git/**',
  '**/.hawk/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/vendor/**',
];

interface DetectionRule {
  kind: ProtocolSurfaceKind;
  pattern: RegExp;
  label(match: RegExpExecArray, file: string): string;
}

const RULES: DetectionRule[] = [
  rule(
    'graphql',
    /^\s*(?:type|extend\s+type)\s+(Query|Mutation|Subscription)\b/gim,
    (m) => `GraphQL ${m[1] ?? 'operation'} surface`,
  ),
  rule(
    'graphql',
    /\b(?:ApolloServer|graphqlHTTP|buildSchema|makeExecutableSchema)\s*\(/g,
    () => 'GraphQL server',
  ),
  rule(
    'websocket',
    /\b(?:WebSocketServer|WebSocket\.Server|@WebSocketGateway|socket\.io|new\s+WebSocket)\b/g,
    () => 'WebSocket channel',
  ),
  rule('grpc', /^\s*service\s+([A-Za-z_][\w.]*)\s*\{/gim, (m) =>
    `gRPC service ${m[1] ?? ''}`.trim(),
  ),
  rule('grpc', /\b(?:grpc\.Server|ServerBuilder\.forPort|@GrpcMethod)\b/g, () => 'gRPC runtime'),
  rule('openapi', /\b(?:openapi|swagger)\s*[:=]\s*["']?3(?:\.\d+)?/gi, () => 'OpenAPI contract'),
  rule(
    'oauth-oidc',
    /\b(?:openid-configuration|openid-client|OAuth2Client|passport-oauth2|oidc-client|authorization_endpoint)\b/gi,
    () => 'OAuth/OIDC trust flow',
  ),
  rule(
    'saml',
    /\b(?:passport-saml|SAMLStrategy|samlp|entityID|AssertionConsumerService)\b/gi,
    () => 'SAML trust flow',
  ),
  rule(
    'kubernetes',
    /^\s*kind:\s*(Ingress|Gateway|Service|Deployment|StatefulSet|NetworkPolicy)\s*$/gim,
    (m) => `Kubernetes ${m[1] ?? 'resource'}`,
  ),
  rule(
    'terraform',
    /^\s*resource\s+"([^"]+)"\s+"([^"]+)"/gim,
    (m) => `Terraform ${m[1] ?? 'resource'}.${m[2] ?? 'resource'}`,
  ),
  rule(
    'cloud-iam',
    /\b(?:iam:PassRole|AssumeRole|roles\/iam\.|AWS::IAM::|google_project_iam|azurerm_role_assignment)\b/gi,
    () => 'Cloud IAM policy',
  ),
  rule(
    'mobile-api',
    /(?:@(GET|POST|PUT|PATCH|DELETE)\s*\(|\b(?:Retrofit\.Builder|Dio\s*\(|Alamofire\.request|URLSession\.shared|http\.(?:get|post)\s*\(Uri))/g,
    (m) => `Mobile API ${m[1] ?? 'client'}`,
  ),
];

export async function scanProtocolSurfaces(
  workspaceRoot: string,
  now: Date = new Date(),
): Promise<ProtocolSurfaceInventory> {
  const root = resolve(workspaceRoot);
  const files = (
    await fg(SOURCE_GLOBS, {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      unique: true,
      dot: false,
      ignore: IGNORED,
      followSymbolicLinks: false,
    })
  ).sort();
  const selected = files.slice(0, MAX_FILES);
  const surfaces: ProtocolSurface[] = [];
  for (const absolute of selected) {
    if (surfaces.length >= MAX_SURFACES) break;
    let content: string;
    try {
      const bytes = await readFile(absolute);
      if (bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0)) continue;
      content = bytes.toString('utf8');
    } catch {
      continue;
    }
    const file = relative(root, absolute).replace(/\\/g, '/');
    for (const detection of detectFile(file, content)) {
      if (surfaces.length >= MAX_SURFACES) break;
      surfaces.push(detection);
    }
  }
  const deduplicated = deduplicate(surfaces);
  const byKind: Partial<Record<ProtocolSurfaceKind, number>> = {};
  for (const surface of deduplicated) byKind[surface.kind] = (byKind[surface.kind] ?? 0) + 1;
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    scannedAt: now.toISOString(),
    sourceFiles: selected.length,
    surfaces: deduplicated,
    summary: {
      total: deduplicated.length,
      public: deduplicated.filter((surface) => surface.exposure === 'public').length,
      authenticated: deduplicated.filter((surface) => surface.exposure === 'authenticated').length,
      infrastructure: deduplicated.filter((surface) =>
        ['kubernetes', 'terraform', 'cloud-iam'].includes(surface.kind),
      ).length,
      byKind,
    },
    truncated: files.length > selected.length || surfaces.length >= MAX_SURFACES,
  };
}

export function detectFile(file: string, content: string): ProtocolSurface[] {
  const output: ProtocolSurface[] = [];
  const authSignals = detectAuthSignals(content);
  for (const detection of RULES) {
    detection.pattern.lastIndex = 0;
    let match = detection.pattern.exec(content);
    while (match !== null) {
      const line = lineAt(content, match.index);
      const evidence = lineText(content, line);
      const exposure = classifyExposure(detection.kind, content, line, authSignals);
      output.push({
        id: `surface-${hash(`${detection.kind}\u0000${file}\u0000${line}\u0000${evidence}`)}`,
        kind: detection.kind,
        label: detection.label(match, file).slice(0, 160),
        file,
        line,
        exposure,
        authSignals,
        evidence: redactEvidence(evidence),
        provenance: 'hawk-protocol-intelligence',
      });
      if (match[0].length === 0) detection.pattern.lastIndex += 1;
      match = detection.pattern.exec(content);
    }
  }
  return output.slice(0, 200);
}

function rule(
  kind: ProtocolSurfaceKind,
  pattern: RegExp,
  label: DetectionRule['label'],
): DetectionRule {
  return { kind, pattern, label };
}

function detectAuthSignals(content: string): string[] {
  const candidates: Array<[RegExp, string]> = [
    [/\b(?:authorization|bearer|jwt|authenticate|requireAuth)\b/i, 'token-auth'],
    [/\b(?:oauth|openid|oidc)\b/i, 'oauth-oidc'],
    [/\b(?:saml|assertionconsumer)\b/i, 'saml'],
    [/\b(?:mTLS|client_certificate|verify_client)\b/i, 'mtls'],
    [/\b(?:rbac|role|permission|authorize)\b/i, 'authorization'],
  ];
  return candidates.filter(([pattern]) => pattern.test(content)).map(([, label]) => label);
}

function classifyExposure(
  kind: ProtocolSurfaceKind,
  content: string,
  line: number,
  authSignals: string[],
): ProtocolSurface['exposure'] {
  const nearby = content
    .split(/\r?\n/)
    .slice(Math.max(0, line - 5), line + 4)
    .join('\n');
  if (/\b(?:internal|private|ClusterIP|localhost|127\.0\.0\.1)\b/i.test(nearby)) return 'internal';
  if (/\b(?:Ingress|LoadBalancer|0\.0\.0\.0|public|internet-facing)\b/i.test(nearby))
    return 'public';
  if (authSignals.length > 0) return 'authenticated';
  if (['openapi', 'graphql', 'websocket', 'grpc', 'mobile-api'].includes(kind)) return 'unknown';
  return 'internal';
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function lineText(content: string, line: number): string {
  return (content.split(/\r?\n/)[line - 1] ?? '').trim().slice(0, 500);
}

function redactEvidence(value: string): string {
  return value
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{28,}\b/g, '[REDACTED]')
    .replace(/((?:secret|token|password|api[_-]?key)\s*[:=]\s*)[^\s,}]+/gi, '$1[REDACTED]')
    .slice(0, 500);
}

function deduplicate(values: ProtocolSurface[]): ProtocolSurface[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.kind}\u0000${value.file}\u0000${value.line}\u0000${value.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}
