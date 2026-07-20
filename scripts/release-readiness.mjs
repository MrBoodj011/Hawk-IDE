import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const online = process.argv.includes('--online');
const enforce = process.argv.includes('--enforce');
const packageJson = json('package.json');
const extensionJson = json('extensions/hawk-security-ide/package.json');
const browserJson = json('integrations/browser/manifest.json');
const betaEvidence = optionalJson(
  process.env.HAWK_BETA_EVIDENCE || '.hawk/validation/beta-acceptance.json',
);
const pentestEvidence = optionalJson(
  process.env.HAWK_EXTERNAL_PENTEST_EVIDENCE || '.hawk/validation/external-pentest.json',
);

const checks = [
  check(
    'versions',
    packageJson.version === extensionJson.version && packageJson.version === browserJson.version,
    `root ${packageJson.version}, extension ${extensionJson.version}, browser ${browserJson.version}`,
  ),
  check(
    'windows-signing-identity',
    signingConfigured(),
    signingConfigured()
      ? 'PFX or Azure Artifact Signing environment is configured'
      : 'owner must configure a trusted PFX or Azure Artifact Signing profile',
  ),
  validateBeta(betaEvidence),
  validatePentest(pentestEvidence),
];

if (online) {
  checks.push(await githubActionsCheck(), await githubReleaseCheck(packageJson.version));
}

const ready = checks.every((item) => item.ok);
const report = {
  schema: 1,
  product: 'Hawk Security IDE',
  version: packageJson.version,
  measuredAt: new Date().toISOString(),
  ready,
  checks,
  note:
    'This gate validates evidence and owner-controlled release prerequisites. It never creates a certificate, an external pentest result, or real-user beta evidence.',
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (enforce && !ready) process.exitCode = 1;

function json(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

function optionalJson(value) {
  const path = resolve(root, value);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { invalid: true, path };
  }
}

function signingConfigured() {
  const pfx =
    Boolean(process.env.WINDOWS_CERTIFICATE_BASE64) &&
    Boolean(process.env.WINDOWS_CERTIFICATE_PASSWORD) &&
    Boolean(process.env.HAWK_WINDOWS_PUBLISHER);
  const azure = [
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_ARTIFACT_SIGNING_ENDPOINT',
    'AZURE_ARTIFACT_SIGNING_ACCOUNT',
    'AZURE_ARTIFACT_SIGNING_PROFILE',
    'HAWK_WINDOWS_PUBLISHER',
  ].every((name) => Boolean(process.env[name]));
  return pfx || azure;
}

function validateBeta(value) {
  const sessions = Array.isArray(value?.sessions) ? value.sessions : [];
  const passing = sessions.filter(
    (session) =>
      session?.outcome === 'pass' &&
      session?.manualRecovery === false &&
      Number(session?.criticalHighFindings) === 0 &&
      Number(session?.searchP95Ms) < 50 &&
      Number(session?.peakRssMb) < 500,
  );
  const cohorts = new Set(passing.map((session) => String(session.cohort ?? '')).filter(Boolean));
  return check(
    'real-project-beta',
    passing.length >= 5 && cohorts.size >= 3,
    `${passing.length}/5 passing sessions across ${cohorts.size}/3 cohorts`,
  );
}

function validatePentest(value) {
  const independent =
    typeof value?.assessor === 'string' &&
    value.assessor.trim().length >= 3 &&
    value.assessorIndependent === true;
  const candidate = /^[a-f0-9]{64}$/i.test(String(value?.candidateSha256 ?? ''));
  const noBlockingFindings =
    Number(value?.openCriticalFindings) === 0 && Number(value?.openHighFindings) === 0;
  return check(
    'independent-pentest',
    independent && candidate && noBlockingFindings && value?.outcome === 'pass',
    independent && candidate
      ? `assessor evidence loaded; open Critical/High ${Number(value?.openCriticalFindings ?? 0)}/${Number(value?.openHighFindings ?? 0)}`
      : 'independent assessor evidence is missing or invalid',
  );
}

async function githubActionsCheck() {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'run',
        'list',
        '--limit',
        '4',
        '--json',
        'workflowName,status,conclusion,createdAt,url',
      ],
      { cwd: root, encoding: 'utf8', timeout: 20_000, windowsHide: true },
    );
    const runs = JSON.parse(stdout);
    const relevant = runs.filter((run) =>
      ['Hawk CI', 'Hawk Security Assurance'].includes(run.workflowName),
    );
    const ok =
      relevant.length >= 2 &&
      relevant.every((run) => run.status === 'completed' && run.conclusion === 'success');
    return check(
      'github-actions',
      ok,
      relevant.length
        ? relevant.map((run) => `${run.workflowName}: ${run.conclusion}`).join(', ')
        : 'no recent Hawk CI/security runs found',
    );
  } catch (error) {
    return check('github-actions', false, `could not inspect Actions: ${message(error)}`);
  }
}

async function githubReleaseCheck(version) {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['release', 'view', `v${version}`, '--json', 'isDraft,isPrerelease,tagName,url,assets'],
      { cwd: root, encoding: 'utf8', timeout: 20_000, windowsHide: true },
    );
    const release = JSON.parse(stdout);
    const names = (release.assets ?? []).map((asset) => asset.name);
    const required = [
      new RegExp(`^HawkSetup-windows-x64-${escapeRegex(version)}\\.exe$`),
      new RegExp(`^Hawk-windows-x64-${escapeRegex(version)}\\.msi$`),
      /^SHA256SUMS$/,
    ];
    const complete = required.every((pattern) => names.some((name) => pattern.test(name)));
    return check(
      'official-release',
      !release.isDraft && complete,
      complete ? `${release.tagName} contains signed-release asset names` : `${release.tagName} is incomplete`,
    );
  } catch {
    return check('official-release', false, `v${version} is not published`);
  }
}

function check(id, ok, detail) {
  return { id, ok: Boolean(ok), detail };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
