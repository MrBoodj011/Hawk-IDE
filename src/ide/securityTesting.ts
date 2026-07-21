import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import fg from 'fast-glob';
import {
  type GovernanceEvaluation,
  evaluateGovernance,
  loadGovernancePolicy,
} from './governancePolicy.js';
import type { SecurityFinding, TrafficInventory, WorkspaceRoute } from './protocol.js';
import { IDE_PROTOCOL_VERSION } from './protocol.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import { scanWorkspaceSecurity } from './staticAudit.js';

export type SecurityTestTemplateId =
  | 'static-code'
  | 'route-coverage'
  | 'dependency-manifest'
  | 'sandbox-signal';

export interface SecurityTestTemplate {
  id: SecurityTestTemplateId;
  title: string;
  description: string;
  execution: 'offline' | 'captured-only' | 'sandbox-plan';
  networkPolicy: 'offline' | 'captured-only';
  requiresApproval: true;
  rateLimit: { maxRequestsPerSecond: number; maxRequests: number };
  checks: string[];
  safety: string;
}

export interface SecurityTestPlan {
  protocolVersion: number;
  id: string;
  createdAt: string;
  templateId: SecurityTestTemplateId;
  title: string;
  workspaceRoot: string;
  scopeHosts: string[];
  execution: SecurityTestTemplate['execution'];
  networkPolicy: SecurityTestTemplate['networkPolicy'];
  rateLimit: SecurityTestTemplate['rateLimit'];
  checks: string[];
  approvalHash: string;
  policyHash: string;
  governance: GovernanceEvaluation;
  statement: string;
}

export interface SecurityTestResult {
  protocolVersion: number;
  id: string;
  planId: string;
  templateId: SecurityTestTemplateId;
  status: 'completed';
  approvalHash: string;
  policyHash: string;
  startedAt: string;
  completedAt: string;
  sourceFiles: number;
  routes: number;
  findings: SecurityFinding[];
  trafficRequests: number;
  observedRoutes: number;
  dependency?: {
    manifests: string[];
    lockfiles: string[];
    installScripts: string[];
    packageManagers: string[];
  };
  reportPath: string;
  statement: string;
}

const TEMPLATES: readonly SecurityTestTemplate[] = [
  {
    id: 'static-code',
    title: 'Static security test',
    description: 'Run Hawk passive rules against source code and return reviewable signals.',
    execution: 'offline',
    networkPolicy: 'offline',
    requiresApproval: true,
    rateLimit: { maxRequestsPerSecond: 0, maxRequests: 0 },
    checks: [
      'Credential-like assignments',
      'unsafe process and filesystem sinks',
      'request-controlled URL/path flows',
    ],
    safety: 'Source text only; project code is never started and no network target is contacted.',
  },
  {
    id: 'route-coverage',
    title: 'Captured route coverage test',
    description: 'Compare captured Browser/Burp metadata with statically mapped source routes.',
    execution: 'captured-only',
    networkPolicy: 'captured-only',
    requiresApproval: true,
    rateLimit: { maxRequestsPerSecond: 0, maxRequests: 1_500 },
    checks: [
      'Route inventory',
      'observed/unobserved route coverage',
      'bounded request metadata correlation',
    ],
    safety:
      'Reads existing redacted capture data only; it does not replay, mutate, or generate requests.',
  },
  {
    id: 'dependency-manifest',
    title: 'Dependency manifest test',
    description:
      'Inspect local package manifests and lockfiles for reproducibility and unsafe scripts.',
    execution: 'offline',
    networkPolicy: 'offline',
    requiresApproval: true,
    rateLimit: { maxRequestsPerSecond: 0, maxRequests: 0 },
    checks: [
      'Manifest and lockfile presence',
      'install-script inventory',
      'package manager consistency',
    ],
    safety: 'Reads local manifest text only; it never installs packages or contacts a registry.',
  },
  {
    id: 'sandbox-signal',
    title: 'Sandbox reproduction gate',
    description:
      'Prepare a governed offline reproduction hand-off for signals requiring isolation.',
    execution: 'sandbox-plan',
    networkPolicy: 'offline',
    requiresApproval: true,
    rateLimit: { maxRequestsPerSecond: 0, maxRequests: 0 },
    checks: [
      'Static signal inventory',
      'sandbox eligibility boundary',
      'approval and evidence hand-off',
    ],
    safety:
      'This step creates a plan and evidence boundary only; use Hawk reproduction gates for execution.',
  },
] as const;

export interface CreateSecurityTestPlanOptions {
  workspaceRoot: string;
  templateId: SecurityTestTemplateId;
  scopeHosts?: string[];
  maxRequestsPerSecond?: number;
  now?: Date;
}

export async function listSecurityTestTemplates(): Promise<SecurityTestTemplate[]> {
  return TEMPLATES.map((template) => ({
    ...template,
    rateLimit: { ...template.rateLimit },
    checks: [...template.checks],
  }));
}

export async function createSecurityTestPlan(
  options: CreateSecurityTestPlanOptions,
): Promise<SecurityTestPlan> {
  const template = findTemplate(options.templateId);
  const root = resolve(options.workspaceRoot);
  const scopeHosts = [
    ...new Set((options.scopeHosts ?? []).map(normalizeHost).filter(Boolean)),
  ].slice(0, 32);
  const rate = options.maxRequestsPerSecond ?? template.rateLimit.maxRequestsPerSecond;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1_000)
    throw new Error('invalid security test rate limit');
  const policy = await loadGovernancePolicy(root);
  const governance = evaluateGovernance(policy, {
    templateId: template.id,
    hosts: scopeHosts,
    requestsPerSecond: rate,
    networkPolicy: template.networkPolicy,
    approved: false,
  });
  const createdAt = (options.now ?? new Date()).toISOString();
  const approvalHash = createHash('sha256')
    .update(JSON.stringify({ root, template, scopeHosts, rate, policyHash: governance.policyHash }))
    .digest('hex');
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    id: `security-test-plan-${approvalHash.slice(0, 16)}`,
    createdAt,
    templateId: template.id,
    title: template.title,
    workspaceRoot: root,
    scopeHosts,
    execution: template.execution,
    networkPolicy: template.networkPolicy,
    rateLimit: { maxRequestsPerSecond: rate, maxRequests: template.rateLimit.maxRequests },
    checks: [...template.checks],
    approvalHash,
    policyHash: governance.policyHash,
    governance,
    statement: template.safety,
  };
}

export interface RunSecurityTestOptions {
  workspaceRoot: string;
  plan: SecurityTestPlan;
  approvalHash: string;
  approved: boolean;
  traffic?: TrafficInventory | null;
  now?: Date;
}

export async function runApprovedSecurityTest(
  options: RunSecurityTestOptions,
): Promise<SecurityTestResult> {
  if (!options.approved) throw new Error('operator approval is required for a security test');
  const root = resolve(options.workspaceRoot);
  if (
    root !== resolve(options.plan.workspaceRoot) ||
    options.approvalHash !== options.plan.approvalHash
  ) {
    throw new Error('security test approval is missing or bound to a different plan');
  }
  const policy = await loadGovernancePolicy(root);
  const governance = evaluateGovernance(policy, {
    templateId: options.plan.templateId,
    hosts: options.plan.scopeHosts,
    requestsPerSecond: options.plan.rateLimit.maxRequestsPerSecond,
    networkPolicy: options.plan.networkPolicy,
    approved: true,
  });
  if (governance.decision === 'deny')
    throw new Error(`governance denied security test: ${governance.reasons.join('; ')}`);
  if (governance.policyHash !== options.plan.policyHash)
    throw new Error('governance policy changed; create a new plan');
  const started = options.now ?? new Date();
  const routes = await scanWorkspaceRoutes(root);
  const audit = await scanWorkspaceSecurity(root, started);
  const requests = options.traffic?.requests.slice(0, 1_500) ?? [];
  const observedRoutes = routes.routes.filter((route) =>
    requests.some((request) => matchesRoute(request.url, request.method, route)),
  ).length;
  const dependency =
    options.plan.templateId === 'dependency-manifest'
      ? await inspectDependencyManifests(root)
      : undefined;
  const id = `security-test-${started.toISOString().replace(/[:.]/g, '-')}`;
  const reportPath = `.hawk/security-tests/${id}.json`;
  const result: SecurityTestResult = {
    protocolVersion: IDE_PROTOCOL_VERSION,
    id,
    planId: options.plan.id,
    templateId: options.plan.templateId,
    status: 'completed',
    approvalHash: options.plan.approvalHash,
    policyHash: options.plan.policyHash,
    startedAt: started.toISOString(),
    completedAt: (options.now ?? new Date()).toISOString(),
    sourceFiles: Math.max(routes.sourceFiles, audit.sourceFiles),
    routes: routes.routes.length,
    findings: options.plan.templateId === 'dependency-manifest' ? [] : audit.findings,
    trafficRequests: requests.length,
    observedRoutes: options.plan.templateId === 'route-coverage' ? observedRoutes : 0,
    ...(dependency ? { dependency } : {}),
    reportPath,
    statement: options.plan.statement,
  };
  const directory = join(root, '.hawk', 'security-tests');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(root, ...reportPath.split('/')),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  return result;
}

async function inspectDependencyManifests(
  root: string,
): Promise<NonNullable<SecurityTestResult['dependency']>> {
  const files = await fg(
    [
      '**/package.json',
      '**/package-lock.json',
      '**/npm-shrinkwrap.json',
      '**/yarn.lock',
      '**/pnpm-lock.yaml',
      '**/bun.lockb',
    ],
    {
      cwd: root,
      onlyFiles: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**'],
    },
  );
  const manifests = files.filter((file) => file.endsWith('package.json'));
  const lockfiles = files.filter((file) => !manifests.includes(file));
  const installScripts: string[] = [];
  for (const manifest of manifests.slice(0, 64)) {
    try {
      const value = JSON.parse(await readFile(join(root, manifest), 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      for (const [name, command] of Object.entries(value.scripts ?? {})) {
        if (
          (name === 'preinstall' || name === 'install' || name === 'postinstall') &&
          typeof command === 'string'
        ) {
          installScripts.push(`${manifest}:${name}`);
        }
      }
    } catch {
      // Malformed manifests remain visible in the file inventory; no project code is executed.
    }
  }
  const packageManagers = new Set<string>();
  for (const file of lockfiles) {
    if (file.endsWith('package-lock.json') || file.endsWith('npm-shrinkwrap.json'))
      packageManagers.add('npm');
    else if (file.endsWith('yarn.lock')) packageManagers.add('yarn');
    else if (file.endsWith('pnpm-lock.yaml')) packageManagers.add('pnpm');
    else if (file.endsWith('bun.lockb')) packageManagers.add('bun');
  }
  return { manifests, lockfiles, installScripts, packageManagers: [...packageManagers].sort() };
}

function findTemplate(id: SecurityTestTemplateId): SecurityTestTemplate {
  const template = TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`unsupported security test template: ${id}`);
  return template;
}

function normalizeHost(value: string): string {
  const host =
    value
      .trim()
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      ?.toLowerCase() ?? '';
  if (!host) return '';
  if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(host)) {
    throw new Error(`invalid security-test scope host: ${value}`);
  }
  return host;
}

function matchesRoute(url: string, method: string, route: WorkspaceRoute): boolean {
  if (route.method !== 'ANY' && route.method.toUpperCase() !== method.toUpperCase()) return false;
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split('?')[0] ?? '/';
  }
  const left = route.path.split('/').filter(Boolean);
  const right = pathname.split('/').filter(Boolean);
  return (
    left.length === right.length &&
    left.every(
      (part, index) =>
        part === '*' || part.startsWith(':') || /^\[[^/]+\]$/.test(part) || part === right[index],
    )
  );
}
