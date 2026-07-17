import { createHash, randomUUID } from 'node:crypto';
import type { DurableStore } from './durableStore.js';
import type { HawkRisk, SentinelFinding, SentinelReport } from './smartTypes.js';

const INJECTION_RULES: Array<[RegExp, HawkRisk, string]> = [
  [
    /ignore (?:all |any )?(?:previous|prior|system) instructions/i,
    'critical',
    'Tool text attempts to override trusted instructions',
  ],
  [
    /(?:reveal|return|print|exfiltrate).{0,80}(?:secret|credential|token|system prompt)/i,
    'critical',
    'Tool text requests secrets or hidden instructions',
  ],
  [
    /(?:disable|bypass|remove).{0,40}(?:security|approval|guardrail|policy|sandbox)/i,
    'high',
    'Tool text attempts to disable a security control',
  ],
  [
    /(?:upload|send|post).{0,100}(?:workspace|source|credential).{0,100}https?:\/\//i,
    'high',
    'Tool text may request unapproved data egress',
  ],
];

const SECRET_RULES: Array<[RegExp, string]> = [
  [/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/, 'GitHub token-like value'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'API key-like value'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'Private key material'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*\b/i, 'Bearer token-like value'],
];

export class McpSecuritySentinel {
  constructor(
    private readonly store: DurableStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async inspectManifest(
    manifest: unknown,
    options: { trustedFingerprints?: string[]; previousFingerprint?: string } = {},
  ): Promise<SentinelReport> {
    const canonical = stableStringify(manifest);
    if (Buffer.byteLength(canonical, 'utf8') > 2 * 1024 * 1024)
      throw new Error('MCP manifest exceeds the 2 MB inspection limit');
    const fingerprint = createHash('sha256').update(canonical).digest('hex');
    const findings: SentinelFinding[] = [];
    const walk = flattenText(manifest);
    for (const item of walk) {
      for (const [pattern, severity, message] of INJECTION_RULES) {
        if (pattern.test(item.text))
          findings.push(makeFinding(severity, 'tool-poisoning', message, item.path));
      }
      for (const [pattern, message] of SECRET_RULES) {
        if (pattern.test(item.text))
          findings.push(makeFinding('critical', 'secret-exposure', message, item.path));
      }
    }
    if (
      options.previousFingerprint &&
      options.previousFingerprint !== fingerprint &&
      !options.trustedFingerprints?.includes(fingerprint)
    ) {
      findings.push(
        makeFinding('high', 'rug-pull', 'Server manifest changed after trust was established', '$'),
      );
    }
    if (
      options.trustedFingerprints &&
      options.trustedFingerprints.length > 0 &&
      !options.trustedFingerprints.includes(fingerprint)
    ) {
      findings.push(
        makeFinding('high', 'unsigned-server', 'Fingerprint is not on the trust allowlist', '$'),
      );
    }
    const report: SentinelReport = {
      protocolVersion: 1,
      fingerprint,
      trusted: !findings.some(
        (finding) => finding.severity === 'critical' || finding.severity === 'high',
      ),
      findings: deduplicate(findings).slice(0, 200),
      checkedAt: this.now().toISOString(),
    };
    await this.store.writeJson('sentinel-reports', fingerprint, report);
    return report;
  }

  inspectResult(value: unknown): { safe: boolean; redacted: unknown; findings: SentinelFinding[] } {
    const findings: SentinelFinding[] = [];
    const seen = new WeakSet<object>();
    const visit = (current: unknown, path: string, depth = 0): unknown => {
      if (depth > 64) {
        findings.push(
          makeFinding('high', 'tool-poisoning', 'Tool result exceeds the nesting limit', path),
        );
        return '[BLOCKED BY HAWK: NESTING LIMIT]';
      }
      if (typeof current === 'string') {
        let output = current;
        for (const [pattern, message] of SECRET_RULES) {
          if (!pattern.test(output)) continue;
          findings.push(makeFinding('critical', 'secret-exposure', message, path));
          output = output.replace(pattern, '[REDACTED BY HAWK]');
        }
        for (const [pattern, severity, message] of INJECTION_RULES) {
          if (pattern.test(output))
            findings.push(makeFinding(severity, 'prompt-injection', message, path));
        }
        return output;
      }
      if (Array.isArray(current)) {
        if (seen.has(current)) {
          findings.push(
            makeFinding('high', 'tool-poisoning', 'Tool result contains a reference cycle', path),
          );
          return '[BLOCKED BY HAWK: REFERENCE CYCLE]';
        }
        seen.add(current);
        const output = current
          .slice(0, 10_000)
          .map((item, index) => visit(item, `${path}[${index}]`, depth + 1));
        seen.delete(current);
        return output;
      }
      if (current && typeof current === 'object') {
        if (seen.has(current)) {
          findings.push(
            makeFinding('high', 'tool-poisoning', 'Tool result contains a reference cycle', path),
          );
          return '[BLOCKED BY HAWK: REFERENCE CYCLE]';
        }
        seen.add(current);
        const output = Object.fromEntries(
          Object.entries(current as Record<string, unknown>)
            .slice(0, 1_000)
            .map(([key, item]) => [key, visit(item, `${path}.${key}`, depth + 1)]),
        );
        seen.delete(current);
        return output;
      }
      return current;
    };
    const redacted = visit(value, '$');
    return {
      safe: !findings.some(
        (finding) => finding.severity === 'critical' || finding.severity === 'high',
      ),
      redacted,
      findings: deduplicate(findings).slice(0, 200),
    };
  }
}

function makeFinding(
  severity: HawkRisk,
  category: SentinelFinding['category'],
  message: string,
  location: string,
): SentinelFinding {
  return {
    id: `sentinel-${randomUUID()}`,
    severity,
    category,
    message,
    location: location.slice(0, 1_000),
  };
}

function flattenText(value: unknown): Array<{ path: string; text: string }> {
  const results: Array<{ path: string; text: string }> = [];
  const seen = new WeakSet<object>();
  const visit = (current: unknown, path: string, depth = 0): void => {
    if (depth > 64) throw new Error('MCP manifest exceeds the 64-level nesting limit');
    if (typeof current === 'string') {
      results.push({ path, text: current });
      return;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) throw new Error('MCP manifest contains a reference cycle');
      seen.add(current);
      current
        .slice(0, 10_000)
        .forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      seen.delete(current);
      return;
    }
    if (current && typeof current === 'object') {
      if (seen.has(current)) throw new Error('MCP manifest contains a reference cycle');
      seen.add(current);
      Object.entries(current as Record<string, unknown>)
        .slice(0, 1_000)
        .forEach(([key, item]) => visit(item, `${path}.${key}`, depth + 1));
      seen.delete(current);
    }
  };
  visit(value, '$');
  return results;
}

function stableStringify(value: unknown, depth = 0, seen = new WeakSet<object>()): string {
  if (depth > 64) throw new Error('MCP manifest exceeds the 64-level nesting limit');
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('MCP manifest contains a reference cycle');
    seen.add(value);
    const serialized = `[${value.map((item) => stableStringify(item, depth + 1, seen)).join(',')}]`;
    seen.delete(value);
    return serialized;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new Error('MCP manifest contains a reference cycle');
    seen.add(value);
    const serialized = `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item, depth + 1, seen)}`)
      .join(',')}}`;
    seen.delete(value);
    return serialized;
  }
  return JSON.stringify(value) ?? JSON.stringify(String(value));
}

function deduplicate(findings: SentinelFinding[]): SentinelFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.category}\u0000${finding.message}\u0000${finding.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
