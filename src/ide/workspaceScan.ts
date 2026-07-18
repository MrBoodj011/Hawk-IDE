import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  HawkHealthReport,
  TrafficInventory,
  WorkspaceScanPlan,
  WorkspaceScanReport,
  WorkspaceScanTemplate,
  WorkspaceScanTemplateId,
} from './protocol.js';
import { IDE_PROTOCOL_VERSION } from './protocol.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import { scanWorkspaceSecurity } from './staticAudit.js';

const TEMPLATES: readonly WorkspaceScanTemplate[] = [
  {
    id: 'passive-workspace',
    title: 'Passive workspace review',
    description: 'Map code and flag static security signals without starting project code.',
    scope: 'passive-workspace',
    mode: 'passive',
    requiresApproval: true,
    networkPolicy: 'offline',
    rateLimit: { maxRequestsPerSecond: 0, maxRequests: 0 },
    checks: [
      'Map statically declared API routes.',
      'Run passive source-code security rules.',
      'Correlate already-imported traffic metadata without replaying requests.',
      'Write a local Markdown report under .hawk/reports/.',
    ],
  },
  {
    id: 'runtime-observe',
    title: 'Runtime observation',
    description:
      'Correlate live Browser/Burp evidence to source routes without generating traffic.',
    scope: 'runtime-observe',
    mode: 'observe',
    requiresApproval: true,
    networkPolicy: 'captured-only',
    rateLimit: { maxRequestsPerSecond: 0, maxRequests: 1_500 },
    checks: [
      'Read the bounded, redacted live-capture timeline.',
      'Map observed request paths back to statically declared source routes.',
      'Run passive source-code rules for correlated context.',
      'Never replay, mutate, or generate a target request.',
    ],
  },
  {
    id: 'release-gate',
    title: 'Release security gate',
    description: 'Create an offline pre-release posture snapshot from local evidence.',
    scope: 'release-gate',
    mode: 'passive',
    requiresApproval: true,
    networkPolicy: 'offline',
    rateLimit: { maxRequestsPerSecond: 0, maxRequests: 0 },
    checks: [
      'Inventory source routes and passive security signals.',
      'Summarize locally available runtime evidence.',
      'Summarize imported Hawk supply-chain health without contacting GitHub.',
      'Record a deterministic, reviewable release-gate report.',
    ],
  },
] as const;

export function createWorkspaceScanTemplates(): WorkspaceScanTemplate[] {
  return TEMPLATES.map((template) => ({
    ...template,
    rateLimit: { ...template.rateLimit },
    checks: [...template.checks],
  }));
}

export function createWorkspaceScanPlan(
  workspaceRoot: string,
  templateId: WorkspaceScanTemplateId = 'passive-workspace',
  now = new Date(),
): WorkspaceScanPlan {
  const template = findTemplate(templateId);
  const root = resolve(workspaceRoot);
  const statement = scanStatement(template);
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    createdAt: now.toISOString(),
    templateId: template.id,
    title: template.title,
    scope: template.scope,
    workspaceRoot: root,
    requiresApproval: true,
    approvalHash: planApprovalHash(root, template),
    networkPolicy: template.networkPolicy,
    rateLimit: { ...template.rateLimit },
    statement,
    checks: [...template.checks],
  };
}

export interface ApprovedWorkspaceScanOptions {
  workspaceRoot: string;
  approved: boolean;
  templateId: string;
  approvalHash: string;
  traffic?: TrafficInventory | null;
  hawkHealth?: HawkHealthReport | null;
  now?: Date;
}

export async function runApprovedWorkspaceScan(
  options: ApprovedWorkspaceScanOptions,
): Promise<WorkspaceScanReport> {
  if (!options.approved) throw new Error('operator approval is required for a workspace scan');

  const root = resolve(options.workspaceRoot);
  const template = findTemplate(options.templateId);
  const expectedApproval = planApprovalHash(root, template);
  if (options.approvalHash !== expectedApproval) {
    throw new Error('scan approval is missing or bound to a different plan');
  }
  const started = options.now ?? new Date();
  const [routes, audit] = await Promise.all([
    scanWorkspaceRoutes(root),
    scanWorkspaceSecurity(root, started),
  ]);
  const completed = options.now ?? new Date();
  const id = `workspace-${started.toISOString().replace(/[:.]/g, '-')}`;
  const reportPath = `.hawk/reports/${id}.md`;
  const report: WorkspaceScanReport = {
    protocolVersion: IDE_PROTOCOL_VERSION,
    id,
    status: 'completed',
    templateId: template.id,
    title: template.title,
    scope: template.scope,
    approvalHash: expectedApproval,
    createdAt: started.toISOString(),
    completedAt: completed.toISOString(),
    reportPath,
    sourceFiles: Math.max(routes.sourceFiles, audit.sourceFiles),
    routes: routes.routes.length,
    findings: audit.findings,
    trafficRequests: options.traffic?.requests.length ?? 0,
    hawkOrganization: options.hawkHealth?.organization,
    statement: scanStatement(template),
  };

  await writeWorkspaceReport(root, report, options.hawkHealth);
  return report;
}

async function writeWorkspaceReport(
  workspaceRoot: string,
  report: WorkspaceScanReport,
  hawkHealth?: HawkHealthReport | null,
): Promise<void> {
  const relative = report.reportPath.split('/');
  const reportFile = join(workspaceRoot, ...relative);
  await mkdir(join(workspaceRoot, '.hawk', 'reports'), { recursive: true });
  await writeFile(reportFile, renderReport(report, hawkHealth), 'utf8');
}

function renderReport(report: WorkspaceScanReport, hawkHealth?: HawkHealthReport | null): string {
  const lines = [
    '# Hawk passive workspace scan',
    '',
    `- Scan ID: \`${report.id}\``,
    `- Completed: ${report.completedAt}`,
    `- Template: ${report.title} (\`${report.templateId}\`)`,
    `- Approval hash: \`${report.approvalHash}\``,
    `- Safety statement: ${report.statement}`,
    '',
    '## Surface summary',
    '',
    `- Source files inspected: ${report.sourceFiles}`,
    `- Statically mapped API routes: ${report.routes}`,
    `- Local captured requests available for correlation: ${report.trafficRequests}`,
    `- Static signals requiring manual validation: ${report.findings.length}`,
  ];
  if (hawkHealth) {
    lines.push(
      `- Imported Hawk organization: ${hawkHealth.organization ?? 'not specified'}`,
      `- Hawk critical alerts: ${hawkHealth.summary.criticalSecurityAlerts}`,
      `- Hawk overdue security alerts: ${hawkHealth.summary.overdueSecurityAlerts}`,
    );
  }
  lines.push('', '## Signals requiring manual validation', '');
  if (report.findings.length === 0) {
    lines.push('No passive static-analysis signals were detected by the current rules.');
  } else {
    for (const finding of report.findings) {
      const location = finding.source ? ` (${finding.source.file}:${finding.source.line})` : '';
      lines.push(`- [${finding.severity.toUpperCase()}] ${finding.title}${location}`);
      lines.push(`  - ${finding.description}`);
      lines.push(`  - Remediation: ${finding.remediation}`);
    }
  }
  lines.push(
    '',
    '## Operator note',
    '',
    'This report contains passive signals only. Validate impact and authorization before treating any signal as a security finding.',
    '',
  );
  return lines.join('\n');
}

function findTemplate(id: string): WorkspaceScanTemplate {
  const template = TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) throw new Error('unsupported scan template');
  return template;
}

function planApprovalHash(root: string, template: WorkspaceScanTemplate): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        root,
        id: template.id,
        scope: template.scope,
        networkPolicy: template.networkPolicy,
        rateLimit: template.rateLimit,
        checks: template.checks,
      }),
    )
    .digest('hex');
}

function scanStatement(template: WorkspaceScanTemplate): string {
  const evidence =
    template.networkPolicy === 'captured-only'
      ? 'reads source text and bounded, locally captured metadata'
      : 'reads source text and already-imported local metadata';
  return `${template.title}: Hawk ${evidence}; it does not start project code, call a network target, replay a request, or attempt exploitation.`;
}
