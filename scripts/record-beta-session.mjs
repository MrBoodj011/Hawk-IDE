import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(
  root,
  argument('--output') || '.hawk/validation/beta-acceptance.json',
);
const evidencePath = argument('--evidence');
const evidence = evidencePath ? resolve(evidencePath) : undefined;
if (evidence && !existsSync(evidence)) throw new Error(`Evidence file not found: ${evidence}`);

const session = {
  id: `beta-${randomUUID()}`,
  recordedAt: new Date().toISOString(),
  cohort: required('--cohort', 80),
  repositoryCommit: required('--repository-commit', 80),
  hawkCommit: gitCommit(),
  model: required('--model', 160),
  hardware: required('--hardware', 300),
  outcome: choice('--outcome', ['pass', 'fail']),
  manualRecovery: boolean('--manual-recovery'),
  criticalHighFindings: integer('--critical-high-findings', 0, 100),
  searchP95Ms: number('--search-p95-ms', 0, 60_000),
  peakRssMb: number('--peak-rss-mb', 0, 65_536),
  signedUpdateVerified: boolean('--signed-update-verified'),
  ...(evidence
    ? {
        evidence: {
          file: evidence,
          sha256: createHash('sha256').update(readFileSync(evidence)).digest('hex'),
        },
      }
    : {}),
  ...(argument('--notes') ? { notes: argument('--notes').slice(0, 1_000) } : {}),
};

const existing = existsSync(output)
  ? JSON.parse(readFileSync(output, 'utf8'))
  : { schema: 1, product: 'Hawk Security IDE', sessions: [] };
if (existing.schema !== 1 || !Array.isArray(existing.sessions)) {
  throw new Error('Existing beta evidence has an unsupported schema.');
}
existing.sessions.push(session);
if (existing.sessions.length > 200) existing.sessions = existing.sessions.slice(-200);
existing.updatedAt = new Date().toISOString();

mkdirSync(dirname(output), { recursive: true });
const temporary = `${output}.${randomUUID()}.tmp`;
writeFileSync(temporary, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
renameSync(temporary, output);
process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name, max) {
  const value = String(argument(name) ?? '').trim();
  if (!value || value.length > max) throw new Error(`${name} is required and must be <= ${max} characters.`);
  return value;
}

function choice(name, values) {
  const value = required(name, 40);
  if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(', ')}`);
  return value;
}

function boolean(name) {
  const value = required(name, 5).toLowerCase();
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false.`);
  return value === 'true';
}

function integer(name, minimum, maximum) {
  const value = Number.parseInt(required(name, 20), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function number(name, minimum, maximum) {
  const value = Number(required(name, 20));
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function gitCommit() {
  const value = process.env.GITHUB_SHA || process.env.BUILD_SOURCEVERSION;
  if (value) return value;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    return 'unknown';
  }
}
