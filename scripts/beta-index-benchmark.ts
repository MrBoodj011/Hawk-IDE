import { execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SemanticWorkspaceIndex } from '../src/ide/semanticIndex.js';

const execFileAsync = promisify(execFile);
const clone = process.argv.includes('--clone');
const defaultRoot =
  process.platform === 'win32'
    ? join(process.env.SystemDrive || 'C:', 'hawk-beta')
    : join(tmpdir(), 'hawk-beta-projects');
const root = resolve(argument('--root') || defaultRoot);
const output = resolve(argument('--output') || '.tmp/beta-index-report.json');
const requestedProject = argument('--project')?.trim().toLowerCase();
const projects = [
  {
    name: 'TypeScript',
    url: 'https://github.com/microsoft/TypeScript.git',
    queries: ['language service completions', 'incremental program type checker', 'module resolution'],
  },
  {
    name: 'Visual Studio Code',
    url: 'https://github.com/microsoft/vscode.git',
    queries: ['debug adapter stack trace', 'inline completion provider', 'extension host lifecycle'],
  },
  {
    name: 'OWASP Juice Shop',
    url: 'https://github.com/juice-shop/juice-shop.git',
    queries: ['authentication token validation', 'rest api route', 'security challenge'],
  },
];
const selectedProjects = requestedProject
  ? projects.filter(
      (project) =>
        project.name.toLowerCase() === requestedProject || slug(project.name) === requestedProject,
    )
  : projects;
if (selectedProjects.length === 0) {
  throw new Error(
    `Unknown project "${requestedProject}". Choose one of: ${projects
      .map((project) => slug(project.name))
      .join(', ')}.`,
  );
}

await mkdir(root, { recursive: true });
const results: Array<Record<string, unknown>> = [];
for (const project of selectedProjects) {
  const projectRoot = join(root, slug(project.name));
  if (!(await directoryExists(projectRoot))) {
    if (!clone) throw new Error(`${project.name} is missing. Re-run with --clone.`);
    process.stderr.write(`Cloning ${project.name} for the Hawk beta benchmark…\n`);
    await execFileAsync(
      'git',
      [
        '-c',
        'core.longpaths=true',
        'clone',
        '--depth',
        '1',
        '--single-branch',
        '--filter=blob:limit=5m',
        project.url,
        projectRoot,
      ],
      { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
  }

  const storageRoot = join(root, '.hawk-indexes', `${slug(project.name)}-${Date.now()}`);
  let coldIndex: SemanticWorkspaceIndex | undefined = new SemanticWorkspaceIndex(projectRoot, {
    storageRoot,
  });
  const coldStarted = performance.now();
  const cold = await coldIndex.build();
  const coldMs = Math.round(performance.now() - coldStarted);
  const searchSamples = project.queries.map((query) => {
    const started = performance.now();
    const matches = coldIndex.search(query, 8);
    return {
      query,
      latencyMs: Number((performance.now() - started).toFixed(3)),
      first: matches[0]
        ? `${matches[0].file}:${matches[0].startLine} (${matches[0].score})`
        : null,
      results: matches.length,
    };
  });
  let warmIndex: SemanticWorkspaceIndex | undefined = new SemanticWorkspaceIndex(projectRoot, {
    storageRoot,
  });
  const warmStarted = performance.now();
  const warm = await warmIndex.build();
  const warmMs = Math.round(performance.now() - warmStarted);
  const firstFile = findFirstResultFile(coldIndex, project.queries);
  let incrementalMs: number | null = null;
  if (firstFile) {
    const incrementalStarted = performance.now();
    await warmIndex.updateFile(firstFile);
    incrementalMs = Math.round(performance.now() - incrementalStarted);
  }
  results.push({
    project: project.name,
    source: project.url,
    root: projectRoot,
    cold: { measuredMs: coldMs, ...cold },
    warm: { measuredMs: warmMs, ...warm },
    incremental: { file: firstFile, measuredMs: incrementalMs },
    search: searchSamples,
    processMemory: process.memoryUsage(),
  });
  coldIndex = undefined;
  warmIndex = undefined;
  (globalThis as { gc?: () => void }).gc?.();
}

const report = {
  schema: 1,
  measuredAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  limits: { maxFiles: 8_000, maxChunks: 10_000, maxSourceBytes: 48 * 1024 * 1024 },
  isolatedProject: requestedProject || null,
  projects: results,
};
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function findFirstResultFile(index: SemanticWorkspaceIndex, queries: string[]): string | undefined {
  for (const query of queries) {
    const file = index.search(query, 1)[0]?.file;
    if (file) return file;
  }
  return undefined;
}

async function directoryExists(path: string): Promise<boolean> {
  return await stat(path)
    .then((info) => info.isDirectory())
    .catch(() => false);
}

function slug(value: string): string {
  return basename(value).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
