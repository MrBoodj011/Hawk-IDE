const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const previewDirectory = path.join(root, '.tmp', 'hawk-agent-preview');
const rendererPath = path.join(previewDirectory, 'renderer.cjs');
fs.mkdirSync(previewDirectory, { recursive: true });

buildSync({
  entryPoints: [
    path.join(root, 'extensions', 'hawk-security-ide', 'src', 'agentPanelHtml.ts'),
  ],
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

const { renderAgentPanelHtml } = require(rendererPath);
const webview = {
  cspSource: 'http://127.0.0.1:4175',
  asWebviewUri: () => 'http://127.0.0.1:4175/hawk-agent-preview/hawk-mark.svg',
};
let html = renderAgentPanelHtml(webview, {}, '');
const nonce = html.match(/script nonce="([^"]+)"/)?.[1];
if (!nonce) throw new Error('Could not find Hawk agent preview nonce');

html = html.replace(
  `<script nonce="${nonce}">`,
  `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({postMessage:(message)=>window.__hawkMessages=(window.__hawkMessages||[]).concat(message)});</script><script nonce="${nonce}">`,
);
const welcomeHtml = html;

const session = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Harden organization role authorization',
  prompt: 'Review and fix authorization',
  status: 'awaiting-review',
  createdAt: new Date(Date.now() - 180000).toISOString(),
  updatedAt: new Date().toISOString(),
  provider: 'openrouter',
  model: 'anthropic/claude-sonnet',
  diff: {
    patchHash: '9f7c9f7c',
    files: 3,
    insertions: 46,
    deletions: 13,
    bytes: 4832,
    truncated: false,
  },
  testGates: [
    { id: 'npm:typecheck', label: 'Type check', command: 'npm', args: ['run', 'typecheck'] },
    { id: 'npm:test', label: 'Test suite', command: 'npm', args: ['run', 'test'] },
  ],
  testResults: [
    {
      gateId: 'npm:typecheck',
      label: 'Type check',
      status: 'passed',
      exitCode: 0,
      durationMs: 2410,
      output: 'Type check passed',
    },
  ],
  canApply: true,
  canReject: true,
  canRevert: false,
};
const events = [
  {
    id: 1,
    at: new Date().toISOString(),
    type: 'plan',
    text: 'Trace the organization route, inspect the role guard, patch the ownership check, then add regression coverage.',
  },
  {
    id: 2,
    at: new Date().toISOString(),
    type: 'tool-call',
    tool: 'GrepTool',
    text: 'Search authorization middleware and organization role checks.',
  },
  {
    id: 3,
    at: new Date().toISOString(),
    type: 'tool-result',
    tool: 'FileEditTool',
    text: 'Updated the policy guard and added a tenant-bound ownership check.',
    durationMs: 824,
  },
  {
    id: 4,
    at: new Date().toISOString(),
    type: 'assistant-text',
    text: 'I found a cross-tenant authorization gap in the role update path. The patch now binds the requested user to the active organization before evaluating role permissions, and the regression test covers the denied cross-tenant case.',
  },
  {
    id: 5,
    at: new Date().toISOString(),
    type: 'diff-ready',
    text: 'Diff ready: 3 files, +46 -13.',
  },
];
const history = [
  session,
  {
    ...session,
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Review webhook signature validation',
    status: 'applied',
    updatedAt: new Date(Date.now() - 3600000).toISOString(),
    canApply: false,
    canReject: false,
    canRevert: true,
  },
  {
    ...session,
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Fix route diagnostics',
    status: 'reverted',
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    canApply: false,
    canReject: false,
    canRevert: false,
  },
];
html = html.replace(
  '</body>',
  `<script nonce="${nonce}">
    window.dispatchEvent(new MessageEvent("message",{data:{type:"session-reset",session:${JSON.stringify(session)},events:${JSON.stringify(events)}}}));
    window.dispatchEvent(new MessageEvent("message",{data:{type:"history",items:${JSON.stringify(history)}}}));
  </script></body>`,
);

fs.copyFileSync(
  path.join(root, 'extensions', 'hawk-security-ide', 'resources', 'hawk-mark.svg'),
  path.join(previewDirectory, 'hawk-mark.svg'),
);
fs.writeFileSync(path.join(previewDirectory, 'welcome.html'), welcomeHtml);
fs.writeFileSync(path.join(previewDirectory, 'index.html'), html);
console.log(path.join(previewDirectory, 'index.html'));
