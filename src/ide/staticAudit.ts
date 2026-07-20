import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { IDE_PROTOCOL_VERSION, type SecurityFinding, type StaticAuditReport } from './protocol.js';

const SOURCE_GLOBS = ['**/*.{ts,tsx,js,jsx,mjs,cjs,py,rb,php,java,go}'];
const IGNORED_DIRECTORIES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/vendor/**',
];

interface AuditRule {
  id: string;
  title: string;
  severity: SecurityFinding['severity'];
  pattern: RegExp;
  description: string;
  remediation: string;
  evidenceSummary(match: string): string;
}

export interface StaticAuditReproductionRecipe {
  ruleId: string;
  patternSource: string;
  patternFlags: string;
  safeControl: string;
}

const RULES: AuditRule[] = [
  {
    id: 'hardcoded-secret',
    title: 'Potential hard-coded credential',
    severity: 'high',
    pattern:
      /\b(?:api[_-]?key|secret|password|token|access[_-]?key)\s*[:=]\s*(['"`])(?!(?:your|example|changeme|placeholder|replace)[^'"`]*\1)[^'"`\r\n]{8,}\1/gi,
    description:
      'A credential-like value appears to be embedded in source code. It may be committed, exposed in builds, or reused across environments.',
    remediation:
      'Move the value to a secret manager or environment variable, rotate it, and remove it from version history.',
    evidenceSummary: (match) => `Credential-like assignment detected (${redactAssignment(match)}).`,
  },
  {
    id: 'tls-verification-disabled',
    title: 'TLS certificate verification disabled',
    severity: 'high',
    pattern: /\brejectUnauthorized\s*:\s*false\b/g,
    description:
      'The HTTP client accepts invalid TLS certificates, enabling machine-in-the-middle attacks.',
    remediation:
      'Remove this override and use a trusted CA bundle only when a private CA is required.',
    evidenceSummary: () => 'rejectUnauthorized is explicitly set to false.',
  },
  {
    id: 'dynamic-code-execution',
    title: 'Dynamic code execution via eval',
    severity: 'high',
    pattern: /\beval\s*\(/g,
    description:
      'eval can execute attacker-controlled JavaScript when data reaches this call path.',
    remediation: 'Replace eval with structured parsing or a narrow, allow-listed dispatcher.',
    evidenceSummary: () => 'eval(...) call detected.',
  },
  {
    id: 'sql-template-interpolation',
    title: 'Potential SQL template interpolation',
    severity: 'high',
    pattern: /\b(?:query|execute|raw)\s*\(\s*`[^`\r\n]*\$\{/gi,
    description:
      'A database-call-looking function receives an interpolated template string. User-controlled input could become SQL injection.',
    remediation: 'Use parameterized queries and bind variables; keep SQL structure static.',
    evidenceSummary: () => 'Interpolated template literal passed to a query-like call.',
  },
  {
    id: 'wildcard-cors-credentials',
    title: 'Wildcard CORS origin with credentials',
    severity: 'medium',
    pattern:
      /origin\s*:\s*['"]\*['"][\s\S]{0,240}?credentials\s*:\s*true|credentials\s*:\s*true[\s\S]{0,240}?origin\s*:\s*['"]\*['"]/gi,
    description:
      'This CORS configuration may allow cross-origin credentialed requests more broadly than intended.',
    remediation:
      'Use an explicit allow-list of trusted origins and verify browser behavior for credentialed requests.',
    evidenceSummary: () =>
      'Wildcard origin and credentials:true appear in the same CORS configuration.',
  },
];

export function getStaticAuditReproductionRecipe(
  ruleId: string,
): StaticAuditReproductionRecipe | undefined {
  const rule = RULES.find((candidate) => candidate.id === ruleId);
  if (!rule) return undefined;
  return {
    ruleId: rule.id,
    patternSource: rule.pattern.source,
    patternFlags: rule.pattern.flags,
    safeControl: 'const value = process.env.HAWK_SAFE_CONTROL;',
  };
}

/**
 * Runs a passive, text-only security audit. It never starts the application,
 * calls a target, or executes project code. Every result is a signal that
 * needs manual validation before it can become a vulnerability finding.
 */
export async function scanWorkspaceSecurity(
  workspaceRoot: string,
  now = new Date(),
): Promise<StaticAuditReport> {
  const root = resolve(workspaceRoot);
  const files = await fg(SOURCE_GLOBS, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: IGNORED_DIRECTORIES,
  });
  const findings: SecurityFinding[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const relativeFile = relative(root, file).split(sep).join('/');
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of source.matchAll(rule.pattern)) {
        if (match.index === undefined) continue;
        findings.push(createFinding(rule, relativeFile, source, match.index, match[0] ?? '', now));
      }
    }
  }

  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    scannedAt: now.toISOString(),
    sourceFiles: files.length,
    findings: dedupe(findings).sort(compareFindings),
  };
}

function createFinding(
  rule: AuditRule,
  file: string,
  source: string,
  index: number,
  match: string,
  now: Date,
): SecurityFinding {
  const line = source.slice(0, index).split('\n').length;
  const fingerprint = `${rule.id}\u0000${file}\u0000${line}`;
  return {
    id: `static-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`,
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    status: 'suspected',
    confidence: 'signal',
    createdAt: now.toISOString(),
    description: rule.description,
    remediation: rule.remediation,
    evidence: [{ kind: 'code', summary: rule.evidenceSummary(match) }],
    source: { file, line },
  };
}

function redactAssignment(match: string): string {
  const label = match.match(/^\s*([\w-]+)/)?.[1] ?? 'value';
  return `${label}=***redacted***`;
}

function dedupe(findings: SecurityFinding[]): SecurityFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.id)) return false;
    seen.add(finding.id);
    return true;
  });
}

function compareFindings(a: SecurityFinding, b: SecurityFinding): number {
  const severity = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return (
    severity[a.severity] - severity[b.severity] ||
    (a.source?.file ?? '').localeCompare(b.source?.file ?? '') ||
    (a.source?.line ?? 0) - (b.source?.line ?? 0)
  );
}
