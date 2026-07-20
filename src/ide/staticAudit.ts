import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { IDE_PROTOCOL_VERSION, type SecurityFinding, type StaticAuditReport } from './protocol.js';

const SOURCE_GLOBS = ['**/*.{ts,tsx,js,jsx,mjs,cjs,py,rb,php,java,go,rs,cs,kt,kts}'];
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
  safeControl?: string;
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
  {
    id: 'shell-command-interpolation',
    title: 'Potential shell command interpolation',
    severity: 'high',
    pattern: /\b(?:exec|execSync|system|popen)\s*\(\s*(?:`[^`\r\n]*\$\{|f['"][^'"\r\n]*\{)/gi,
    description:
      'A shell-command-looking API receives string interpolation. Attacker-controlled data could alter the executed command.',
    remediation:
      'Use an argument-array process API without a shell, validate every argument, and keep the executable name constant.',
    safeControl: "spawn('tool', ['--input', value], { shell: false });",
    evidenceSummary: () => 'Interpolated string passed to a shell-command-looking API.',
  },
  {
    id: 'request-controlled-url-fetch',
    title: 'Potential request-controlled outbound URL',
    severity: 'high',
    pattern:
      /\b(?:fetch|axios\.(?:get|post|put|delete)|https?\.get)\s*\(\s*(?:req(?:uest)?\.(?:query|body|params)|ctx\.(?:query|request)|request\.(?:args|form|json))/gi,
    description:
      'An outbound request appears to consume a URL directly from inbound request data. This can become SSRF without strict destination policy.',
    remediation:
      'Resolve destinations through an explicit scheme/host/port allow-list, block private and metadata ranges, and revalidate redirects.',
    safeControl: "fetch(allowlistedServiceUrl('/health'));",
    evidenceSummary: () => 'Inbound request data appears to feed an outbound URL API.',
  },
  {
    id: 'request-controlled-file-path',
    title: 'Potential request-controlled file path',
    severity: 'high',
    pattern:
      /\b(?:readFile|readFileSync|sendFile|createReadStream|open)\s*\(\s*(?:req(?:uest)?\.(?:query|body|params)|ctx\.(?:query|request)|request\.(?:args|form|json))/gi,
    description:
      'A filesystem API appears to consume a path directly from inbound request data. This can enable path traversal or unintended file disclosure.',
    remediation:
      'Map opaque identifiers to server-owned paths, resolve against a fixed root, and reject any result outside that root.',
    safeControl: 'readFile(resolveTrustedAsset(assetId));',
    evidenceSummary: () => 'Inbound request data appears to feed a filesystem path API.',
  },
  {
    id: 'unsafe-deserialization',
    title: 'Potential unsafe deserialization',
    severity: 'high',
    pattern:
      /\b(?:pickle\.loads?|yaml\.unsafe_load|ObjectInputStream|Marshal\.load|unserialize)\s*\(/gi,
    description:
      'A native object deserializer is used on data that may be attacker-controlled. Some formats can instantiate dangerous objects or gadget chains.',
    remediation:
      'Use a data-only format with a strict schema, reject unknown fields and types, and never deserialize native objects from untrusted input.',
    safeControl: 'const value = StrictSchema.parse(JSON.parse(input));',
    evidenceSummary: () => 'Native or explicitly unsafe deserialization API detected.',
  },
  {
    id: 'weak-password-hash',
    title: 'Weak hash used with password-like data',
    severity: 'medium',
    pattern:
      /\b(?:createHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)|(?:md5|sha1)\s*\()\s*[^;\r\n]{0,160}\b(?:password|passwd|pwd)\b/gi,
    description:
      'A fast legacy digest appears to process password-like data. Fast hashes do not provide adequate resistance to offline cracking.',
    remediation:
      'Use Argon2id, scrypt, bcrypt, or PBKDF2 with a unique salt and an explicitly reviewed work factor.',
    safeControl: 'const digest = await argon2.hash(password);',
    evidenceSummary: () => 'MD5/SHA-1 call appears on the same expression as password-like data.',
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
    safeControl: rule.safeControl ?? 'const value = process.env.HAWK_SAFE_CONTROL;',
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
