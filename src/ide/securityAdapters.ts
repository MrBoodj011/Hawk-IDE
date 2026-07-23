import { createHash } from 'node:crypto';
import { apply as redact } from '../redact/index.js';
import type { SecurityFinding } from './protocol.js';
import { stableHash } from './scopePolicy.js';

const MAX_SARIF_BYTES = 5 * 1024 * 1024;
const MAX_RUNS = 16;
const MAX_RESULTS_PER_RUN = 2_000;
const MAX_FINDINGS = 500;

export type SecurityAdapterId = 'codeql' | 'semgrep' | 'zap' | 'nuclei' | 'trivy' | 'oss-fuzz';

export interface SecurityAdapterDescriptor {
  id: SecurityAdapterId;
  title: string;
  category: 'sast' | 'dast' | 'dependency' | 'fuzzing';
  acceptedFormats: Array<'sarif'>;
  capabilities: string[];
  provenance: 'external-tool';
}

export interface ImportedSecurityFindings {
  adapter: SecurityAdapterId;
  source: string;
  importedAt: string;
  findings: SecurityFinding[];
  truncated: boolean;
}

const ADAPTERS: SecurityAdapterDescriptor[] = [
  {
    id: 'codeql',
    title: 'GitHub CodeQL',
    category: 'sast',
    acceptedFormats: ['sarif'],
    capabilities: ['data-flow', 'taint-analysis', 'multi-language'],
    provenance: 'external-tool',
  },
  {
    id: 'semgrep',
    title: 'Semgrep',
    category: 'sast',
    acceptedFormats: ['sarif'],
    capabilities: ['pattern-analysis', 'autofix-metadata', 'secrets'],
    provenance: 'external-tool',
  },
  {
    id: 'zap',
    title: 'OWASP ZAP',
    category: 'dast',
    acceptedFormats: ['sarif'],
    capabilities: ['passive-scan', 'active-scan-evidence', 'web-runtime'],
    provenance: 'external-tool',
  },
  {
    id: 'nuclei',
    title: 'Nuclei',
    category: 'dast',
    acceptedFormats: ['sarif'],
    capabilities: ['template-scan', 'http-evidence'],
    provenance: 'external-tool',
  },
  {
    id: 'trivy',
    title: 'Trivy',
    category: 'dependency',
    acceptedFormats: ['sarif'],
    capabilities: ['dependency', 'container', 'misconfiguration'],
    provenance: 'external-tool',
  },
  {
    id: 'oss-fuzz',
    title: 'OSS-Fuzz',
    category: 'fuzzing',
    acceptedFormats: ['sarif'],
    capabilities: ['coverage-guided-fuzzing', 'crash-reproduction'],
    provenance: 'external-tool',
  },
];

export function listSecurityAdapters(): SecurityAdapterDescriptor[] {
  return ADAPTERS.map((adapter) => ({ ...adapter, capabilities: [...adapter.capabilities] }));
}

export function importSarifFindings(
  adapter: SecurityAdapterId,
  document: unknown,
  source = 'external.sarif',
  now = new Date(),
): ImportedSecurityFindings {
  if (!ADAPTERS.some((candidate) => candidate.id === adapter)) {
    throw new Error(`Unsupported security adapter: ${adapter}`);
  }
  const serialized = JSON.stringify(document);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_SARIF_BYTES) {
    throw new Error('SARIF document exceeds the 5 MB import limit');
  }
  if (!document || typeof document !== 'object')
    throw new Error('SARIF document must be an object');
  const sarif = document as Record<string, unknown>;
  if (sarif.version !== '2.1.0' || !Array.isArray(sarif.runs)) {
    throw new Error('Only SARIF 2.1.0 documents are supported');
  }

  const findings: SecurityFinding[] = [];
  let truncated = false;
  for (const run of sarif.runs.slice(0, MAX_RUNS)) {
    if (!run || typeof run !== 'object') continue;
    const runRecord = run as Record<string, unknown>;
    const tool = runRecord.tool && typeof runRecord.tool === 'object' ? runRecord.tool : undefined;
    const driver =
      tool && 'driver' in tool && tool.driver && typeof tool.driver === 'object'
        ? tool.driver
        : undefined;
    const driverRecord = driver as Record<string, unknown> | undefined;
    const rules = Array.isArray(runRecord.results) ? runRecord.results : [];
    for (const result of rules.slice(0, MAX_RESULTS_PER_RUN)) {
      if (findings.length >= MAX_FINDINGS) {
        truncated = true;
        break;
      }
      const finding = normalizeSarifResult(adapter, result, driverRecord, now);
      if (finding) findings.push(finding);
    }
    if (rules.length > MAX_RESULTS_PER_RUN) truncated = true;
  }
  if (sarif.runs.length > MAX_RUNS) truncated = true;
  return {
    adapter,
    source: redact(source).slice(0, 500),
    importedAt: now.toISOString(),
    findings,
    truncated,
  };
}

function normalizeSarifResult(
  adapter: SecurityAdapterId,
  value: unknown,
  driver: Record<string, unknown> | undefined,
  now: Date,
): SecurityFinding | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Record<string, unknown>;
  const ruleId = typeof result.ruleId === 'string' ? result.ruleId.trim() : '';
  if (!ruleId) return undefined;
  const message = result.message && typeof result.message === 'object' ? result.message : undefined;
  const messageText =
    message && 'text' in message && typeof message.text === 'string'
      ? message.text
      : `Finding reported by ${adapter}`;
  const locations = Array.isArray(result.locations) ? result.locations : [];
  const location =
    locations[0] && typeof locations[0] === 'object'
      ? (locations[0] as Record<string, unknown>)
      : undefined;
  const physical =
    location?.physicalLocation && typeof location.physicalLocation === 'object'
      ? (location.physicalLocation as Record<string, unknown>)
      : undefined;
  const artifact =
    physical?.artifactLocation && typeof physical.artifactLocation === 'object'
      ? (physical.artifactLocation as Record<string, unknown>)
      : undefined;
  const source = safeRelativePath(typeof artifact?.uri === 'string' ? artifact.uri : undefined);
  const region =
    physical?.region && typeof physical.region === 'object'
      ? (physical.region as Record<string, unknown>)
      : undefined;
  const line =
    typeof region?.startLine === 'number' &&
    Number.isInteger(region.startLine) &&
    region.startLine > 0
      ? region.startLine
      : undefined;
  const title = ruleTitle(driver, ruleId);
  const severity = sarifSeverity(result.level, result.properties);
  const stableId = createHash('sha256')
    .update(`${adapter}\0${ruleId}\0${source ?? ''}\0${line ?? 0}\0${messageText}`)
    .digest('hex')
    .slice(0, 32);
  return {
    id: `external-${adapter}-${stableId}`,
    ruleId: `${adapter}:${ruleId}`.slice(0, 256),
    title: redact(title).slice(0, 300),
    severity,
    status: 'suspected',
    confidence: 'signal',
    createdAt: now.toISOString(),
    description: redact(messageText).slice(0, 2_000),
    remediation: `Review the ${adapter} finding and reproduce it through Hawk's governed sandbox before remediation.`,
    evidence: [{ kind: 'code', summary: redact(messageText).slice(0, 1_000) }],
    ...(source && line ? { source: { file: source, line } } : {}),
  };
}

function ruleTitle(driver: Record<string, unknown> | undefined, ruleId: string): string {
  const rules = Array.isArray(driver?.rules) ? driver.rules : [];
  const rule = rules.find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    return (candidate as Record<string, unknown>).id === ruleId;
  });
  if (rule && typeof rule === 'object') {
    const record = rule as Record<string, unknown>;
    if (typeof record.name === 'string' && record.name.trim()) return record.name;
    const help =
      record.help && typeof record.help === 'object'
        ? (record.help as Record<string, unknown>)
        : undefined;
    if (typeof help?.text === 'string' && help.text.trim()) return help.text;
  }
  return ruleId;
}

function sarifSeverity(level: unknown, properties: unknown): SecurityFinding['severity'] {
  const normalized = typeof level === 'string' ? level.toLowerCase() : '';
  if (normalized === 'error') return 'high';
  if (normalized === 'warning') return 'medium';
  if (normalized === 'note') return 'low';
  if (properties && typeof properties === 'object') {
    const value = (properties as Record<string, unknown>)['security-severity'];
    const score =
      typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
    if (score >= 9) return 'critical';
    if (score >= 7) return 'high';
    if (score >= 4) return 'medium';
    if (score >= 0) return 'low';
  }
  return 'info';
}

function safeRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let path = value.trim().replaceAll('\\', '/');
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  path = path.replace(/^file:\/\/(?:\/)?/, '');
  if (!path || path.startsWith('/') || path.split('/').includes('..')) return undefined;
  return path.slice(0, 500);
}

export function adapterFingerprint(adapters = listSecurityAdapters()): string {
  return stableHash(adapters.map(({ id, capabilities }) => ({ id, capabilities })));
}
