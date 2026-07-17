import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  HawkHealthReport,
  TrafficInventory,
  WorkspaceScanPlan,
  WorkspaceScanReport,
} from './protocol.js';
import { IDE_PROTOCOL_VERSION } from './protocol.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import { scanWorkspaceSecurity } from './staticAudit.js';

const PASSIVE_SCOPE = 'passive-workspace' as const;
const STATEMENT =
  'Passive workspace-only analysis. Hawk reads source text and locally imported metadata; it does not start project code, call a network target, or attempt exploitation.';

export function createWorkspaceScanPlan(
  workspaceRoot: string,
  now = new Date(),
): WorkspaceScanPlan {
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    createdAt: now.toISOString(),
    scope: PASSIVE_SCOPE,
    workspaceRoot: resolve(workspaceRoot),
    requiresApproval: true,
    statement: STATEMENT,
    checks: [
      'Map statically declared API routes.',
      'Run passive source-code security rules.',
      'Correlate already-imported HAR metadata without replaying requests.',
      'Summarize already-imported Hawk health metadata without contacting GitHub.',
      'Write a local Markdown report under .hawk/reports/.',
    ],
  };
}

export interface ApprovedWorkspaceScanOptions {
  workspaceRoot: string;
  approved: boolean;
  scope: string;
  traffic?: TrafficInventory | null;
  hawkHealth?: HawkHealthReport | null;
  now?: Date;
}

export async function runApprovedWorkspaceScan(
  options: ApprovedWorkspaceScanOptions,
): Promise<WorkspaceScanReport> {
  if (options.scope !== PASSIVE_SCOPE) throw new Error('unsupported scan scope');
  if (!options.approved) throw new Error('operator approval is required for a workspace scan');

  const root = resolve(options.workspaceRoot);
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
    scope: PASSIVE_SCOPE,
    createdAt: started.toISOString(),
    completedAt: completed.toISOString(),
    reportPath,
    sourceFiles: Math.max(routes.sourceFiles, audit.sourceFiles),
    routes: routes.routes.length,
    findings: audit.findings,
    trafficRequests: options.traffic?.requests.length ?? 0,
    hawkOrganization: options.hawkHealth?.organization,
    statement: STATEMENT,
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
    `- Scope: ${report.scope}`,
    `- Safety statement: ${report.statement}`,
    '',
    '## Surface summary',
    '',
    `- Source files inspected: ${report.sourceFiles}`,
    `- Statically mapped API routes: ${report.routes}`,
    `- Local HAR requests available for correlation: ${report.trafficRequests}`,
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
