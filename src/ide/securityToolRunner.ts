import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DurableStore } from './durableStore.js';
import type { OrchestrationSnapshot, OrchestrationSpec } from './orchestrator.js';
import type { SecurityFinding } from './protocol.js';
import type { ReproductionOrchestrator } from './sandboxReproduction.js';
import { stableHash } from './scopePolicy.js';
import type { SecurityAdapterId } from './securityAdapters.js';
import {
  type ImportedSecurityFindings,
  importSarifFindings,
  securityAdapterDescriptor,
} from './securityAdapters.js';

const MAX_WAIT_MS = 30 * 60 * 1_000;
const MAX_OUTPUT = 5 * 1024 * 1024;
const MAX_ARGS = 64;

export interface SecurityToolRunPlan {
  id: string;
  adapter: SecurityAdapterId;
  image: string;
  target: string;
  args: string[];
  executable: string;
  networkMode: 'none' | 'restricted';
  allowedHosts: string[];
  planHash: string;
  createdAt: string;
  expiresAt: string;
  statement: string;
}

export interface SecurityToolRunResult {
  id: string;
  planId: string;
  planHash: string;
  adapter: SecurityAdapterId;
  orchestrationRunId: string;
  status: 'completed' | 'failed';
  imported?: ImportedSecurityFindings;
  findings: SecurityFinding[];
  output: string;
  completedAt: string;
}

type StoredSecurityToolPlan = Omit<SecurityToolRunPlan, 'planHash'>;

export interface SecurityToolRunnerOptions {
  workspaceRoot: string;
  store: DurableStore;
  orchestrator: ReproductionOrchestrator;
  now?: () => Date;
}

export interface CreateSecurityToolPlanInput {
  adapter: SecurityAdapterId;
  image: string;
  target: string;
  args: string[];
  networkMode?: 'none' | 'restricted';
  allowedHosts?: string[];
  approvedExternalAccess?: true;
}

export class GovernedSecurityToolRunner {
  private readonly now: () => Date;

  constructor(private readonly options: SecurityToolRunnerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async createPlan(input: CreateSecurityToolPlanInput): Promise<SecurityToolRunPlan> {
    const descriptor = securityAdapterDescriptor(input.adapter);
    const image = validateImage(input.image);
    const target = validateTarget(this.options.workspaceRoot, input.target);
    const args = validateArgs(input.args);
    const networkMode = input.networkMode ?? 'none';
    const allowedHosts = validateHosts(input.allowedHosts ?? []);
    if (networkMode === 'restricted' && input.approvedExternalAccess !== true) {
      throw new Error('Restricted adapter execution requires explicit external-access approval');
    }
    if (networkMode === 'restricted' && allowedHosts.length === 0) {
      throw new Error('Restricted adapter execution requires at least one allowed host');
    }
    const createdAt = this.now();
    const unsigned = {
      id: `adapter-plan-${randomUUID()}`,
      adapter: input.adapter,
      image,
      target,
      args,
      executable: descriptor.execution.executable,
      networkMode,
      allowedHosts,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 15 * 60 * 1_000).toISOString(),
      statement:
        'This plan executes one approved external security adapter in a governed Docker worker and imports only bounded SARIF evidence. It never promotes a finding to a verified vulnerability.',
    };
    const plan = { ...unsigned, planHash: stableHash(unsigned) };
    await this.options.store.writeJson('security-adapter-plans', plan.id, unsigned);
    return plan;
  }

  async execute(plan: SecurityToolRunPlan, approved: true): Promise<SecurityToolRunResult> {
    if (approved !== true) throw new Error('Explicit operator approval is required');
    const stored = await this.options.store.readJson<StoredSecurityToolPlan>(
      'security-adapter-plans',
      plan.id,
    );
    if (!stored) throw new Error('Security adapter plan was not found or expired');
    const expectedHash = stableHash(stored);
    if (expectedHash !== plan.planHash)
      throw new Error('Security adapter plan hash does not match');
    const approvedPlan: SecurityToolRunPlan = { ...stored, planHash: expectedHash };
    if (Date.parse(approvedPlan.expiresAt) <= this.now().getTime())
      throw new Error('Security adapter plan expired');
    const descriptor = securityAdapterDescriptor(approvedPlan.adapter);
    if (approvedPlan.executable !== descriptor.execution.executable) {
      throw new Error('Security adapter executable changed after planning');
    }
    const spec = adapterSpec(approvedPlan);
    const run = await this.options.orchestrator.start(spec);
    const completed = await waitForTerminal(this.options.orchestrator, run.id);
    const task = completed.tasks[0];
    const output = (task?.output ?? '').slice(0, MAX_OUTPUT);
    let imported: ImportedSecurityFindings | undefined;
    let status: SecurityToolRunResult['status'] =
      completed.status === 'succeeded' ? 'completed' : 'failed';
    if (status === 'completed') {
      try {
        const sarif = await parseSarifOutput(output, task?.artifactDirectory);
        imported = importSarifFindings(
          approvedPlan.adapter,
          sarif,
          `${approvedPlan.adapter}-runtime.sarif`,
          this.now(),
        );
      } catch {
        status = 'failed';
      }
    }
    const result: SecurityToolRunResult = {
      id: `adapter-run-${randomUUID()}`,
      planId: approvedPlan.id,
      planHash: approvedPlan.planHash,
      adapter: approvedPlan.adapter,
      orchestrationRunId: completed.id,
      status,
      ...(imported ? { imported } : {}),
      findings: imported?.findings ?? [],
      output,
      completedAt: this.now().toISOString(),
    };
    await this.options.store.writeJson('security-adapter-runs', result.id, result);
    return result;
  }
}

function adapterSpec(plan: SecurityToolRunPlan): OrchestrationSpec {
  const target = `/workspace/${plan.target}`;
  const command = [plan.executable, ...plan.args.map((arg) => arg.replaceAll('${target}', target))];
  return {
    image: plan.image,
    maxParallel: 1,
    cpuPerWorker: 1,
    memoryMbPerWorker: 1_024,
    artifactMbPerWorker: 64,
    networkMode: plan.networkMode,
    ...(plan.networkMode === 'restricted'
      ? {
          approvedExternalAccess: true,
          egressPolicy: { allowedHosts: plan.allowedHosts, allowedPorts: [80, 443] },
        }
      : {}),
    scheduleStrategy: 'balanced',
    leaseSeconds: 60,
    agentInstances: [
      {
        id: 'security-adapter',
        capabilities: ['security', 'reproduction'],
        maxConcurrent: 1,
        cpuCapacity: 1,
        memoryMbCapacity: 1_024,
      },
    ],
    tasks: [
      {
        id: 'adapter-scan',
        title: `Run ${plan.adapter} adapter`,
        command,
        timeoutSeconds: 1_800,
        requiredCapabilities: ['security'],
        priority: 100,
        estimatedSeconds: 60,
      },
    ],
  };
}

function validateImage(image: string): string {
  if (
    !image ||
    image.length > 255 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image) ||
    image.includes('..')
  ) {
    throw new Error('Security adapter image is invalid');
  }
  return image;
}

function validateTarget(workspaceRoot: string, target: string): string {
  const value = target.trim().replaceAll('\\', '/');
  const absolute = resolve(workspaceRoot, value);
  const relativeTarget = relative(resolve(workspaceRoot), absolute).replaceAll('\\', '/') || '.';
  if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
    throw new Error('Security adapter target must stay inside the workspace');
  }
  return relativeTarget;
}

function validateArgs(args: string[]): string[] {
  if (!Array.isArray(args) || args.length > MAX_ARGS)
    throw new Error('Security adapter args are bounded to 64 entries');
  return args.map((arg) => {
    if (
      typeof arg !== 'string' ||
      !arg ||
      arg.length > 2_000 ||
      [...arg].some((char) => char.charCodeAt(0) < 32)
    ) {
      throw new Error('Security adapter args contain an invalid value');
    }
    if (arg.includes('..') || arg.includes('docker.sock'))
      throw new Error('Security adapter args contain an unsafe path');
    return arg;
  });
}

function validateHosts(hosts: string[]): string[] {
  return [...new Set(hosts)].map((host) => {
    if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host) || host.includes('..'))
      throw new Error('Security adapter host is invalid');
    return host.toLowerCase();
  });
}

async function parseSarifOutput(output: string, artifactDirectory?: string): Promise<unknown> {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    if (artifactDirectory) {
      for (const filename of ['results.sarif', 'results.json']) {
        try {
          return JSON.parse(await readFile(join(artifactDirectory, filename), 'utf8'));
        } catch {
          // Try the next bounded artifact name.
        }
      }
    }
    throw new Error('Adapter output did not contain SARIF JSON');
  }
}

async function waitForTerminal(
  orchestrator: Pick<ReproductionOrchestrator, 'get'>,
  runId: string,
): Promise<OrchestrationSnapshot> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const snapshot = orchestrator.get(runId, true);
    if (!snapshot) throw new Error(`Security adapter run disappeared: ${runId}`);
    if (
      snapshot.status === 'succeeded' ||
      snapshot.status === 'failed' ||
      snapshot.status === 'cancelled'
    )
      return snapshot;
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, 250);
      timer.unref();
    });
  }
  throw new Error('Security adapter exceeded its bounded execution window');
}
