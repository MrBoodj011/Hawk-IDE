const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const previewDirectory = path.join(root, '.tmp', 'hawk-ui-preview');
const rendererPath = path.join(previewDirectory, 'renderer.cjs');
fs.mkdirSync(previewDirectory, { recursive: true });

buildSync({
  entryPoints: [path.join(root, 'extensions', 'hawk-security-ide', 'src', 'missionControlHtml.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  outfile: rendererPath,
  logLevel: 'silent',
});

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return { Uri: { joinPath: (_base, ...parts) => ({ parts }) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { renderMissionControlHtml } = require(rendererPath);
const webview = {
  cspSource: "'self'",
  asWebviewUri: () => './hawk-mark.svg',
};
let html = renderMissionControlHtml(webview, {}, 'panel');
const nonce = html.match(/script nonce="([^"]+)"/)?.[1];
if (!nonce) throw new Error('Could not find Hawk preview nonce');

html = html.replace(
  `<script nonce="${nonce}">`,
  `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({postMessage:()=>{}});</script><script nonce="${nonce}">`,
);

const state = {
  connected: true,
  message: 'Indexed 1,284 source files. Evidence graph synchronized.',
  inventory: {
    sourceFiles: 1284,
    routes: [
      {
        method: 'POST',
        path: '/api/auth/session',
        file: 'src/api/auth.ts',
        line: 48,
        framework: 'next',
      },
      {
        method: 'GET',
        path: '/api/organizations/:id',
        file: 'src/api/orgs.ts',
        line: 91,
        framework: 'next',
      },
      {
        method: 'PATCH',
        path: '/api/users/:id/roles',
        file: 'src/api/users.ts',
        line: 133,
        framework: 'next',
      },
      {
        method: 'POST',
        path: '/api/billing/webhook',
        file: 'src/api/billing.ts',
        line: 72,
        framework: 'next',
      },
      {
        method: 'GET',
        path: '/api/reports/export',
        file: 'src/api/reports.ts',
        line: 35,
        framework: 'next',
      },
    ],
  },
  traffic: {
    requests: [
      {
        method: 'POST',
        url: 'https://app.hawk.dev/api/auth/session',
        host: 'app.hawk.dev',
        status: 200,
      },
      {
        method: 'GET',
        url: 'https://app.hawk.dev/api/organizations/acme',
        host: 'app.hawk.dev',
        status: 200,
      },
      {
        method: 'PATCH',
        url: 'https://app.hawk.dev/api/users/42/roles',
        host: 'app.hawk.dev',
        status: 403,
      },
    ],
  },
  securityGraph: {
    summary: {
      nodes: 148,
      edges: 267,
      sourceFiles: 38,
      symbols: 29,
      routes: 18,
      requests: 34,
      findings: 11,
      evidence: 12,
      patches: 3,
      tests: 3,
      protocols: 8,
      infrastructure: 3,
      trustBoundaries: 4,
      correlatedRequests: 26,
      sourceLinkedFindings: 10,
      evidenceLinkedFindings: 11,
      reproductions: 1,
    },
    nodes: [
      {
        id: 'finding-authz',
        kind: 'finding',
        label: 'Authorization bypass signal',
        attributes: { file: 'src/api/users.ts', line: 141 },
      },
      {
        id: 'evidence-authz',
        kind: 'evidence',
        label: 'Role check evidence',
        attributes: { file: 'src/api/users.ts', line: 141 },
      },
      {
        id: 'request-authz',
        kind: 'request',
        label: 'PATCH /api/users/42/roles',
        attributes: {},
      },
      {
        id: 'route-authz',
        kind: 'route',
        label: 'PATCH /api/users/:id/roles',
        attributes: {
          file: 'src/api/users.ts',
          line: 133,
          path: '/api/users/:id/roles',
        },
      },
      {
        id: 'symbol-authz',
        kind: 'symbol',
        label: 'PATCH role handler',
        attributes: { file: 'src/api/users.ts', line: 133 },
      },
    ],
    edges: [
      {
        id: 'edge-evidence-finding',
        from: 'evidence-authz',
        to: 'finding-authz',
        relation: 'reproduces-signal',
        attributes: { confidence: 0.9, verified: false },
      },
      {
        id: 'edge-request-finding',
        from: 'request-authz',
        to: 'finding-authz',
        relation: 'runtime-context-for',
        attributes: { confidence: 0.95 },
      },
      {
        id: 'edge-route-finding',
        from: 'route-authz',
        to: 'finding-authz',
        relation: 'source-context-for',
        attributes: { confidence: 0.98 },
      },
      {
        id: 'edge-symbol-route',
        from: 'symbol-authz',
        to: 'route-authz',
        relation: 'handles',
        attributes: { confidence: 1 },
      },
    ],
    truncated: false,
  },
  findings: [
    {
      id: 'finding-authz',
      ruleId: 'dynamic-code-execution',
      severity: 'high',
      status: 'suspected',
      title: 'Authorization decision can be bypassed',
      source: { file: 'src/api/users.ts', line: 141 },
    },
    {
      id: 'finding-webhook',
      ruleId: 'tls-verification-disabled',
      severity: 'medium',
      status: 'suspected',
      title: 'Webhook signature uses non-constant comparison',
      source: { file: 'src/api/billing.ts', line: 79 },
    },
    {
      id: 'finding-errors',
      ruleId: 'wildcard-cors-credentials',
      severity: 'low',
      status: 'suspected',
      title: 'Verbose error metadata reaches client',
      source: { file: 'src/api/reports.ts', line: 46 },
    },
  ],
  reproductions: [
    {
      id: 'reproduction-authz',
      findingId: 'finding-authz',
      ruleId: 'dynamic-code-execution',
      status: 'reproduced',
      lifecycle: 'reproduced',
      promotedToVerified: false,
      completedAt: '2026-07-20T16:10:00.000Z',
      gates: [
        { id: 'baseline', status: 'passed' },
        { id: 'control', status: 'passed' },
        { id: 'reproduction', status: 'passed' },
      ],
    },
  ],
  protocols: {
    summary: {
      total: 12,
      public: 3,
      authenticated: 5,
      infrastructure: 3,
      byKind: {
        graphql: 3,
        websocket: 1,
        openapi: 1,
        'oauth-oidc': 2,
        kubernetes: 2,
        terraform: 1,
        'cloud-iam': 1,
        'mobile-api': 1,
      },
    },
  },
  attackTwin: {
    summary: {
      entryPoints: 30,
      protocolSurfaces: 12,
      trustBoundaries: 4,
      hypotheses: 7,
      reproducedPaths: 2,
      verifiedPaths: 1,
      highestScore: 91,
    },
    paths: [
      {
        title: 'PATCH /api/users/:id/roles -> authorization bypass signal',
        score: 91,
        status: 'reproduced',
        protocol: 'http-route',
        sourceFiles: ['src/api/users.ts'],
      },
      {
        title: 'GraphQL Mutation -> tenant boundary hypothesis',
        score: 78,
        status: 'hypothesis',
        protocol: 'graphql',
        sourceFiles: ['src/graphql/mutations.ts'],
      },
      {
        title: 'OAuth callback -> identity trust boundary',
        score: 69,
        status: 'verified',
        protocol: 'oauth-oidc',
        sourceFiles: ['src/auth/oidc.ts'],
      },
      {
        title: 'Kubernetes Ingress -> billing webhook',
        score: 64,
        status: 'hypothesis',
        protocol: 'kubernetes',
        sourceFiles: ['deploy/api-ingress.yaml'],
      },
    ],
  },
  fleet: { summary: { online: 6, availableSlots: 18 } },
  mcpTrust: { pins: 9, verdicts: 12, allowed: 9, denied: 0 },
  memory: { active: 42, stale: 2, revoked: 3 },
  autopilotRuns: [
    { status: 'completed-with-gates', summary: { attackPaths: 10, reproductionGates: 3 } },
  ],
  hawkHealth: {
    organization: 'Hawk Labs',
    summary: {
      repositories: 18,
      governanceScore: 91,
      overdueSecurityAlerts: 2,
      sbomRepositories: 16,
    },
    priorityQueue: [
      {
        name: 'hawk-cloud',
        level: 'high',
        score: 87,
        reasons: ['2 overdue security alerts', 'SBOM drift'],
      },
      {
        name: 'hawk-agent',
        level: 'moderate',
        score: 62,
        reasons: ['Dependency freshness below target'],
      },
    ],
  },
};
html = html.replace(
  '</body>',
  `<script nonce="${nonce}">window.dispatchEvent(new MessageEvent("message",{data:{type:"state",state:${JSON.stringify(state)}}}));</script></body>`,
);

fs.copyFileSync(
  path.join(root, 'extensions', 'hawk-security-ide', 'resources', 'hawk-mark.svg'),
  path.join(previewDirectory, 'hawk-mark.svg'),
);
fs.writeFileSync(path.join(previewDirectory, 'index.html'), html);
console.log(path.join(previewDirectory, 'index.html'));
