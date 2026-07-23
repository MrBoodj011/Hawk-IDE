import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { DurableStore } from './durableStore.js';
import type {
  HawkDockerOrchestrator,
  OrchestrationSnapshot,
  OrchestrationSpec,
} from './orchestrator.js';
import {
  type GenericReproductionScenario,
  IDE_PROTOCOL_VERSION,
  type SandboxReproductionGateId,
  type SandboxReproductionGateResult,
  type SandboxReproductionPlan,
  type SandboxReproductionResult,
  type SecurityFinding,
} from './protocol.js';
import { getStaticAuditReproductionRecipe } from './staticAudit.js';

const PLAN_TTL_MS = 10 * 60 * 1_000;
const STAGE_TIMEOUT_SECONDS = 30;
const MAX_WAIT_MS = 120_000;
const DEFAULT_IMAGE = 'hawk-worker:local';

export type ReproductionOrchestrator = Pick<HawkDockerOrchestrator, 'start' | 'get' | 'shutdown'>;

export interface ExecuteSandboxReproductionInput {
  planId: string;
  planHash: string;
  approved: true;
}

export type GenericReproductionInput = GenericReproductionScenario;

export class SandboxVulnerabilityReproducer {
  constructor(
    private readonly workspaceRoot: string,
    private readonly store: DurableStore,
    private readonly orchestrator: ReproductionOrchestrator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createPlan(
    finding: SecurityFinding,
    image = DEFAULT_IMAGE,
    generic?: GenericReproductionInput,
  ): Promise<SandboxReproductionPlan> {
    const recipe = selectRecipe(finding, generic);
    const sourceLocation = requiredSource(finding);
    const source = {
      ...sourceLocation,
      sha256: await sourceDigest(this.workspaceRoot, sourceLocation.file),
    };
    const createdAt = this.now();
    const unsigned = {
      protocolVersion: IDE_PROTOCOL_VERSION,
      id: `repro-plan-${randomUUID()}`,
      findingId: finding.id,
      ruleId: finding.ruleId,
      title: `Reproduce ${finding.title} inside an offline sandbox`,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
      image: validImage(image),
      mode:
        recipe.kind === 'generic-command'
          ? ('generic-sandbox' as const)
          : ('offline-signal' as const),
      source,
      isolation: {
        workspace: 'read-only' as const,
        rootFilesystem: 'read-only' as const,
        network: 'none' as const,
        capabilities: 'dropped' as const,
        maxCpu: 0.5,
        maxMemoryMb: 256,
        maxSeconds: STAGE_TIMEOUT_SECONDS * 3,
        maxArtifactMb: 32,
      },
      gates: [
        {
          id: 'baseline' as const,
          title: 'Baseline integrity',
          purpose: 'Confirm the exact source location is readable without exposing its content.',
        },
        {
          id: 'control' as const,
          title: 'Negative control',
          purpose: 'Prove the rule does not trigger on a known-safe synthetic control.',
        },
        {
          id: 'reproduction' as const,
          title: 'Signal reproduction',
          purpose: 'Re-run the deterministic rule against the exact source line.',
        },
      ],
      statement:
        recipe.kind === 'generic-command'
          ? 'This approved offline scenario can reproduce a bounded security observation. It cannot prove exploitability, identity impact, or a verified vulnerability.'
          : 'This offline run can reproduce a deterministic code signal. It cannot prove exploitability, identity impact, or a verified vulnerability.',
      recipe,
    };
    const plan: SandboxReproductionPlan = {
      ...withoutRecipe(unsigned),
      planHash: hashPlan(unsigned),
    };
    await this.store.writeJson('reproduction-plans', plan.id, unsigned);
    return plan;
  }

  async execute(
    finding: SecurityFinding,
    input: ExecuteSandboxReproductionInput,
  ): Promise<SandboxReproductionResult> {
    if (input.approved !== true) throw new Error('Explicit operator approval is required');
    const stored = await this.store.readJson<StoredReproductionPlan>(
      'reproduction-plans',
      input.planId,
    );
    if (!stored) throw new Error('Sandbox reproduction plan was not found or expired');
    if (stored.findingId !== finding.id || stored.ruleId !== finding.ruleId)
      throw new Error('Finding changed after the reproduction plan was created');
    if (Date.parse(stored.expiresAt) <= this.now().getTime())
      throw new Error('Sandbox reproduction plan expired; create a new plan');
    const expectedHash = hashPlan(stored);
    if (expectedHash !== input.planHash)
      throw new Error('Sandbox reproduction plan hash does not match the approved plan');
    const source = requiredSource(finding);
    if (source.file !== stored.source.file || source.line !== stored.source.line)
      throw new Error('Finding source changed after the reproduction plan was created');
    if ((await sourceDigest(this.workspaceRoot, source.file)) !== stored.source.sha256)
      throw new Error('Finding source content changed after the reproduction plan was approved');

    const startedAt = this.now().toISOString();
    const run = await this.orchestrator.start(orchestrationSpec(stored));
    const completed = await waitForTerminal(this.orchestrator, run.id);
    const gates = gateResults(completed, stored.source.sha256);
    const allPassed =
      completed.status === 'succeeded' &&
      gates.length === 3 &&
      gates.every((gate) => gate.status === 'passed');
    const result: SandboxReproductionResult = {
      protocolVersion: IDE_PROTOCOL_VERSION,
      id: `reproduction-${randomUUID()}`,
      planId: stored.id,
      planHash: expectedHash,
      findingId: finding.id,
      ruleId: finding.ruleId,
      image: stored.image,
      orchestrationRunId: completed.id,
      status: allPassed
        ? 'reproduced'
        : completed.status === 'failed'
          ? 'failed'
          : 'not-reproduced',
      lifecycle: allPassed ? 'reproduced' : 'signal',
      promotedToVerified: false,
      startedAt,
      completedAt: this.now().toISOString(),
      gates,
      missingVerificationGates: [
        'independent reproduction',
        'valid test identity',
        'demonstrated impact',
        'declared authorization scope',
        'reviewed evidence',
      ],
      statement: allPassed
        ? 'The deterministic signal was reproduced in an offline sandbox. Hawk did not promote it to a verified vulnerability.'
        : 'The offline sandbox did not reproduce every required signal gate. The finding remains an unverified signal.',
    };
    await this.store.writeJson('reproductions', result.id, result);
    return result;
  }

  async list(limit = 100): Promise<SandboxReproductionResult[]> {
    const results = await this.store.listJson<SandboxReproductionResult>('reproductions');
    return results
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .slice(0, Math.max(1, Math.min(limit, 500)));
  }

  async shutdown(): Promise<void> {
    await this.orchestrator.shutdown();
  }
}

interface StoredReproductionPlan extends Omit<SandboxReproductionPlan, 'planHash'> {
  recipe: DeterministicRecipe | GenericCommandRecipe | LegacyDeterministicRecipe;
}

interface DeterministicRecipe {
  kind: 'deterministic';
  patternSource: string;
  patternFlags: string;
  safeControl: string;
}

interface GenericCommandRecipe {
  kind: 'generic-command';
  mode: NonNullable<GenericReproductionInput['mode']>;
  control: string[];
  reproduction: string[];
  controlExpectedExitCode: number;
  reproductionExpectedExitCode: number;
  label?: string;
}

interface LegacyDeterministicRecipe {
  patternSource: string;
  patternFlags: string;
  safeControl: string;
}

function selectRecipe(
  finding: SecurityFinding,
  generic?: GenericReproductionInput,
): DeterministicRecipe | GenericCommandRecipe {
  const recipe = getStaticAuditReproductionRecipe(finding.ruleId);
  if (recipe) {
    return {
      kind: 'deterministic',
      patternSource: recipe.patternSource,
      patternFlags: recipe.patternFlags,
      safeControl: recipe.safeControl,
    };
  }
  if (!generic) {
    throw new Error(
      `Automatic offline reproduction is not available for rule ${finding.ruleId}; provide a generic command scenario`,
    );
  }
  return normalizeGenericRecipe(generic);
}

function requiredSource(finding: SecurityFinding): { file: string; line: number } {
  if (!finding.source) throw new Error('Finding has no source location to reproduce');
  if (
    isAbsolute(finding.source.file) ||
    finding.source.file.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    throw new Error('Finding source must stay inside the trusted workspace');
  }
  if (!Number.isInteger(finding.source.line) || finding.source.line < 1)
    throw new Error('Finding source line is invalid');
  return { file: finding.source.file.replaceAll('\\', '/'), line: finding.source.line };
}

async function sourceDigest(workspaceRoot: string, file: string): Promise<string> {
  const root = resolve(workspaceRoot);
  const absolute = resolve(root, file);
  const relativeFile = relative(root, absolute);
  if (!relativeFile || relativeFile.startsWith('..') || isAbsolute(relativeFile))
    throw new Error('Finding source must stay inside the trusted workspace');
  try {
    return createHash('sha256')
      .update(await readFile(absolute))
      .digest('hex');
  } catch {
    throw new Error('Finding source could not be read for exact-plan approval');
  }
}

function validImage(image: string): string {
  const value = image.trim();
  if (
    !value ||
    value.length > 255 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value) ||
    value.includes('..')
  )
    throw new Error('Reproduction image must be a valid existing local Docker image name');
  return value;
}

function withoutRecipe(plan: StoredReproductionPlan): Omit<SandboxReproductionPlan, 'planHash'> {
  const { recipe: _recipe, ...publicPlan } = plan;
  return publicPlan;
}

function hashPlan(plan: StoredReproductionPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function orchestrationSpec(plan: StoredReproductionPlan): OrchestrationSpec {
  const recipe = normalizeStoredRecipe(plan.recipe);
  if (recipe.kind === 'generic-command') return genericOrchestrationSpec(plan, recipe);
  const common = {
    patternSource: recipe.patternSource,
    patternFlags: recipe.patternFlags,
  };
  return {
    image: plan.image,
    maxParallel: 1,
    cpuPerWorker: plan.isolation.maxCpu,
    memoryMbPerWorker: plan.isolation.maxMemoryMb,
    artifactMbPerWorker: plan.isolation.maxArtifactMb,
    networkMode: 'none',
    scheduleStrategy: 'latency',
    leaseSeconds: 30,
    agentInstances: [
      {
        id: 'reproduction-sandbox',
        capabilities: ['security', 'reproduction'],
        maxConcurrent: 1,
        cpuCapacity: plan.isolation.maxCpu,
        memoryMbCapacity: plan.isolation.maxMemoryMb,
      },
    ],
    tasks: [
      {
        id: 'baseline',
        title: 'Verify source baseline',
        command: baselineCommand(plan.source.file, plan.source.line),
        timeoutSeconds: STAGE_TIMEOUT_SECONDS,
        requiredCapabilities: ['reproduction'],
        priority: 100,
        estimatedSeconds: 3,
      },
      {
        id: 'control',
        title: 'Run negative control',
        command: controlCommand(common, recipe.safeControl),
        dependsOn: ['baseline'],
        timeoutSeconds: STAGE_TIMEOUT_SECONDS,
        requiredCapabilities: ['reproduction'],
        priority: 100,
        estimatedSeconds: 3,
      },
      {
        id: 'reproduction',
        title: 'Reproduce deterministic signal',
        command: reproductionCommand(common, plan.source.file, plan.source.line),
        dependsOn: ['control'],
        timeoutSeconds: STAGE_TIMEOUT_SECONDS,
        requiredCapabilities: ['reproduction'],
        priority: 100,
        estimatedSeconds: 5,
      },
    ],
  };
}

function genericOrchestrationSpec(
  plan: StoredReproductionPlan,
  recipe: GenericCommandRecipe,
): OrchestrationSpec {
  return {
    image: plan.image,
    maxParallel: 1,
    cpuPerWorker: plan.isolation.maxCpu,
    memoryMbPerWorker: plan.isolation.maxMemoryMb,
    artifactMbPerWorker: plan.isolation.maxArtifactMb,
    networkMode: 'none',
    scheduleStrategy: 'latency',
    leaseSeconds: 30,
    agentInstances: [
      {
        id: 'reproduction-sandbox',
        capabilities: ['security', 'reproduction'],
        maxConcurrent: 1,
        cpuCapacity: plan.isolation.maxCpu,
        memoryMbCapacity: plan.isolation.maxMemoryMb,
      },
    ],
    tasks: [
      {
        id: 'baseline',
        title: 'Verify source baseline',
        command: baselineCommand(plan.source.file, plan.source.line),
        timeoutSeconds: STAGE_TIMEOUT_SECONDS,
        requiredCapabilities: ['reproduction'],
        priority: 100,
        estimatedSeconds: 3,
      },
      {
        id: 'control',
        title: `Run ${recipe.mode === 'command' ? 'generic' : recipe.mode} negative control`,
        command: genericCommand('control', recipe.control, recipe.controlExpectedExitCode),
        dependsOn: ['baseline'],
        timeoutSeconds: STAGE_TIMEOUT_SECONDS,
        requiredCapabilities: ['reproduction'],
        priority: 100,
        estimatedSeconds: 5,
      },
      {
        id: 'reproduction',
        title: recipe.label
          ? `Reproduce ${recipe.mode === 'command' ? 'generic' : recipe.mode}: ${recipe.label}`
          : `Run ${recipe.mode === 'command' ? 'generic' : recipe.mode} security reproduction`,
        command: genericCommand(
          'reproduction',
          recipe.reproduction,
          recipe.reproductionExpectedExitCode,
        ),
        dependsOn: ['control'],
        timeoutSeconds: STAGE_TIMEOUT_SECONDS,
        requiredCapabilities: ['reproduction'],
        priority: 100,
        estimatedSeconds: 10,
      },
    ],
  };
}

function baselineCommand(file: string, line: number): string[] {
  return [
    'node',
    '-e',
    [
      "const fs=require('fs'),crypto=require('crypto');",
      'const source=fs.readFileSync(process.argv[1]);',
      "const lines=source.toString('utf8').split(/\\r?\\n/);",
      'const line=Number(process.argv[2]);',
      'const observed=line>=1&&line<=lines.length;',
      "const digest=crypto.createHash('sha256').update(source).digest('hex');",
      "process.stdout.write(JSON.stringify({gate:'baseline',observed,digest}));",
      'process.exit(observed?0:1);',
    ].join(''),
    `/workspace/${file}`,
    String(line),
  ];
}

function controlCommand(
  recipe: { patternSource: string; patternFlags: string },
  safeControl: string,
): string[] {
  return [
    'node',
    '-e',
    [
      'const pattern=new RegExp(process.argv[1],process.argv[2]);',
      'const observed=pattern.test(process.argv[3]);',
      "process.stdout.write(JSON.stringify({gate:'control',observed:!observed}));",
      'process.exit(observed?1:0);',
    ].join(''),
    recipe.patternSource,
    recipe.patternFlags,
    safeControl,
  ];
}

function reproductionCommand(
  recipe: { patternSource: string; patternFlags: string },
  file: string,
  line: number,
): string[] {
  return [
    'node',
    '-e',
    [
      "const fs=require('fs'),crypto=require('crypto');",
      "const source=fs.readFileSync(process.argv[1],'utf8');",
      'const target=Number(process.argv[2]);',
      'const pattern=new RegExp(process.argv[3],process.argv[4]);',
      'const matches=[...source.matchAll(pattern)];',
      "const lines=matches.map(match=>source.slice(0,match.index).split('\\n').length);",
      'const observed=lines.includes(target);',
      "const digest=crypto.createHash('sha256').update(`${process.argv[1]}:${target}:${observed}`).digest('hex');",
      "process.stdout.write(JSON.stringify({gate:'reproduction',observed,matchCount:matches.length,line:target,digest}));",
      'process.exit(observed?0:1);',
    ].join(''),
    `/workspace/${file}`,
    String(line),
    recipe.patternSource,
    recipe.patternFlags,
  ];
}

function genericCommand(
  gate: 'control' | 'reproduction',
  command: string[],
  expectedExitCode: number,
): string[] {
  return [
    'node',
    '-e',
    [
      "const {spawnSync}=require('child_process');",
      'const gate=process.argv[1], command=process.argv[2], args=JSON.parse(process.argv[3]), expected=Number(process.argv[4]);',
      "const result=spawnSync(command,args,{cwd:'/workspace',stdio:['ignore','pipe','pipe'],timeout:25000,env:{PATH:process.env.PATH,HOME:'/tmp'}});",
      "const exitCode=typeof result.status==='number'?result.status:-1;",
      "const runnable=!result.error&&typeof result.status==='number';",
      'const matched=runnable&&exitCode===expected;',
      "const observed=runnable&&(gate==='control'?!matched:matched);",
      "const output=Buffer.concat([result.stdout||Buffer.alloc(0),result.stderr||Buffer.alloc(0)]).toString('utf8').slice(0,12000);",
      'process.stdout.write(JSON.stringify({gate,observed,exitCode,output,error:result.error?.message}));',
      'process.exit(observed?0:1);',
    ].join(''),
    gate,
    command[0] ?? '',
    JSON.stringify(command.slice(1)),
    String(expectedExitCode),
  ];
}

async function waitForTerminal(
  orchestrator: Pick<ReproductionOrchestrator, 'get'>,
  runId: string,
): Promise<OrchestrationSnapshot> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const snapshot = orchestrator.get(runId, true);
    if (!snapshot) throw new Error(`Sandbox reproduction run disappeared: ${runId}`);
    if (
      snapshot.status === 'succeeded' ||
      snapshot.status === 'failed' ||
      snapshot.status === 'cancelled'
    ) {
      return snapshot;
    }
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, 100);
      timer.unref();
    });
  }
  throw new Error('Sandbox reproduction exceeded its bounded execution window');
}

function gateResults(
  snapshot: OrchestrationSnapshot,
  expectedSourceDigest: string,
): SandboxReproductionGateResult[] {
  return (['baseline', 'control', 'reproduction'] as SandboxReproductionGateId[]).map((id) => {
    const task = snapshot.tasks.find((candidate) => candidate.id === id);
    const evidence = parseGateEvidence(task?.output);
    const digestMatches =
      id !== 'baseline' ||
      (typeof evidence?.digest === 'string' && evidence.digest === expectedSourceDigest);
    const passed = task?.status === 'succeeded' && evidence?.observed === true && digestMatches;
    return {
      id,
      status: passed ? 'passed' : 'failed',
      durationMs: task?.durationMs ?? 0,
      ...(task?.assignedInstanceId ? { instanceId: task.assignedInstanceId } : {}),
      ...(typeof evidence?.digest === 'string' ? { evidenceDigest: evidence.digest } : {}),
      message: passed
        ? `${gateTitle(id)} passed in the isolated sandbox.`
        : (task?.error ?? `${gateTitle(id)} did not produce the expected observation.`),
    };
  });
}

function parseGateEvidence(output: string | undefined): Record<string, unknown> | undefined {
  if (!output || output.length > 16_384) return undefined;
  try {
    const value = JSON.parse(output) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeStoredRecipe(
  recipe: StoredReproductionPlan['recipe'],
): DeterministicRecipe | GenericCommandRecipe {
  if ('kind' in recipe && recipe.kind === 'generic-command') return recipe;
  if ('kind' in recipe && recipe.kind === 'deterministic') return recipe;
  const legacy = recipe as LegacyDeterministicRecipe;
  return {
    kind: 'deterministic',
    patternSource: legacy.patternSource,
    patternFlags: legacy.patternFlags,
    safeControl: legacy.safeControl,
  };
}

function normalizeGenericRecipe(input: GenericReproductionInput): GenericCommandRecipe {
  const control = validateGenericCommand(input.control, 'control');
  const reproduction = validateGenericCommand(input.reproduction, 'reproduction');
  return {
    kind: 'generic-command',
    mode: input.mode ?? 'command',
    control,
    reproduction,
    controlExpectedExitCode: validExitCode(input.controlExpectedExitCode ?? 0),
    reproductionExpectedExitCode: validExitCode(input.reproductionExpectedExitCode ?? 0),
    ...(input.label?.trim() ? { label: input.label.trim().slice(0, 160) } : {}),
  };
}

function validateGenericCommand(command: string[], label: string): string[] {
  if (!Array.isArray(command) || command.length < 1 || command.length > 32) {
    throw new Error(`Generic ${label} command must contain 1-32 arguments`);
  }
  const normalized = command.map((part) => {
    if (
      typeof part !== 'string' ||
      !part ||
      part.length > 1_000 ||
      [...part].some((character) => character.charCodeAt(0) < 32)
    ) {
      throw new Error(`Generic ${label} command contains an invalid argument`);
    }
    if (part.includes('..') || (part.startsWith('/') && !part.startsWith('/workspace/'))) {
      throw new Error(`Generic ${label} command may only access the mounted /workspace`);
    }
    return part;
  });
  const executable = normalized[0]?.toLowerCase().replace(/\.cmd$/, '');
  const allowed = new Set([
    'node',
    'nodejs',
    'python',
    'python3',
    'pytest',
    'ruby',
    'go',
    'cargo',
    'dotnet',
    'java',
    'npm',
    'npx',
  ]);
  if (!executable || !allowed.has(executable)) {
    throw new Error(`Generic ${label} command executable is not allowed in the offline sandbox`);
  }
  return normalized;
}

function validExitCode(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error('Generic reproduction exit codes must be integers from 0 to 255');
  }
  return value;
}

function gateTitle(id: SandboxReproductionGateId): string {
  if (id === 'baseline') return 'Baseline integrity';
  if (id === 'control') return 'Negative control';
  return 'Signal reproduction';
}
