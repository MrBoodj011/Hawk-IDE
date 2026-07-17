import {
  type HawkHealthReport,
  type HawkHealthSummary,
  type HawkRepositoryRisk,
  IDE_PROTOCOL_VERSION,
} from './protocol.js';

const MAX_REPOSITORIES = 1_000;
const MAX_PRIORITY_ITEMS = 40;

/**
 * Converts Hawk's exported health.json into a stable, small local contract.
 * No GitHub credentials, pull request bodies, source content, or raw alert
 * payloads are retained by the IDE.
 */
export function importHawkHealthReport(value: unknown, now = new Date()): HawkHealthReport {
  const root = record(value, 'Hawk report must be a JSON object');
  if (root.source === 'hawk-health-json' && root.summary && root.priorityQueue) {
    return normalizeStoredReport(root, now);
  }

  const summary = record(root.summary, 'Hawk report is missing its summary object');
  const repositories = Array.isArray(root.repositories)
    ? root.repositories.slice(0, MAX_REPOSITORIES)
    : [];
  const priorityQueue = repositories
    .map(toRepositoryRisk)
    .filter((item): item is HawkRepositoryRisk => item !== undefined)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, MAX_PRIORITY_ITEMS);

  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    source: 'hawk-health-json',
    importedAt: now.toISOString(),
    ...(string(root.generatedAt) ? { generatedAt: string(root.generatedAt) } : {}),
    ...(string(root.organization) ? { organization: string(root.organization) } : {}),
    ...(string(root.outcome) ? { outcome: string(root.outcome) } : {}),
    summary: toSummary(summary, priorityQueue.length),
    priorityQueue,
  };
}

function normalizeStoredReport(root: Record<string, unknown>, now: Date): HawkHealthReport {
  const summary = record(root.summary, 'Stored Hawk report has an invalid summary');
  const queue = Array.isArray(root.priorityQueue)
    ? root.priorityQueue
        .map(toStoredRisk)
        .filter((item): item is HawkRepositoryRisk => item !== undefined)
        .slice(0, MAX_PRIORITY_ITEMS)
    : [];
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    source: 'hawk-health-json',
    importedAt: string(root.importedAt) ?? now.toISOString(),
    ...(string(root.generatedAt) ? { generatedAt: string(root.generatedAt) } : {}),
    ...(string(root.organization) ? { organization: string(root.organization) } : {}),
    ...(string(root.outcome) ? { outcome: string(root.outcome) } : {}),
    summary: toSummary(summary, queue.length),
    priorityQueue: queue,
  };
}

function toSummary(
  value: Record<string, unknown>,
  fallbackRepositories: number,
): HawkHealthSummary {
  return {
    repositories: nonNegative(value.repositories) ?? fallbackRepositories,
    ...(finite(value.maintenanceScore) !== undefined
      ? { maintenanceScore: finite(value.maintenanceScore) }
      : {}),
    ...(finite(value.governanceScore) !== undefined
      ? { governanceScore: finite(value.governanceScore) }
      : {}),
    highRiskRepositories: nonNegative(value.highRiskRepositories) ?? 0,
    failedUpdatePulls: nonNegative(value.failedUpdatePulls) ?? 0,
    overdueSecurityAlerts: nonNegative(value.overdueSecurityAlerts) ?? 0,
    securityAlerts: nonNegative(value.securityAlerts) ?? 0,
    criticalSecurityAlerts: nonNegative(value.criticalSecurityAlerts) ?? 0,
    highSecurityAlerts: nonNegative(value.highSecurityAlerts) ?? 0,
    sbomRepositories: nonNegative(value.sbomRepositories) ?? 0,
    trackedPackages: nonNegative(value.trackedPackages) ?? 0,
    unknownPackageLicenses: nonNegative(value.unknownPackageLicenses) ?? 0,
    securityUnknown: nonNegative(value.securityUnknown) ?? 0,
    inspectionErrors: nonNegative(value.inspectionErrors) ?? 0,
  };
}

function toRepositoryRisk(value: unknown): HawkRepositoryRisk | undefined {
  const repository = recordOrUndefined(value);
  const name = repository && string(repository.name);
  if (!repository || !name) return undefined;
  const breakdown = recordOrEmpty(repository.securityBreakdown);
  const sla = recordOrEmpty(repository.securitySla);
  const sbom = recordOrEmpty(repository.sbom);
  const criticalAlerts = nonNegative(breakdown.critical) ?? 0;
  const highAlerts = nonNegative(breakdown.high) ?? 0;
  const overdueSecurityAlerts = nonNegative(sla.total) ?? 0;
  const failedChecks = nonNegative(repository.failedUpdatePulls) ?? 0;
  const securityAlerts =
    repository.securityAlerts === null ? null : (nonNegative(repository.securityAlerts) ?? 0);
  const unknownLicenses = nonNegative(sbom.unknownLicenses) ?? 0;
  const sbomPackages = nonNegative(sbom.packageCount) ?? 0;
  const reasons: string[] = [];
  if (criticalAlerts) reasons.push(`${criticalAlerts} critical alert${plural(criticalAlerts)}`);
  if (highAlerts) reasons.push(`${highAlerts} high alert${plural(highAlerts)}`);
  if (overdueSecurityAlerts)
    reasons.push(`${overdueSecurityAlerts} SLA breach${plural(overdueSecurityAlerts)}`);
  if (failedChecks) reasons.push(`${failedChecks} failed update check${plural(failedChecks)}`);
  if (repository.inspectionError) reasons.push('inspection visibility failed');
  if (securityAlerts === null) reasons.push('security visibility unavailable');
  if (unknownLicenses)
    reasons.push(`${unknownLicenses} unclassified license${plural(unknownLicenses)}`);
  const score = Math.min(
    100,
    criticalAlerts * 30 +
      highAlerts * 12 +
      overdueSecurityAlerts * 15 +
      failedChecks * 8 +
      (repository.inspectionError ? 25 : 0) +
      (securityAlerts === null ? 12 : 0) +
      Math.min(10, unknownLicenses),
  );
  return {
    name,
    ...(string(repository.url) ? { url: string(repository.url) } : {}),
    score,
    level: riskLevel(score, criticalAlerts, highAlerts),
    reasons: reasons.length ? reasons : ['no priority signal in imported report'],
    securityAlerts,
    criticalAlerts,
    highAlerts,
    overdueSecurityAlerts,
    failedChecks,
    sbomPackages,
    unknownLicenses,
  };
}

function toStoredRisk(value: unknown): HawkRepositoryRisk | undefined {
  const risk = recordOrUndefined(value);
  const name = risk && string(risk.name);
  if (!risk || !name) return undefined;
  const level = string(risk.level);
  if (
    level !== 'critical' &&
    level !== 'high' &&
    level !== 'moderate' &&
    level !== 'low' &&
    level !== 'unknown'
  )
    return undefined;
  return {
    name,
    ...(string(risk.url) ? { url: string(risk.url) } : {}),
    score: Math.min(100, nonNegative(risk.score) ?? 0),
    level,
    reasons: Array.isArray(risk.reasons)
      ? risk.reasons.filter((item): item is string => typeof item === 'string').slice(0, 12)
      : [],
    securityAlerts: risk.securityAlerts === null ? null : (nonNegative(risk.securityAlerts) ?? 0),
    criticalAlerts: nonNegative(risk.criticalAlerts) ?? 0,
    highAlerts: nonNegative(risk.highAlerts) ?? 0,
    overdueSecurityAlerts: nonNegative(risk.overdueSecurityAlerts) ?? 0,
    failedChecks: nonNegative(risk.failedChecks) ?? 0,
    sbomPackages: nonNegative(risk.sbomPackages) ?? 0,
    unknownLicenses: nonNegative(risk.unknownLicenses) ?? 0,
  };
}

function riskLevel(score: number, critical: number, high: number): HawkRepositoryRisk['level'] {
  if (critical > 0 || score >= 70) return 'critical';
  if (high > 0 || score >= 35) return 'high';
  if (score > 0) return 'moderate';
  return 'low';
}

function plural(value: number): string {
  return value === 1 ? '' : 's';
}

function record(value: unknown, message: string): Record<string, unknown> {
  const output = recordOrUndefined(value);
  if (!output) throw new Error(message);
  return output;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return recordOrUndefined(value) ?? {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed === undefined ? undefined : Math.max(0, Math.round(parsed));
}
