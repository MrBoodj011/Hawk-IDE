import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { load as loadConfig } from '../config/config.js';
import {
  type DistributedScheduleDecision,
  type DistributedScheduleStrategy,
  type DistributedTaskCandidate,
  createAgentInstances,
  scheduleDistributedAgents,
} from './distributedScheduler.js';

const execFileAsync = promisify(execFile);
const DEFAULT_IMAGE = 'hawk-worker:local';
const DEFAULT_CPU = 1;
const DEFAULT_MEMORY_MB = 2_048;
const MIN_MEMORY_MB = 512;
const MAX_MEMORY_MB = 8_192;
const PROVIDER_ENV = [
  'HAWK_IDE_BACKEND',
  'HAWK_IDE_MODEL',
  'HAWK_IDE_API_KEY',
  'HAWK_IDE_BASE_URL',
] as const;

export type AiDockerNetworkMode = 'provider-egress' | 'none';

export interface AiDockerBatchConfiguration {
  image?: string;
  strategy?: DistributedScheduleStrategy;
  cpuPerLane?: number;
  memoryMbPerLane?: number;
  networkMode?: AiDockerNetworkMode;
}

export interface AiDockerLaneRequest {
  id: string;
  role: string;
  capabilities: string[];
}

export interface AiDockerExecution {
  kind: 'docker';
  /**
   * The scheduler lane this immutable placement belongs to. Optional only for
   * backwards compatibility with sessions persisted before direct lane binding
   * was introduced; all new plans always populate it.
   */
  laneId?: string;
  batchId: string;
  image: string;
  resolvedImage: string;
  instanceId: string;
  schedulingScore: number;
  schedulingReasons: string[];
  criticalPathSeconds: number;
  cpu: number;
  memoryMb: number;
  networkMode: AiDockerNetworkMode;
  /** Scheduler metadata is persisted with each lane for batch/status clients. */
  strategy?: DistributedScheduleStrategy;
  dockerVersion?: string;
}

export interface AiDockerBatchPlan {
  strategy: DistributedScheduleStrategy;
  dockerVersion?: string;
  executions: Map<string, AiDockerExecution>;
}

export interface AiDockerWorkerSession {
  id: string;
  workerRoot: string;
  agentSessionPath: string;
  execution: AiDockerExecution;
}

export interface AiWorkerLaunchPlan {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd: string;
  requestWorkspaceRoot: string;
  requestAgentSessionPath: string;
  cancel?: () => Promise<void>;
}

export interface AiDockerScheduler {
  planBatch(
    batchId: string,
    lanes: AiDockerLaneRequest[],
    configuration?: AiDockerBatchConfiguration,
  ): Promise<AiDockerBatchPlan>;
  launch(session: AiDockerWorkerSession): Promise<AiWorkerLaunchPlan>;
}

interface DockerCommandRunner {
  exec(args: string[]): Promise<{ stdout: string; stderr: string }>;
}

interface DockerSchedulerOptions {
  dockerCommand?: string;
  daemonEntry: string;
  daemonEnvironment?: NodeJS.ProcessEnv;
  runner?: DockerCommandRunner;
}

/**
 * Direct Docker execution backend for Hawk's parallel AI lanes.
 *
 * The scheduler decides placement before any lane starts. Each lane receives a
 * writable detached worktree and agent-memory mount, while the daemon bundle is
 * mounted read-only. The container has no Docker socket and no host workspace
 * mount, so it cannot escape its exact review sandbox through Hawk tools.
 */
export class HawkAiDockerScheduler implements AiDockerScheduler {
  private readonly dockerCommand: string;
  private readonly daemonEntry: string;
  private readonly daemonEnvironment: NodeJS.ProcessEnv;
  private readonly runner: DockerCommandRunner;

  constructor(options: DockerSchedulerOptions) {
    this.dockerCommand = options.dockerCommand ?? 'docker';
    this.daemonEntry = resolve(options.daemonEntry);
    this.daemonEnvironment = configuredProviderEnvironment(options.daemonEnvironment ?? {});
    this.runner =
      options.runner ??
      ({
        exec: async (args) => {
          const result = await execFileAsync(this.dockerCommand, args, {
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          });
          return { stdout: result.stdout, stderr: result.stderr };
        },
      } satisfies DockerCommandRunner);
  }

  async planBatch(
    batchId: string,
    lanes: AiDockerLaneRequest[],
    configuration: AiDockerBatchConfiguration = {},
  ): Promise<AiDockerBatchPlan> {
    const image = normalizeImage(configuration.image);
    const strategy = configuration.strategy ?? 'latency';
    const cpu = boundedNumber(configuration.cpuPerLane, DEFAULT_CPU, 0.25, 4);
    const memoryMb = Math.round(
      boundedNumber(configuration.memoryMbPerLane, DEFAULT_MEMORY_MB, MIN_MEMORY_MB, MAX_MEMORY_MB),
    );
    const networkMode = configuration.networkMode ?? 'provider-egress';
    let version = '';
    try {
      version = (
        await this.runner.exec(['version', '--format', '{{.Server.Version}}'])
      ).stdout.trim();
    } catch (error) {
      throw new Error(`Docker is required for parallel Hawk AI lanes: ${errorMessage(error)}`);
    }
    if (!version) throw new Error('Docker is required for parallel Hawk AI lanes.');
    let resolvedImage = '';
    try {
      resolvedImage = (
        await this.runner.exec(['image', 'inspect', '--format', '{{.Id}}', image])
      ).stdout.trim();
    } catch (error) {
      throw new Error(
        `Hawk Docker image "${image}" is not available. Build it with "docker build -t ${image} docker/hawk-worker". ${errorMessage(error)}`,
      );
    }
    if (!resolvedImage)
      throw new Error(`Docker image "${image}" did not resolve to an immutable ID.`);

    const tasks: DistributedTaskCandidate[] = lanes.map((lane, index) => ({
      id: lane.id,
      dependsOn: [],
      requiredCapabilities: ['code'],
      preferredCapabilities: lane.capabilities,
      priority: lanes.length - index,
      estimatedSeconds: 600,
      cpu,
      memoryMb,
    }));
    const instances = createAgentInstances(lanes.length, cpu, memoryMb);
    const decisions = scheduleDistributedAgents(tasks, tasks, instances, strategy, lanes.length);
    if (decisions.length !== lanes.length) {
      throw new Error(
        `Docker scheduler placed ${decisions.length}/${lanes.length} Hawk AI lanes; no containers were started.`,
      );
    }
    return {
      strategy,
      dockerVersion: version,
      executions: new Map(
        decisions.map((decision) => [
          decision.taskId,
          executionFromDecision(
            batchId,
            image,
            resolvedImage,
            cpu,
            memoryMb,
            networkMode,
            strategy,
            version,
            decision,
          ),
        ]),
      ),
    };
  }

  async launch(session: AiDockerWorkerSession): Promise<AiWorkerLaunchPlan> {
    const execution = session.execution;
    validatePersistedExecution(execution);
    if (execution.laneId && execution.laneId !== session.id) {
      throw new Error(
        `Refusing to launch Docker AI lane ${execution.laneId} for session ${session.id}; scheduler placement is bound to a different session.`,
      );
    }
    const containerName = containerNameFor(session.id);
    try {
      await this.runner.exec(['rm', '--force', containerName]);
    } catch {
      // A fresh session has no prior container. On recovery this removes an
      // orphaned attempt before the durable worktree is resumed.
    }
    const agentDirectory = dirname(session.agentSessionPath);
    const agentFile = basename(session.agentSessionPath);
    const args = [
      'run',
      '--rm',
      '-i',
      '--pull=never',
      '--name',
      containerName,
      '--label',
      'dev.hawk.runtime=ai-session',
      '--label',
      `dev.hawk.session=${session.id}`,
      '--label',
      `dev.hawk.batch=${execution.batchId}`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '256',
      '--cpus',
      String(execution.cpu),
      '--memory',
      `${execution.memoryMb}m`,
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=256m',
      '--mount',
      bindMount(session.workerRoot, '/workspace', false),
      '--mount',
      bindMount(agentDirectory, '/hawk-agent', false),
      '--mount',
      bindMount(this.daemonEntry, '/hawk-ide-daemon.js', true),
      '--workdir',
      '/workspace',
      '--network',
      execution.networkMode === 'none' ? 'none' : 'bridge',
    ];
    if (execution.networkMode === 'provider-egress') {
      args.push('--add-host', 'host.docker.internal:host-gateway');
    }
    const hostUser = dockerHostUser();
    if (hostUser) args.push('--user', hostUser);
    const env = dockerProviderEnvironment(this.daemonEnvironment);
    for (const name of PROVIDER_ENV) {
      if (env[name]) args.push('--env', name);
    }
    args.push(execution.resolvedImage, 'node', '/hawk-ide-daemon.js', '--ai-worker');
    return {
      command: this.dockerCommand,
      args,
      env: { ...process.env, ...env },
      cwd: session.workerRoot,
      requestWorkspaceRoot: '/workspace',
      requestAgentSessionPath: `/hawk-agent/${agentFile}`,
      cancel: async () => {
        try {
          await this.runner.exec(['rm', '--force', containerName]);
        } catch {
          // docker run --rm may already have removed the container.
        }
      },
    };
  }
}

function executionFromDecision(
  batchId: string,
  image: string,
  resolvedImage: string,
  cpu: number,
  memoryMb: number,
  networkMode: AiDockerNetworkMode,
  strategy: DistributedScheduleStrategy,
  dockerVersion: string,
  decision: DistributedScheduleDecision,
): AiDockerExecution {
  return {
    kind: 'docker',
    laneId: decision.taskId,
    batchId,
    image,
    resolvedImage,
    instanceId: decision.instanceId,
    schedulingScore: decision.score,
    schedulingReasons: [...decision.reasons],
    criticalPathSeconds: decision.criticalPathSeconds,
    cpu,
    memoryMb,
    networkMode,
    strategy,
    dockerVersion: dockerVersion || undefined,
  };
}

function dockerProviderEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PROVIDER_ENV) {
    const value = source[name];
    if (value) env[name] = value;
  }
  const baseUrl = env.HAWK_IDE_BASE_URL;
  if (baseUrl) env.HAWK_IDE_BASE_URL = rewriteLoopbackUrl(baseUrl);
  else if (env.HAWK_IDE_BACKEND === 'ollama') {
    env.HAWK_IDE_BASE_URL = 'http://host.docker.internal:11434';
  } else if (env.HAWK_IDE_BACKEND === 'lmstudio') {
    env.HAWK_IDE_BASE_URL = 'http://host.docker.internal:1234/v1';
  }
  return env;
}

function configuredProviderEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  try {
    const config = loadConfig();
    if (!env.HAWK_IDE_BACKEND && config.backend) env.HAWK_IDE_BACKEND = config.backend;
    if (!env.HAWK_IDE_MODEL && config.model) env.HAWK_IDE_MODEL = config.model;
    if (!env.HAWK_IDE_BASE_URL && config.base_url) env.HAWK_IDE_BASE_URL = config.base_url;
    const indirectKey = config.api_key_env ? env[config.api_key_env] : undefined;
    const standardKey = providerApiKey(env.HAWK_IDE_BACKEND ?? config.backend, env);
    const apiKey = config.api_key || indirectKey || standardKey;
    if (!env.HAWK_IDE_API_KEY && apiKey) env.HAWK_IDE_API_KEY = apiKey;
  } catch {
    // The worker will return the same actionable provider/config error as a
    // host session; Docker planning itself remains independent from LLM setup.
  }
  return env;
}

function providerApiKey(backend: string, env: NodeJS.ProcessEnv): string | undefined {
  const names: Record<string, string[]> = {
    openai: ['OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    groq: ['GROQ_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    deepseek: ['DEEPSEEK_API_KEY'],
  };
  return names[backend]?.map((name) => env[name]).find(Boolean);
}

function rewriteLoopbackUrl(value: string): string {
  try {
    const url = new URL(value);
    if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      url.hostname = 'host.docker.internal';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

function bindMount(source: string, target: string, readonly: boolean): string {
  const normalized = resolve(source).replaceAll('\\', '/');
  return `type=bind,source=${normalized},target=${target}${readonly ? ',readonly' : ''}`;
}

function containerNameFor(sessionId: string): string {
  const safe = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '')
    .slice(0, 24);
  return `hawk-ai-${safe || randomUUID().slice(0, 12)}`;
}

function dockerHostUser(): string | undefined {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  return uid !== undefined && gid !== undefined && uid > 0 ? `${uid}:${gid}` : undefined;
}

function normalizeImage(value: string | undefined): string {
  const image = value?.trim() || DEFAULT_IMAGE;
  if (image.length > 300 || /[\s"'`$;&|<>]/.test(image)) {
    throw new Error('Invalid Hawk Docker image reference.');
  }
  return image;
}

function validatePersistedExecution(execution: AiDockerExecution): void {
  if (
    execution.laneId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(execution.laneId)
  ) {
    throw new Error('Refusing a Docker AI session whose scheduler lane identity is invalid.');
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(execution.resolvedImage)) {
    throw new Error('Refusing a Docker AI session whose immutable image ID is invalid.');
  }
  if (
    !Number.isFinite(execution.cpu) ||
    execution.cpu < 0.25 ||
    execution.cpu > 4 ||
    !Number.isInteger(execution.memoryMb) ||
    execution.memoryMb < MIN_MEMORY_MB ||
    execution.memoryMb > MAX_MEMORY_MB
  ) {
    throw new Error('Refusing a Docker AI session whose persisted resource limits are invalid.');
  }
  if (!['provider-egress', 'none'].includes(execution.networkMode)) {
    throw new Error('Refusing a Docker AI session whose persisted network policy is invalid.');
  }
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value ?? fallback));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
