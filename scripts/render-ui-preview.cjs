const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const previewDirectory = path.join(root, '.tmp', 'hawk-ui-preview');
const rendererPath = path.join(previewDirectory, 'renderer.cjs');
fs.mkdirSync(previewDirectory, { recursive: true });

buildSync({
  entryPoints: [path.join(root, 'extensions', 'pentesterflow-ide', 'src', 'missionControlHtml.ts')],
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
  cspSource: 'http://127.0.0.1:4175',
  asWebviewUri: () => 'http://127.0.0.1:4175/hawk-ui-preview/hawk-mark.svg',
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
  findings: [
    {
      severity: 'high',
      title: 'Authorization decision can be bypassed',
      source: { file: 'src/api/users.ts', line: 141 },
    },
    {
      severity: 'medium',
      title: 'Webhook signature uses non-constant comparison',
      source: { file: 'src/api/billing.ts', line: 79 },
    },
    {
      severity: 'low',
      title: 'Verbose error metadata reaches client',
      source: { file: 'src/api/reports.ts', line: 46 },
    },
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
  path.join(root, 'extensions', 'pentesterflow-ide', 'resources', 'hawk-mark.svg'),
  path.join(previewDirectory, 'hawk-mark.svg'),
);
fs.writeFileSync(path.join(previewDirectory, 'index.html'), html);
console.log(path.join(previewDirectory, 'index.html'));
