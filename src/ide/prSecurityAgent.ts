import { createHash } from 'node:crypto';

export interface PullRequestSecurityFinding {
  id: string;
  ruleId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line: number;
  title: string;
  evidence: string;
  remediation: string;
}

export interface PullRequestSecurityReport {
  schemaVersion: 1;
  analyzedAt: string;
  gate: 'pass' | 'review' | 'block';
  changedFiles: string[];
  addedLines: number;
  findings: PullRequestSecurityFinding[];
  summary: { critical: number; high: number; medium: number; low: number };
  statement: string;
}

const RULES: Array<{
  id: string;
  severity: PullRequestSecurityFinding['severity'];
  pattern: RegExp;
  title: string;
  remediation: string;
}> = [
  {
    id: 'pr-hardcoded-secret',
    severity: 'critical',
    pattern: /\b(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*["'][^"']{8,}["']/i,
    title: 'Possible hardcoded secret added',
    remediation: 'Remove the value, rotate it, and use the approved secret store.',
  },
  {
    id: 'pr-private-key',
    severity: 'critical',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    title: 'Private key material added',
    remediation: 'Remove and rotate the key before merging.',
  },
  {
    id: 'pr-dynamic-execution',
    severity: 'high',
    pattern: /\b(?:eval|new\s+Function|child_process\.exec)\s*\(/,
    title: 'Dynamic code or shell execution added',
    remediation: 'Use a typed API and strict allowlists; avoid shell interpretation.',
  },
  {
    id: 'pr-auth-bypass',
    severity: 'high',
    pattern: /\b(?:disableAuth|skipAuth|verify\s*:\s*false|rejectUnauthorized\s*:\s*false)\b/i,
    title: 'Authentication or transport verification may be bypassed',
    remediation: 'Restore verification and cover the intended exception with a bounded test.',
  },
  {
    id: 'pr-permissive-cors',
    severity: 'medium',
    pattern: /(?:origin\s*:\s*["']\*["']|Access-Control-Allow-Origin[^\n]*\*)/i,
    title: 'Permissive cross-origin policy added',
    remediation: 'Restrict origins to the minimum approved set.',
  },
  {
    id: 'pr-public-cloud-policy',
    severity: 'high',
    pattern: /(?:Principal\s*["']?\s*:\s*["']\*["']|0\.0\.0\.0\/0|public-read)/i,
    title: 'Public cloud or network policy added',
    remediation: 'Narrow principals and network ranges, then document the exception.',
  },
  {
    id: 'pr-unpinned-container',
    severity: 'medium',
    pattern: /^\s*FROM\s+[^\s:@]+(?::latest)?\s*$/i,
    title: 'Unpinned container base image added',
    remediation: 'Pin the image by immutable digest.',
  },
];

export function analyzePullRequestDiff(
  diff: string,
  now: Date = new Date(),
): PullRequestSecurityReport {
  if (Buffer.byteLength(diff, 'utf8') > 10 * 1024 * 1024)
    throw new Error('PR diff exceeds the 10 MB analysis limit');
  let file = '';
  let newLine = 0;
  let addedLines = 0;
  const changedFiles = new Set<string>();
  const findings: PullRequestSecurityFinding[] = [];
  for (const raw of diff.split(/\r?\n/)) {
    const fileMatch = raw.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch?.[1]) {
      file = safePath(fileMatch[1]);
      changedFiles.add(file);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk?.[1]) {
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      addedLines += 1;
      const value = raw.slice(1);
      for (const rule of RULES) {
        if (!rule.pattern.test(value)) continue;
        const evidence = redact(value.trim()).slice(0, 300);
        findings.push({
          id: `pr-${hash(`${rule.id}\u0000${file}\u0000${newLine}\u0000${evidence}`)}`,
          ruleId: rule.id,
          severity: rule.severity,
          file: file || 'unknown',
          line: Math.max(1, newLine),
          title: rule.title,
          evidence,
          remediation: rule.remediation,
        });
      }
      newLine += 1;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      newLine += 1;
    }
  }
  const unique = deduplicate(findings);
  const summary = {
    critical: unique.filter((finding) => finding.severity === 'critical').length,
    high: unique.filter((finding) => finding.severity === 'high').length,
    medium: unique.filter((finding) => finding.severity === 'medium').length,
    low: unique.filter((finding) => finding.severity === 'low').length,
  };
  return {
    schemaVersion: 1,
    analyzedAt: now.toISOString(),
    gate:
      summary.critical > 0 ? 'block' : summary.high > 0 || summary.medium > 0 ? 'review' : 'pass',
    changedFiles: [...changedFiles].sort(),
    addedLines,
    findings: unique,
    summary,
    statement:
      'Hawk PR Security Agent reports deterministic diff signals; human review and evidence gates remain authoritative.',
  };
}

export function pullRequestReportToSarif(
  report: PullRequestSecurityReport,
): Record<string, unknown> {
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'Hawk PR Security Agent',
            informationUri: 'https://github.com/MrBoodj011/hawk',
            rules: [
              ...new Map(report.findings.map((finding) => [finding.ruleId, finding])).values(),
            ].map((finding) => ({
              id: finding.ruleId,
              shortDescription: { text: finding.title },
              help: { text: finding.remediation },
            })),
          },
        },
        results: report.findings.map((finding) => ({
          ruleId: finding.ruleId,
          level:
            finding.severity === 'critical' || finding.severity === 'high' ? 'error' : 'warning',
          message: { text: `${finding.title}. ${finding.remediation}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.file },
                region: { startLine: finding.line },
              },
            },
          ],
        })),
      },
    ],
  };
}

function safePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\.\//g, '')
    .slice(0, 1_000);
}

function redact(value: string): string {
  return value
    .replace(/(["'])[A-Za-z0-9_+\/-]{12,}\1/g, '$1[REDACTED]$1')
    .replace(/-----BEGIN .+ PRIVATE KEY-----/, '[REDACTED PRIVATE KEY]');
}

function deduplicate(values: PullRequestSecurityFinding[]): PullRequestSecurityFinding[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.ruleId}\u0000${value.file}\u0000${value.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}
