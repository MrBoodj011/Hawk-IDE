import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  EvidencePackArtifact,
  EvidencePackFormat,
  EvidencePackReport,
  HawkHealthReport,
  SecurityFinding,
  TrafficInventory,
  TrafficRequest,
  WorkspaceRoute,
} from './protocol.js';
import { IDE_PROTOCOL_VERSION } from './protocol.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import { scanWorkspaceSecurity } from './staticAudit.js';

const STATEMENT =
  'Sanitized local evidence only. Hawk did not execute project code, contact a target, replay traffic, or retain raw credentials, headers, cookies, or request bodies.';

interface EvidenceRoute extends WorkspaceRoute {
  observed: boolean;
  requestCount: number;
}

interface PortableEvidence {
  protocolVersion: number;
  id: string;
  generatedAt: string;
  statement: string;
  summary: {
    sourceFiles: number;
    routes: number;
    observedRoutes: number;
    trafficRequests: number;
    findings: number;
  };
  routes: EvidenceRoute[];
  findings: SecurityFinding[];
  traffic: {
    source: TrafficInventory['source'] | 'none';
    hosts: string[];
    requests: TrafficRequest[];
    truncated: boolean;
  };
  organizationHealth?: HawkHealthReport;
}

export interface BuildEvidencePackOptions {
  workspaceRoot: string;
  approved: boolean;
  traffic?: TrafficInventory | null;
  hawkHealth?: HawkHealthReport | null;
  now?: Date;
}

export async function buildEvidencePack(
  options: BuildEvidencePackOptions,
): Promise<EvidencePackReport> {
  if (!options.approved) throw new Error('operator approval is required to build an evidence pack');
  const root = resolve(options.workspaceRoot);
  const created = options.now ?? new Date();
  const id = `evidence-${created.toISOString().replace(/[:.]/g, '-')}`;
  const directoryPath = `.hawk/reports/${id}`;
  const directory = join(root, '.hawk', 'reports', id);
  const [inventory, audit] = await Promise.all([
    scanWorkspaceRoutes(root),
    scanWorkspaceSecurity(root, created),
  ]);
  const requests = options.traffic?.requests.slice(0, 1_500) ?? [];
  const routes = inventory.routes.map((route) => {
    const requestCount = requests.filter((request) => requestMatchesRoute(request, route)).length;
    return { ...route, observed: requestCount > 0, requestCount };
  });
  const evidence: PortableEvidence = {
    protocolVersion: IDE_PROTOCOL_VERSION,
    id,
    generatedAt: created.toISOString(),
    statement: STATEMENT,
    summary: {
      sourceFiles: Math.max(inventory.sourceFiles, audit.sourceFiles),
      routes: routes.length,
      observedRoutes: routes.filter((route) => route.observed).length,
      trafficRequests: requests.length,
      findings: audit.findings.length,
    },
    routes,
    findings: audit.findings,
    traffic: {
      source: options.traffic?.source ?? 'none',
      hosts: options.traffic?.hosts.slice(0, 500) ?? [],
      requests,
      truncated: options.traffic?.truncated ?? false,
    },
    ...(options.hawkHealth ? { organizationHealth: options.hawkHealth } : {}),
  };
  const outputs: Array<{ format: EvidencePackFormat; name: string; content: string }> = [
    { format: 'markdown', name: 'report.md', content: renderMarkdown(evidence) },
    { format: 'html', name: 'report.html', content: renderHtml(evidence) },
    { format: 'json', name: 'evidence.json', content: `${JSON.stringify(evidence, null, 2)}\n` },
    { format: 'sarif', name: 'findings.sarif', content: renderSarif(evidence) },
  ];

  await mkdir(directory, { recursive: true });
  await Promise.all(
    outputs.map((output) => writeFile(join(directory, output.name), output.content)),
  );
  const artifacts = outputs.map((output) => artifact(directoryPath, output));
  let previousSha256 = '0'.repeat(64);
  const chainedArtifacts = artifacts.map((entry) => {
    const entrySha256 = sha256(
      JSON.stringify({
        path: entry.path,
        bytes: entry.bytes,
        sha256: entry.sha256,
        previousSha256,
      }),
    );
    const chained = { ...entry, previousSha256, entrySha256 };
    previousSha256 = entrySha256;
    return chained;
  });
  const chainRootSha256 = previousSha256;
  const manifest = {
    schemaVersion: 2,
    id,
    generatedAt: evidence.generatedAt,
    statement: STATEMENT,
    chainVersion: 1,
    chainRootSha256,
    artifacts: chainedArtifacts,
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(directory, 'manifest.json'), manifestContent, 'utf8');
  chainedArtifacts.push({
    format: 'json',
    path: `${directoryPath}/manifest.json`,
    bytes: Buffer.byteLength(manifestContent),
    sha256: sha256(manifestContent),
    previousSha256: chainRootSha256,
    entrySha256: sha256(
      JSON.stringify({
        path: `${directoryPath}/manifest.json`,
        bytes: Buffer.byteLength(manifestContent),
        sha256: sha256(manifestContent),
        previousSha256: chainRootSha256,
      }),
    ),
  });

  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    id,
    status: 'completed',
    createdAt: evidence.generatedAt,
    directoryPath,
    primaryReportPath: `${directoryPath}/report.md`,
    statement: STATEMENT,
    ...evidence.summary,
    artifacts: chainedArtifacts,
    chainVersion: 1,
    chainRootSha256,
  };
}

function artifact(
  directoryPath: string,
  output: { format: EvidencePackFormat; name: string; content: string },
): EvidencePackArtifact {
  return {
    format: output.format,
    path: `${directoryPath}/${output.name}`,
    bytes: Buffer.byteLength(output.content),
    sha256: sha256(output.content),
  };
}

function renderMarkdown(evidence: PortableEvidence): string {
  const lines = [
    '# Hawk evidence pack',
    '',
    `- Evidence ID: \`${evidence.id}\``,
    `- Generated: ${evidence.generatedAt}`,
    `- Safety: ${evidence.statement}`,
    '',
    '## Executive summary',
    '',
    `- Source files inspected: ${evidence.summary.sourceFiles}`,
    `- Routes mapped: ${evidence.summary.routes}`,
    `- Routes observed in captured traffic: ${evidence.summary.observedRoutes}`,
    `- Sanitized traffic records: ${evidence.summary.trafficRequests}`,
    `- Static signals requiring validation: ${evidence.summary.findings}`,
    '',
    '## Route evidence',
    '',
    '| Route | Source | Observed requests |',
    '| --- | --- | ---: |',
    ...evidence.routes.map(
      (route) =>
        `| ${cell(`${route.method} ${route.path}`)} | ${cell(`${route.file}:${route.line}`)} | ${route.requestCount} |`,
    ),
    '',
    '## Signals requiring manual validation',
    '',
  ];
  if (evidence.findings.length === 0) {
    lines.push('No static signals were detected by the current local rules.');
  } else {
    for (const finding of evidence.findings) {
      lines.push(
        `### ${finding.severity.toUpperCase()} · ${line(finding.title)}`,
        '',
        `- Rule: \`${line(finding.ruleId)}\``,
        `- Status: ${finding.status}; confidence: ${finding.confidence}`,
        `- Source: ${finding.source ? `\`${line(finding.source.file)}:${finding.source.line}\`` : 'not mapped'}`,
        `- Evidence: ${finding.evidence.map((item) => line(item.summary)).join('; ')}`,
        `- Remediation: ${line(finding.remediation)}`,
        '',
      );
    }
  }
  lines.push('## Runtime evidence', '');
  if (evidence.traffic.requests.length === 0) {
    lines.push('No captured request metadata was available.');
  } else {
    lines.push('| Time | Source | Request | Status |', '| --- | --- | --- | ---: |');
    for (const request of evidence.traffic.requests.slice(0, 250)) {
      lines.push(
        `| ${cell(request.startedAt)} | ${cell(request.source ?? evidence.traffic.source)} | ${cell(`${request.method} ${request.url}`)} | ${request.status ?? '—'} |`,
      );
    }
    if (evidence.traffic.requests.length > 250) {
      lines.push(
        '',
        `_Markdown view shows 250 of ${evidence.traffic.requests.length} records; evidence.json retains the bounded sanitized set._`,
      );
    }
  }
  lines.push(
    '',
    '## Validation boundary',
    '',
    'Static signals and route correlations are evidence leads, not vulnerability verdicts. Confirm authorization, identity, impact, scope, and safe reproduction before promoting a finding.',
    '',
  );
  return lines.join('\n');
}

function renderHtml(evidence: PortableEvidence): string {
  const routes = evidence.routes
    .map(
      (route) =>
        `<tr><td><code>${html(`${route.method} ${route.path}`)}</code></td><td>${html(`${route.file}:${route.line}`)}</td><td>${route.requestCount}</td></tr>`,
    )
    .join('');
  const findings =
    evidence.findings.length === 0
      ? '<p class="empty">No static signals were detected by the current local rules.</p>'
      : evidence.findings
          .map(
            (finding) =>
              `<article class="finding ${html(finding.severity)}"><div class="finding-title">${html(finding.severity.toUpperCase())} · ${html(finding.title)}</div><div class="meta">${html(finding.ruleId)} · ${html(finding.status)} · ${html(finding.source ? `${finding.source.file}:${finding.source.line}` : 'not mapped')}</div><p>${html(finding.description)}</p><p><b>Evidence</b> ${html(finding.evidence.map((item) => item.summary).join('; '))}</p><p><b>Remediation</b> ${html(finding.remediation)}</p></article>`,
          )
          .join('');
  const traffic = evidence.traffic.requests
    .slice(0, 250)
    .map(
      (request) =>
        `<tr><td>${html(request.startedAt)}</td><td>${html(request.source ?? evidence.traffic.source)}</td><td><code>${html(`${request.method} ${request.url}`)}</code></td><td>${request.status ?? '—'}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hawk evidence pack ${html(evidence.id)}</title>
<style>
:root{color-scheme:dark;--bg:#08101c;--panel:#111c2b;--line:#26354b;--text:#edf5ff;--muted:#9fb1c7;--amber:#ffb454;--cyan:#63ddf6;--red:#ff6b6b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 90% 0,#233149 0,transparent 35%),var(--bg);color:var(--text);font:14px/1.55 Inter,Segoe UI,sans-serif}.shell{max-width:1180px;margin:auto;padding:42px 24px}.brand{color:var(--amber);font-size:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}h1{font-size:40px;margin:8px 0}h2{margin-top:34px}.safety,.card,.finding{border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--panel) 92%,transparent);padding:18px}.safety{border-left:4px solid var(--cyan);color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}.metric{border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--panel)}.metric b{display:block;color:var(--amber);font-size:28px}.metric span,.meta,.empty{color:var(--muted)}table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:12px;overflow:hidden}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}code{color:var(--cyan);overflow-wrap:anywhere}.finding{margin:12px 0}.finding.high,.finding.critical{border-left:4px solid var(--red)}.finding-title{font-weight:800}.footer{margin-top:36px;color:var(--muted);font-size:12px}
</style></head><body><main class="shell"><div class="brand">Hawk / Evidence Intelligence</div><h1>Evidence pack</h1><p>${html(evidence.id)} · ${html(evidence.generatedAt)}</p><div class="safety">${html(evidence.statement)}</div>
<section class="metrics">${metricHtml(evidence.summary.sourceFiles, 'Source files')}${metricHtml(evidence.summary.routes, 'Mapped routes')}${metricHtml(evidence.summary.observedRoutes, 'Observed routes')}${metricHtml(evidence.summary.trafficRequests, 'Traffic records')}${metricHtml(evidence.summary.findings, 'Signals')}</section>
<h2>Route evidence</h2><table><thead><tr><th>Route</th><th>Source</th><th>Observed</th></tr></thead><tbody>${routes}</tbody></table>
<h2>Signals requiring manual validation</h2>${findings}
<h2>Runtime evidence</h2>${traffic ? `<table><thead><tr><th>Time</th><th>Source</th><th>Request</th><th>Status</th></tr></thead><tbody>${traffic}</tbody></table>` : '<p class="empty">No captured request metadata was available.</p>'}
<p class="footer">Static signals are not vulnerability verdicts. Validate authorization, identity, impact, scope, and safe reproduction.</p></main></body></html>`;
}

function renderSarif(evidence: PortableEvidence): string {
  const rules = [
    ...new Map(evidence.findings.map((finding) => [finding.ruleId, finding])).values(),
  ];
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Hawk Security IDE',
            informationUri: 'https://github.com/MrBoodj011/hawk',
            semanticVersion: '0.1.0',
            rules: rules.map((finding) => ({
              id: finding.ruleId,
              name: finding.title,
              shortDescription: { text: finding.description },
              help: { text: finding.remediation },
            })),
          },
        },
        automationDetails: { id: evidence.id },
        invocations: [{ executionSuccessful: true, endTimeUtc: evidence.generatedAt }],
        results: evidence.findings.map((finding) => ({
          ruleId: finding.ruleId,
          level: sarifLevel(finding.severity),
          message: {
            text: `${finding.description} Manual validation is required before treating this signal as a vulnerability.`,
          },
          ...(finding.source
            ? {
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: finding.source.file.replaceAll('\\', '/') },
                      region: { startLine: finding.source.line },
                    },
                  },
                ],
              }
            : {}),
          properties: {
            hawkFindingId: finding.id,
            hawkStatus: finding.status,
            hawkConfidence: finding.confidence,
            evidence: finding.evidence.map((item) => item.summary),
          },
        })),
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

function requestMatchesRoute(request: TrafficRequest, route: WorkspaceRoute): boolean {
  if (route.method !== 'ANY' && route.method.toUpperCase() !== request.method.toUpperCase()) {
    return false;
  }
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    pathname = request.url.split('?')[0] ?? '/';
  }
  const routeParts = route.path.split('/').filter(Boolean);
  const requestParts = pathname.split('/').filter(Boolean);
  return (
    routeParts.length === requestParts.length &&
    routeParts.every(
      (part, index) =>
        part === '*' ||
        part.startsWith(':') ||
        /^\[[^/]+\]$/.test(part) ||
        part === requestParts[index],
    )
  );
}

function sarifLevel(severity: SecurityFinding['severity']): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'note';
}

function metricHtml(value: number, label: string): string {
  return `<div class="metric"><b>${value}</b><span>${html(label)}</span></div>`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function line(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function cell(value: string): string {
  return line(value).replaceAll('|', '\\|');
}

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
