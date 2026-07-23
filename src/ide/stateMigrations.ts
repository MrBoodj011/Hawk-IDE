export interface MigrationResult<T> {
  value: T;
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
}

const AI_SESSION_VERSION = 2;
const SEMANTIC_INDEX_VERSION = 5;
const ORCHESTRATION_VERSION = 3;

/**
 * Upgrade an older Hawk AI session without discarding its worktree or patch.
 * Version 0 was the pre-versioned prototype shape. Missing recovery/review
 * fields are initialized conservatively and no state is promoted.
 */
export function migrateAiSessionDocument(
  input: unknown,
  expectedId: string,
): MigrationResult<Record<string, unknown>> {
  const value = cloneRecord(input, 'Hawk AI session');
  const fromVersion = integerVersion(value.version, 0);
  if (fromVersion > AI_SESSION_VERSION) {
    throw new Error(`Hawk AI session version ${fromVersion} is newer than this runtime`);
  }
  if (value.id !== expectedId) throw new Error('Hawk AI session id does not match its file name');
  let migrated = false;
  if (fromVersion === 0) {
    value.version = 1;
    value.lastEventId = finiteNumber(value.lastEventId, 0);
    value.background = value.background === true;
    value.autoResume = value.autoResume === true;
    value.resumeCount = finiteNumber(value.resumeCount, 0);
    value.checkpoints = arrayOrEmpty(value.checkpoints);
    value.touchedFiles = arrayOrEmpty(value.touchedFiles);
    value.testGates = arrayOrEmpty(value.testGates);
    value.testResults = arrayOrEmpty(value.testResults);
    migrated = true;
  }
  if (fromVersion < 2) {
    value.version = 2;
    value.autoVerify = value.autoVerify === true;
    value.maxAutoFixAttempts = boundedInteger(value.maxAutoFixAttempts, 2, 0, 5);
    value.autoFixAttempt = boundedInteger(value.autoFixAttempt, 0, 0, 5);
    value.verificationHistory = arrayOrEmpty(value.verificationHistory);
    migrated = true;
  }
  return {
    value,
    migrated,
    fromVersion,
    toVersion: AI_SESSION_VERSION,
  };
}

/**
 * Version 4 semantic indexes already contain bounded chunks but predate the
 * complete type/import/call/structural metadata contract. Those fields can be
 * initialized without re-reading source. Older formats rebuild from source.
 */
export function migrateSemanticIndexDocument(
  input: unknown,
): MigrationResult<Record<string, unknown>> {
  const value = cloneRecord(input, 'semantic index');
  const fromVersion = integerVersion(value.version, -1);
  if (fromVersion > SEMANTIC_INDEX_VERSION) {
    throw new Error(`Semantic index version ${fromVersion} is newer than this runtime`);
  }
  if (fromVersion === SEMANTIC_INDEX_VERSION) {
    return { value, migrated: false, fromVersion, toVersion: SEMANTIC_INDEX_VERSION };
  }
  if (fromVersion !== 4 || !Array.isArray(value.files)) {
    throw new Error(`Semantic index version ${fromVersion} must be rebuilt`);
  }
  for (const file of value.files) {
    const record = asRecord(file, 'semantic index file');
    if (!Array.isArray(record.chunks)) throw new Error('Semantic index file has no chunks');
    for (const chunk of record.chunks) {
      const candidate = asRecord(chunk, 'semantic index chunk');
      candidate.symbols = boundedStringArray(candidate.symbols);
      candidate.types = boundedStringArray(candidate.types);
      candidate.imports = boundedStringArray(candidate.imports);
      candidate.calls = boundedStringArray(candidate.calls);
      candidate.structural =
        typeof candidate.structural === 'string' ? candidate.structural.slice(0, 8_192) : '';
    }
  }
  value.version = SEMANTIC_INDEX_VERSION;
  return {
    value,
    migrated: true,
    fromVersion,
    toVersion: SEMANTIC_INDEX_VERSION,
  };
}

/**
 * Upgrade durable orchestration snapshots fail-closed. Legacy `bridge`
 * networking is never silently retained: it becomes `none` and must be
 * re-approved under the restricted proxy contract.
 */
export function migrateOrchestrationSnapshotDocument(
  input: unknown,
): MigrationResult<Record<string, unknown>> {
  let value = cloneRecord(input, 'orchestration snapshot');
  const fromVersion = integerVersion(value.protocolVersion, 1);
  if (fromVersion > ORCHESTRATION_VERSION) {
    throw new Error(`Orchestration version ${fromVersion} is newer than this runtime`);
  }
  if (fromVersion === ORCHESTRATION_VERSION) {
    return { value, migrated: false, fromVersion, toVersion: ORCHESTRATION_VERSION };
  }
  value.protocolVersion = ORCHESTRATION_VERSION;
  value.artifactMbPerWorker = finiteNumber(value.artifactMbPerWorker, 32);
  value.networkMode = value.networkMode === 'restricted' ? 'restricted' : 'none';
  if (value.networkMode === 'none') value = withoutKeys(value, ['egressPolicy']);
  if (!Array.isArray(value.tasks)) throw new Error('Orchestration snapshot has no task list');
  for (const task of value.tasks) {
    const candidate = asRecord(task, 'orchestration task');
    candidate.reassignments = finiteNumber(candidate.reassignments, 0);
    candidate.dependsOn = Array.isArray(candidate.dependsOn) ? candidate.dependsOn : [];
  }
  return {
    value,
    migrated: true,
    fromVersion,
    toVersion: ORCHESTRATION_VERSION,
  };
}

export function migrateOrchestrationSpecDocument(
  input: unknown,
  snapshotFromVersion: number,
): MigrationResult<Record<string, unknown>> {
  let value = cloneRecord(input, 'orchestration spec');
  if (snapshotFromVersion > ORCHESTRATION_VERSION) {
    throw new Error(`Orchestration version ${snapshotFromVersion} is newer than this runtime`);
  }
  if (snapshotFromVersion === ORCHESTRATION_VERSION) {
    return {
      value,
      migrated: false,
      fromVersion: snapshotFromVersion,
      toVersion: ORCHESTRATION_VERSION,
    };
  }
  if (value.networkMode === 'bridge') {
    value.networkMode = 'none';
    value.inheritEnv = [];
    value.approvedExternalAccess = false;
    value = withoutKeys(value, ['egressPolicy', 'egressProxyToken']);
  }
  return {
    value,
    migrated: true,
    fromVersion: snapshotFromVersion,
    toVersion: ORCHESTRATION_VERSION,
  };
}

function cloneRecord(value: unknown, label: string): Record<string, unknown> {
  return structuredClone(asRecord(value, label));
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function integerVersion(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error('Invalid state version');
  return Number(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Number(value)));
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 256)
        .map((item) => item.slice(0, 512))
    : [];
}

function withoutKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const blocked = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !blocked.has(key)));
}
