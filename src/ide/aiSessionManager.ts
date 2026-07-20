import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type {
  AiApplyRequest,
  AiCheckpointRequest,
  AiCheckpointSummary,
  AiCreateSessionRequest,
  AiDiffResponse,
  AiDiffSummary,
  AiEventPage,
  AiMergeBatchRequest,
  AiMergeBatchResponse,
  AiMergeCandidateScore,
  AiParallelBatchRequest,
  AiParallelBatchResponse,
  AiRestoreCheckpointRequest,
  AiRunTestsRequest,
  AiSemanticMergeConflict,
  AiSemanticMergePlan,
  AiSessionEvent,
  AiSessionStatus,
  AiSessionSummary,
  AiTestGate,
  AiTestResult,
} from './aiProtocol.js';
import { buildSemanticMerge } from './semanticMerge.js';

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_TEXT = 100_000;
const MAX_TEST_OUTPUT = 200_000;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_FILE_VERSION = 1;

interface WorkerLaunch {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface AiSessionManagerOptions {
  workspaceRoot: string;
  storageRoot?: string;
  workerLaunch?: WorkerLaunch;
  now?: () => Date;
}

interface TouchedFile {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
}

interface StoredCheckpoint extends AiCheckpointSummary {
  patchPath: string;
}

interface StoredAiSession {
  version: number;
  id: string;
  title: string;
  prompt: string;
  status: AiSessionStatus;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  repoRoot: string;
  workspaceRelative: string;
  worktreeRoot: string;
  workerRoot: string;
  snapshotCommit: string;
  patchPath: string;
  agentSessionPath: string;
  lastEventId: number;
  provider?: string;
  model?: string;
  background?: boolean;
  autoResume?: boolean;
  resumeCount?: number;
  error?: string;
  diff?: AiDiffSummary;
  checkpoints?: StoredCheckpoint[];
  touchedFiles: TouchedFile[];
  testGates: AiTestGate[];
  testResults: AiTestResult[];
}

interface WorkerEvent {
  type?: string;
  event?: {
    type?: string;
    text?: string;
    tool?: string;
    durationMs?: number;
  };
  provider?: string;
  model?: string;
  ok?: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  cancelled: boolean;
}

interface SeedFile {
  path: string;
  content: string | null;
}

interface InternalCreateOptions {
  seedFiles?: SeedFile[];
  preparationEvents?: string[];
}

interface SemanticMergePreparation {
  seedFiles: SeedFile[];
  plan: AiSemanticMergePlan;
  context: string;
}

/**
 * Durable control plane for native Hawk AI coding sessions. Every run happens
 * in a detached worktree based on a snapshot of the operator's current files.
 * Only an explicit, hash-bound Apply call can move the reviewed patch back.
 */
export class AiSessionManager {
  private readonly workspaceRoot: string;
  private readonly storageRoot: string;
  private readonly sessionsRoot: string;
  private readonly patchesRoot: string;
  private readonly agentSessionsRoot: string;
  private readonly worktreesRoot: string;
  private readonly workerLaunch: WorkerLaunch;
  private readonly now: () => Date;
  private readonly workers = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly testControllers = new Map<string, AbortController>();
  private readonly saveQueues = new Map<string, Promise<void>>();

  constructor(options: AiSessionManagerOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    const workspaceKey = createHash('sha256')
      .update(this.workspaceRoot.toLowerCase())
      .digest('hex')
      .slice(0, 20);
    this.storageRoot =
      options.storageRoot ??
      join(homedir(), '.hawk', 'ide', 'workspaces', workspaceKey, 'ai-sessions');
    this.sessionsRoot = join(this.storageRoot, 'sessions');
    this.patchesRoot = join(this.storageRoot, 'patches');
    this.agentSessionsRoot = join(this.storageRoot, 'agent');
    this.worktreesRoot = join(tmpdir(), 'hawk-ai-worktrees', workspaceKey);
    this.workerLaunch = options.workerLaunch ?? defaultWorkerLaunch();
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.sessionsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.patchesRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.agentSessionsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.worktreesRoot, { recursive: true, mode: 0o700 }),
    ]);
    const sessions = await this.loadAll();
    for (const session of sessions) {
      if (session.status === 'testing') {
        session.status = 'awaiting-review';
        session.error = undefined;
        session.updatedAt = this.timestamp();
        await this.save(session);
        await this.addEvent(
          session,
          'status',
          'Hawk recovered the isolated task after restart. Interrupted tests were not assumed to pass.',
        );
      } else if (session.status === 'preparing' || session.status === 'running') {
        session.status = 'paused';
        session.error = undefined;
        session.updatedAt = this.timestamp();
        await this.save(session);
        await this.addEvent(
          session,
          'status',
          'Hawk recovered this task after restart. Its worktree and agent memory are intact.',
        );
        if (session.background && session.autoResume) {
          try {
            await ensureWorktree(session);
            session.resumeCount = (session.resumeCount ?? 0) + 1;
            await this.startWorker(
              session,
              `Resume the interrupted background task and finish it safely. Original objective:\n${session.prompt}`,
              'Recovery: Hawk restarted. Inspect the current isolated worktree and saved agent session before continuing.',
            );
            await this.addEvent(session, 'status', 'Background task resumed automatically.');
          } catch (err) {
            session.status = 'paused';
            session.error = errorMessage(err);
            await this.save(session);
            await this.addEvent(
              session,
              'error',
              `Automatic recovery could not start: ${session.error}`,
            );
          }
        }
      }
    }
  }

  async dispose(): Promise<void> {
    for (const controller of this.testControllers.values()) controller.abort();
    this.testControllers.clear();
    for (const [id, child] of this.workers) {
      const session = await this.load(id).catch(() => undefined);
      if (session) {
        session.status = 'paused';
        session.updatedAt = this.timestamp();
        await this.save(session);
        await this.addEvent(
          session,
          'status',
          'Hawk paused this task for shutdown. Resume will continue from saved agent memory.',
        );
      }
      if (!child.killed) child.kill();
    }
    this.workers.clear();
    await Promise.allSettled(this.saveQueues.values());
  }

  async create(
    input: AiCreateSessionRequest,
    internal: InternalCreateOptions = {},
  ): Promise<AiSessionSummary> {
    const prompt = validatePrompt(input.prompt);
    const id = randomUUID();
    const createdAt = this.timestamp();
    const prepared = await this.prepareWorktree(id);
    await seedPreparedWorktree(prepared.worktreeRoot, internal.seedFiles ?? []);
    const session: StoredAiSession = {
      version: SESSION_FILE_VERSION,
      id,
      title: summarizeTitle(prompt),
      prompt,
      status: 'preparing',
      createdAt,
      updatedAt: createdAt,
      workspaceRoot: this.workspaceRoot,
      repoRoot: prepared.repoRoot,
      workspaceRelative: prepared.workspaceRelative,
      worktreeRoot: prepared.worktreeRoot,
      workerRoot: prepared.workerRoot,
      snapshotCommit: prepared.snapshotCommit,
      patchPath: join(this.patchesRoot, `${id}.patch`),
      agentSessionPath: join(this.agentSessionsRoot, `${id}.json`),
      lastEventId: 0,
      checkpoints: [],
      touchedFiles: [],
      testGates: await detectTestGates(prepared.workerRoot),
      testResults: [],
      background: input.background === true,
      autoResume: input.background === true && input.autoResume !== false,
      resumeCount: 0,
    };
    await this.save(session);
    await this.addEvent(session, 'status', 'Isolated worktree ready. Starting Hawk AI.');
    for (const event of internal.preparationEvents ?? []) {
      await this.addEvent(session, 'plan', event);
    }
    await this.startWorker(session, prompt, input.context ?? '');
    return publicSession(session);
  }

  async createParallelBatch(input: AiParallelBatchRequest): Promise<AiParallelBatchResponse> {
    const objective = validatePrompt(input.objective);
    const laneCount = Math.max(2, Math.min(6, Math.floor(input.lanes ?? 3)));
    const roles = [
      {
        name: 'Architecture',
        instruction:
          'Map the relevant system, identify root causes and implement the smallest coherent solution.',
      },
      {
        name: 'Implementation',
        instruction:
          'Implement a production-ready solution with strong typing, error handling and maintainability.',
      },
      {
        name: 'Verification',
        instruction:
          'Approach the task as an adversarial reviewer, implement the safest solution and strengthen regression coverage.',
      },
      {
        name: 'Performance',
        instruction:
          'Optimize for latency, memory and large-repository behavior without weakening correctness.',
      },
      {
        name: 'Security',
        instruction:
          'Trace trust boundaries and implement the solution with secure defaults and explicit approvals.',
      },
      {
        name: 'Minimal patch',
        instruction:
          'Produce the smallest reviewable patch that fully meets the objective and preserves compatibility.',
      },
    ].slice(0, laneCount);
    const sessions: AiSessionSummary[] = [];
    for (const role of roles) {
      sessions.push(
        await this.create({
          prompt: `[${role.name} lane] ${objective}\n\nLane focus: ${role.instruction}`,
          context: input.context,
          background: true,
          autoResume: true,
        }),
      );
    }
    return {
      batchId: randomUUID(),
      createdAt: this.timestamp(),
      sessions,
    };
  }

  async mergeBatch(input: AiMergeBatchRequest): Promise<AiMergeBatchResponse> {
    const ids = [...new Set(input.sessionIds ?? [])].slice(0, 6);
    if (ids.length < 2) throw new Error('Select at least two completed Hawk lanes to merge.');
    const candidates = await Promise.all(ids.map((id) => this.load(id)));
    for (const candidate of candidates) {
      if (candidate.status !== 'awaiting-review' || !candidate.diff) {
        throw new Error(`Lane ${candidate.title} is not ready for intelligent merge.`);
      }
      await ensureWorktree(candidate);
    }
    const scores = candidates
      .map(scoreMergeCandidate)
      .sort((left, right) => right.score - left.score);
    const rankedCandidates = scores
      .map((score) => candidates.find((candidate) => candidate.id === score.sessionId))
      .filter((candidate): candidate is StoredAiSession => Boolean(candidate));
    const semantic = await prepareSemanticMerge(rankedCandidates);
    const patches: string[] = [];
    let totalBytes = 0;
    for (const score of scores) {
      const candidate = candidates.find((item) => item.id === score.sessionId);
      if (!candidate?.diff) continue;
      const patch = await readFile(candidate.patchPath, 'utf8');
      const remaining = Math.max(0, 1_500_000 - totalBytes);
      if (remaining === 0) break;
      const boundedPatch = patch.slice(0, remaining);
      totalBytes += boundedPatch.length;
      patches.push(
        [
          `CANDIDATE ${candidate.id}`,
          `Title: ${candidate.title}`,
          `Score: ${score.score} (${score.reasons.join('; ')})`,
          `Diff: ${candidate.diff.files} files, +${candidate.diff.insertions} -${candidate.diff.deletions}`,
          `Tests: ${candidate.testResults.map((result) => `${result.label}=${result.status}`).join(', ') || 'not run'}`,
          'PATCH:',
          boundedPatch,
        ].join('\n'),
      );
    }
    const objective =
      input.objective?.trim() ||
      candidates[0]?.prompt.replace(/^\[[^\]]+ lane\]\s*/, '') ||
      'Synthesize the strongest correct implementation.';
    const mergeSession = await this.create(
      {
        prompt: [
          '[AST semantic merge lane]',
          objective,
          '',
          `Hawk already transplanted ${semantic.plan.automaticallyMergedUnits.length} compatible file/symbol change(s) into this isolated worktree using the TypeScript AST.`,
          `There are ${semantic.plan.conflicts.length} explicit semantic conflict(s). Preserve the seeded compatible edits, resolve every listed conflict deliberately, then add or update regression coverage.`,
          'Compare behavior and test evidence. Do not concatenate patches or replace a seeded file with one candidate wholesale unless the semantic plan requires it.',
          'The final output must be one coherent, compiling, reviewable diff.',
        ].join('\n'),
        context: [input.context ?? '', semantic.context, ...patches]
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 1_600_000),
        background: true,
        autoResume: true,
      },
      {
        seedFiles: semantic.seedFiles,
        preparationEvents: [
          `AST semantic pre-merge seeded ${semantic.plan.automaticallyMergedUnits.length} compatible change(s) across ${semantic.plan.filesAnalyzed} file(s). ${semantic.plan.conflicts.length} conflict(s) remain for explicit resolution.`,
        ],
      },
    );
    return { mergeSession, candidates: scores, semanticMerge: semantic.plan };
  }

  async continue(id: string, input: AiCreateSessionRequest): Promise<AiSessionSummary> {
    const session = await this.load(id);
    if (this.workers.has(id) || session.status === 'running' || session.status === 'testing') {
      throw new Error('This Hawk session is already busy.');
    }
    if (session.status !== 'awaiting-review' && session.status !== 'failed') {
      throw new Error(`A ${session.status} session cannot accept another message.`);
    }
    await ensureWorktree(session);
    const prompt = validatePrompt(input.prompt);
    session.prompt = prompt;
    session.title = summarizeTitle(prompt);
    session.error = undefined;
    session.diff = undefined;
    session.touchedFiles = [];
    session.testResults = [];
    await rm(session.patchPath, { force: true });
    await this.save(session);
    await this.addEvent(session, 'status', 'Continuing the task in the same isolated worktree.');
    await this.startWorker(session, prompt, input.context ?? '');
    return publicSession(session);
  }

  async list(limit = 30): Promise<AiSessionSummary[]> {
    const sessions = await this.loadAll();
    return sessions
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map(publicSession);
  }

  async get(id: string): Promise<AiSessionSummary> {
    return publicSession(await this.load(id));
  }

  async events(id: string, after = 0): Promise<AiEventPage> {
    const session = await this.load(id);
    let events: AiSessionEvent[] = [];
    try {
      const body = await readFile(this.eventsPath(id), 'utf8');
      events = body
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AiSessionEvent)
        .filter((event) => event.id > after)
        .slice(0, 500);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return {
      events,
      next: events.at(-1)?.id ?? after,
      session: publicSession(session),
    };
  }

  async diff(id: string): Promise<AiDiffResponse> {
    const session = await this.load(id);
    if (!session.diff) throw new Error('This session does not have a reviewable diff yet.');
    return {
      sessionId: id,
      patch: await readFile(session.patchPath, 'utf8'),
      summary: session.diff,
    };
  }

  async runTests(id: string, request: AiRunTestsRequest): Promise<AiSessionSummary> {
    if (request.approved !== true) throw new Error('Operator approval is required to run tests.');
    const session = await this.load(id);
    if (session.status !== 'awaiting-review') {
      throw new Error('Tests can only run when a session is awaiting review.');
    }
    await ensureWorktree(session);
    const selected = request.gateIds.map((gateId) => {
      const gate = session.testGates.find((candidate) => candidate.id === gateId);
      if (!gate) throw new Error(`Unknown or unavailable test gate: ${gateId}`);
      return gate;
    });
    if (selected.length === 0) throw new Error('Select at least one test gate.');

    const controller = new AbortController();
    this.testControllers.set(id, controller);
    session.status = 'testing';
    session.testResults = [];
    session.updatedAt = this.timestamp();
    await this.save(session);
    await this.addEvent(session, 'status', `Running ${selected.length} approved test gate(s).`);
    try {
      for (const gate of selected) {
        if (controller.signal.aborted) break;
        await this.addEvent(session, 'status', `Test gate: ${gate.label}`);
        const result = await runCommand(gate.command, gate.args, {
          cwd: session.workerRoot,
          timeoutMs: TEST_TIMEOUT_MS,
          signal: controller.signal,
          env: process.env,
        });
        const status: AiTestResult['status'] = result.cancelled
          ? 'cancelled'
          : result.exitCode === 0
            ? 'passed'
            : 'failed';
        const output = boundText(
          [result.stdout, result.stderr].filter(Boolean).join('\n'),
          MAX_TEST_OUTPUT,
        );
        session.testResults.push({
          gateId: gate.id,
          label: gate.label,
          status,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          output,
        });
        await this.addEvent(session, 'test-output', `${gate.label}: ${status}\n${output}`.trim());
        if (status !== 'passed') break;
      }
    } finally {
      this.testControllers.delete(id);
      session.status = 'awaiting-review';
      session.updatedAt = this.timestamp();
      await this.save(session);
      await this.addEvent(session, 'status', testSummary(session.testResults));
    }
    return publicSession(session);
  }

  async cancelTests(id: string): Promise<AiSessionSummary> {
    const session = await this.load(id);
    const controller = this.testControllers.get(id);
    if (controller && !controller.signal.aborted) controller.abort();
    return publicSession(session);
  }

  async checkpoint(id: string, request: AiCheckpointRequest = {}): Promise<AiSessionSummary> {
    const session = await this.load(id);
    if (session.status !== 'awaiting-review' || !session.diff) {
      throw new Error('Create a checkpoint only when a reviewable Hawk diff is ready.');
    }
    await ensureWorktree(session);
    const checkpointId = randomUUID();
    const checkpointDirectory = join(this.patchesRoot, 'checkpoints');
    await mkdir(checkpointDirectory, { recursive: true, mode: 0o700 });
    const checkpointPath = join(checkpointDirectory, `${session.id}-${checkpointId}.patch`);
    await copyFile(session.patchPath, checkpointPath);
    const checkpoint: StoredCheckpoint = {
      id: checkpointId,
      label: boundText(
        request.label?.trim() || `Checkpoint ${(session.checkpoints?.length ?? 0) + 1}`,
        120,
      ),
      createdAt: this.timestamp(),
      patchHash: session.diff.patchHash,
      files: session.diff.files,
      patchPath: checkpointPath,
    };
    session.checkpoints = [...(session.checkpoints ?? []), checkpoint].slice(-20);
    session.updatedAt = this.timestamp();
    await this.save(session);
    await this.addEvent(session, 'status', `Checkpoint saved: ${checkpoint.label}.`);
    return publicSession(session);
  }

  async restoreCheckpoint(
    id: string,
    request: AiRestoreCheckpointRequest,
  ): Promise<AiSessionSummary> {
    if (request.approved !== true) {
      throw new Error('Operator approval is required to restore a checkpoint.');
    }
    const session = await this.load(id);
    if (session.status !== 'awaiting-review' && session.status !== 'failed') {
      throw new Error(`A ${session.status} session cannot restore a checkpoint.`);
    }
    const checkpoint = (session.checkpoints ?? []).find(
      (candidate) => candidate.id === request.checkpointId,
    );
    if (!checkpoint) throw new Error('Hawk checkpoint not found.');
    await ensureWorktree(session);
    const patch = await readFile(checkpoint.patchPath);
    const patchHash = createHash('sha256').update(patch).digest('hex');
    if (patchHash !== checkpoint.patchHash) {
      throw new Error('Checkpoint integrity verification failed.');
    }
    await git(session.workerRoot, ['reset', '--hard', session.snapshotCommit]);
    await git(session.workerRoot, ['clean', '-fd', '--', '.']);
    await gitWithInput(session.workerRoot, ['apply', '--whitespace=nowarn', '-'], patch);
    session.error = undefined;
    session.testResults = [];
    await this.captureDiff(session);
    session.status = 'awaiting-review';
    session.updatedAt = this.timestamp();
    await this.save(session);
    await this.addEvent(session, 'status', `Checkpoint restored: ${checkpoint.label}.`);
    return publicSession(session);
  }

  async apply(id: string, request: AiApplyRequest): Promise<AiSessionSummary> {
    if (request.approved !== true)
      throw new Error('Operator approval is required to apply changes.');
    const session = await this.load(id);
    if (session.status !== 'awaiting-review' || !session.diff) {
      throw new Error('This session does not have changes ready to apply.');
    }
    if (request.patchHash !== session.diff.patchHash) {
      throw new Error('The reviewed diff changed. Reload it before applying.');
    }
    const gatesPassed =
      session.testGates.length === 0 ||
      session.testGates.every((gate) =>
        session.testResults.some(
          (result) => result.gateId === gate.id && result.status === 'passed',
        ),
      );
    if (!gatesPassed && request.allowFailingTests !== true) {
      throw new Error('Approved test gates have not passed. Explicit override is required.');
    }
    await assertWorkspaceMatchesSnapshot(session);
    const patch = await readFile(session.patchPath);
    await gitWithInput(session.repoRoot, ['apply', '--check', '--whitespace=nowarn', '-'], patch);
    await gitWithInput(session.repoRoot, ['apply', '--whitespace=nowarn', '-'], patch);
    for (const file of session.touchedFiles) {
      file.afterHash = await hashWorkspacePath(session.repoRoot, file.path);
    }
    session.status = 'applied';
    session.updatedAt = this.timestamp();
    await this.save(session);
    await this.addEvent(session, 'status', 'Reviewed patch applied to the workspace.');
    await this.removeWorktree(session);
    return publicSession(session);
  }

  async reject(id: string): Promise<AiSessionSummary> {
    const session = await this.load(id);
    if (
      session.status !== 'awaiting-review' &&
      session.status !== 'failed' &&
      session.status !== 'cancelled' &&
      session.status !== 'paused'
    ) {
      throw new Error(`A ${session.status} session cannot be rejected.`);
    }
    session.status = 'rejected';
    session.updatedAt = this.timestamp();
    await this.save(session);
    await this.addEvent(
      session,
      'status',
      'Hawk changes rejected. The isolated worktree was removed.',
    );
    await this.removeWorktree(session);
    return publicSession(session);
  }

  async revert(id: string): Promise<AiSessionSummary> {
    const session = await this.load(id);
    if (session.status !== 'applied' || !session.diff) {
      throw new Error('Only an applied Hawk session can be reverted.');
    }
    for (const file of session.touchedFiles) {
      const current = await hashWorkspacePath(session.repoRoot, file.path);
      if (current !== file.afterHash) {
        throw new Error(
          `Cannot revert because ${file.path} changed after the Hawk patch was applied.`,
        );
      }
    }
    const patch = await readFile(session.patchPath);
    await gitWithInput(
      session.repoRoot,
      ['apply', '--reverse', '--check', '--whitespace=nowarn', '-'],
      patch,
    );
    await gitWithInput(session.repoRoot, ['apply', '--reverse', '--whitespace=nowarn', '-'], patch);
    session.status = 'reverted';
    session.updatedAt = this.timestamp();
    await this.save(session);
    await this.addEvent(session, 'status', 'Applied Hawk patch reverted safely.');
    return publicSession(session);
  }

  async cancel(id: string): Promise<AiSessionSummary> {
    const session = await this.load(id);
    this.testControllers.get(id)?.abort();
    const worker = this.workers.get(id);
    if (worker && !worker.killed) worker.kill();
    if (
      session.status === 'running' ||
      session.status === 'preparing' ||
      session.status === 'testing' ||
      session.status === 'paused'
    ) {
      session.status = 'cancelled';
      session.updatedAt = this.timestamp();
      await this.save(session);
      await this.addEvent(session, 'status', 'Hawk task cancelled by the operator.');
    }
    return publicSession(session);
  }

  async pause(id: string): Promise<AiSessionSummary> {
    const session = await this.load(id);
    if (session.status !== 'running' && session.status !== 'preparing') {
      throw new Error(`A ${session.status} session cannot be paused.`);
    }
    const worker = this.workers.get(id);
    session.status = 'paused';
    session.updatedAt = this.timestamp();
    await this.save(session);
    await this.addEvent(
      session,
      'status',
      'Task paused. The isolated worktree and saved agent memory were preserved.',
    );
    if (worker && !worker.killed) worker.kill();
    const deadline = Date.now() + 5_000;
    while (this.workers.has(id) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    if (this.workers.has(id)) {
      throw new Error('Hawk worker did not stop cleanly; the task remains preserved.');
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    return publicSession(session);
  }

  async resume(id: string): Promise<AiSessionSummary> {
    const session = await this.load(id);
    if (session.status !== 'paused' && session.status !== 'failed') {
      throw new Error(`A ${session.status} session cannot be resumed.`);
    }
    await ensureWorktree(session);
    if (session.diff) {
      session.status = 'awaiting-review';
      session.error = undefined;
      session.updatedAt = this.timestamp();
      await this.save(session);
      await this.addEvent(session, 'status', 'Recovered reviewable changes are ready again.');
      return publicSession(session);
    }
    session.error = undefined;
    session.resumeCount = (session.resumeCount ?? 0) + 1;
    await this.addEvent(session, 'status', `Resuming task (recovery ${session.resumeCount}).`);
    await this.startWorker(
      session,
      `Resume and complete the interrupted task. Original objective:\n${session.prompt}`,
      'Recovery: inspect the current isolated worktree and saved agent memory before continuing.',
    );
    return publicSession(session);
  }

  private async startWorker(
    session: StoredAiSession,
    prompt: string,
    context: string,
  ): Promise<void> {
    if (this.workers.has(session.id)) throw new Error('This Hawk session is already running.');
    session.status = 'running';
    session.updatedAt = this.timestamp();
    await this.save(session);
    const child = spawn(this.workerLaunch.command, this.workerLaunch.args, {
      cwd: session.workerRoot,
      windowsHide: true,
      env: { ...process.env, ...this.workerLaunch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.workers.set(session.id, child);
    let workerReportedSuccess = false;
    let stderr = '';
    let lineProcessing = Promise.resolve();
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = boundText(stderr + chunk.toString('utf8'), MAX_TEST_OUTPUT);
    });
    const reader = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    reader.on('line', (line) => {
      lineProcessing = lineProcessing
        .then(async () => {
          if (await this.handleWorkerLine(session.id, line)) workerReportedSuccess = true;
        })
        .catch(async (err: unknown) => {
          await this.failWorker(session.id, errorMessage(err));
        });
    });
    child.once('error', (err) => {
      void this.failWorker(session.id, err.message);
    });
    child.once('exit', (code) => {
      reader.close();
      this.workers.delete(session.id);
      void lineProcessing.then(() =>
        this.finishWorker(
          session.id,
          code === 0 && workerReportedSuccess,
          stderr || `Hawk worker exited with code ${code ?? 'unknown'}.`,
        ),
      );
    });
    child.stdin.end(
      `${JSON.stringify({
        sessionId: session.id,
        agentSessionPath: session.agentSessionPath,
        workspaceRoot: session.workerRoot,
        prompt,
        context,
      })}\n`,
    );
  }

  private async handleWorkerLine(id: string, line: string): Promise<boolean> {
    let envelope: WorkerEvent;
    try {
      envelope = JSON.parse(line) as WorkerEvent;
    } catch {
      const session = await this.load(id);
      await this.addEvent(session, 'error', `Invalid worker output: ${boundText(line, 2_000)}`);
      return false;
    }
    const session = await this.load(id);
    if (envelope.type === 'worker-info') {
      session.provider = boundText(envelope.provider ?? '', 100);
      session.model = boundText(envelope.model ?? '', 200);
      session.updatedAt = this.timestamp();
      await this.save(session);
      await this.addEvent(
        session,
        'status',
        `Model ready: ${session.provider || 'provider'} / ${session.model || 'default model'}`,
      );
      return false;
    }
    if (envelope.type === 'worker-result') return envelope.ok === true;
    if (envelope.type === 'agent-event' && envelope.event?.type) {
      const type = normalizeEventType(envelope.event.type);
      if (type === 'error') {
        session.error = boundText(envelope.event.text ?? 'Hawk agent failed.', 20_000);
        await this.save(session);
      }
      await this.addEvent(
        session,
        type,
        boundText(envelope.event.text ?? '', MAX_EVENT_TEXT),
        envelope.event.tool,
        envelope.event.durationMs,
      );
    }
    return false;
  }

  private async finishWorker(id: string, ok: boolean, failureText: string): Promise<void> {
    const session = await this.load(id);
    if (session.status === 'cancelled' || session.status === 'paused') return;
    if (!ok) {
      session.status = 'failed';
      session.error = session.error || boundText(failureText, 20_000);
      session.updatedAt = this.timestamp();
      await this.save(session);
      await this.addEvent(session, 'error', session.error);
      return;
    }
    try {
      await this.captureDiff(session);
      session.status = 'awaiting-review';
      session.updatedAt = this.timestamp();
      await this.save(session);
      const text = session.diff
        ? `Diff ready: ${session.diff.files} file(s), +${session.diff.insertions} -${session.diff.deletions}.`
        : 'Task completed with no file changes.';
      await this.addEvent(session, session.diff ? 'diff-ready' : 'done', text);
    } catch (err) {
      session.status = 'failed';
      session.error = errorMessage(err);
      session.updatedAt = this.timestamp();
      await this.save(session);
      await this.addEvent(session, 'error', session.error);
    }
  }

  private async failWorker(id: string, message: string): Promise<void> {
    const session = await this.load(id);
    if (session.status === 'cancelled' || session.status === 'paused') return;
    session.status = 'failed';
    session.error = message;
    session.updatedAt = this.timestamp();
    await this.save(session);
    await this.addEvent(session, 'error', message);
  }

  private async captureDiff(session: StoredAiSession): Promise<void> {
    await git(session.workerRoot, ['add', '-A', '--', '.']);
    const patch = await gitBuffer(session.workerRoot, [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--no-renames',
      session.snapshotCommit,
      '--',
      '.',
    ]);
    if (patch.length === 0) {
      session.diff = undefined;
      session.touchedFiles = [];
      await rm(session.patchPath, { force: true });
      return;
    }
    if (patch.length > MAX_PATCH_BYTES) {
      throw new Error(
        `Hawk diff is ${patch.length} bytes; the review limit is ${MAX_PATCH_BYTES} bytes.`,
      );
    }
    const names = await gitBuffer(session.workerRoot, [
      'diff',
      '--cached',
      '--name-only',
      '-z',
      '--no-renames',
      session.snapshotCommit,
      '--',
      '.',
    ]);
    const touched = names.toString('utf8').split('\0').filter(Boolean);
    if (touched.length > 200) throw new Error('Hawk changed more than 200 files in one task.');
    const stats = await git(session.workerRoot, [
      'diff',
      '--cached',
      '--numstat',
      '--no-renames',
      session.snapshotCommit,
      '--',
      '.',
    ]);
    let insertions = 0;
    let deletions = 0;
    for (const line of stats.split(/\r?\n/)) {
      const [added, removed] = line.split('\t');
      insertions += Number.parseInt(added ?? '', 10) || 0;
      deletions += Number.parseInt(removed ?? '', 10) || 0;
    }
    await atomicWrite(session.patchPath, patch);
    session.diff = {
      patchHash: createHash('sha256').update(patch).digest('hex'),
      files: touched.length,
      insertions,
      deletions,
      bytes: patch.length,
      truncated: false,
    };
    session.touchedFiles = [];
    for (const relativePath of touched) {
      session.touchedFiles.push({
        path: relativePath,
        beforeHash: await gitObjectAt(session.worktreeRoot, session.snapshotCommit, relativePath),
        afterHash: await hashWorkspacePath(session.worktreeRoot, relativePath),
      });
    }
  }

  private async prepareWorktree(id: string): Promise<{
    repoRoot: string;
    workspaceRelative: string;
    worktreeRoot: string;
    workerRoot: string;
    snapshotCommit: string;
  }> {
    const repoRoot = (await git(this.workspaceRoot, ['rev-parse', '--show-toplevel'])).trim();
    if (!repoRoot) throw new Error('Hawk AI requires a git repository for isolated change review.');
    const canonicalRepo = await realpath(repoRoot);
    const canonicalWorkspace = await realpath(this.workspaceRoot);
    const workspaceRelative = relative(canonicalRepo, canonicalWorkspace);
    if (workspaceRelative.startsWith('..') || isAbsolute(workspaceRelative)) {
      throw new Error('Workspace is outside the detected git repository.');
    }
    const worktreeRoot = join(this.worktreesRoot, id);
    await rm(worktreeRoot, { recursive: true, force: true });
    await git(canonicalRepo, ['worktree', 'add', '--detach', worktreeRoot, 'HEAD']);
    try {
      const currentPatch = await gitBuffer(canonicalRepo, [
        'diff',
        '--binary',
        '--full-index',
        'HEAD',
        '--',
        '.',
      ]);
      if (currentPatch.length > 0) {
        await gitWithInput(worktreeRoot, ['apply', '--whitespace=nowarn', '-'], currentPatch);
      }
      await copyUntrackedFiles(canonicalRepo, worktreeRoot);
      await git(worktreeRoot, ['add', '-A']);
      const hasSnapshotChanges = (await git(worktreeRoot, ['status', '--porcelain'])).trim() !== '';
      if (hasSnapshotChanges) {
        await git(
          worktreeRoot,
          [
            '-c',
            'user.name=Hawk AI',
            '-c',
            'user.email=hawk-ai@localhost',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--no-verify',
            '-m',
            'Hawk AI workspace snapshot',
          ],
          { HUSKY: '0' },
        );
      }
      const snapshotCommit = (await git(worktreeRoot, ['rev-parse', 'HEAD'])).trim();
      await linkNodeModules(canonicalRepo, worktreeRoot);
      const workerRoot = resolve(worktreeRoot, workspaceRelative || '.');
      await mkdir(workerRoot, { recursive: true });
      return {
        repoRoot: canonicalRepo,
        workspaceRelative,
        worktreeRoot,
        workerRoot,
        snapshotCommit,
      };
    } catch (err) {
      await git(canonicalRepo, ['worktree', 'remove', '--force', worktreeRoot]).catch(() => '');
      await rm(worktreeRoot, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async removeWorktree(session: StoredAiSession): Promise<void> {
    await git(session.repoRoot, ['worktree', 'remove', '--force', session.worktreeRoot]).catch(
      () => '',
    );
    await rm(session.worktreeRoot, { recursive: true, force: true }).catch(() => undefined);
    await git(session.repoRoot, ['worktree', 'prune']).catch(() => '');
  }

  private async addEvent(
    session: StoredAiSession,
    type: AiSessionEvent['type'],
    text: string,
    tool?: string,
    durationMs?: number,
  ): Promise<void> {
    session.lastEventId += 1;
    session.updatedAt = this.timestamp();
    const event: AiSessionEvent = {
      id: session.lastEventId,
      at: session.updatedAt,
      type,
      text: boundText(text, MAX_EVENT_TEXT),
      ...(tool ? { tool: boundText(tool, 200) } : {}),
      ...(typeof durationMs === 'number' ? { durationMs } : {}),
    };
    await appendFile(this.eventsPath(session.id), `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await this.save(session);
  }

  private async load(id: string): Promise<StoredAiSession> {
    validateSessionId(id);
    let parsed: StoredAiSession;
    try {
      parsed = JSON.parse(await readFile(this.sessionPath(id), 'utf8')) as StoredAiSession;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error('Hawk AI session not found.');
      throw err;
    }
    if (parsed.version !== SESSION_FILE_VERSION || parsed.id !== id) {
      throw new Error('Unsupported or corrupt Hawk AI session file.');
    }
    return parsed;
  }

  private async loadAll(): Promise<StoredAiSession[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionsRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const sessions: StoredAiSession[] = [];
    for (const name of entries.filter((entry) => entry.endsWith('.json'))) {
      try {
        sessions.push(await this.load(basename(name, '.json')));
      } catch {
        // Ignore a single corrupt session so history remains usable.
      }
    }
    return sessions;
  }

  private async save(session: StoredAiSession): Promise<void> {
    const id = session.id;
    const path = this.sessionPath(id);
    const body = Buffer.from(`${JSON.stringify(session, null, 2)}\n`, 'utf8');
    const previous = this.saveQueues.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => atomicWrite(path, body));
    this.saveQueues.set(id, pending);
    try {
      await pending;
    } finally {
      if (this.saveQueues.get(id) === pending) this.saveQueues.delete(id);
    }
  }

  private sessionPath(id: string): string {
    validateSessionId(id);
    return join(this.sessionsRoot, `${id}.json`);
  }

  private eventsPath(id: string): string {
    validateSessionId(id);
    return join(this.sessionsRoot, `${id}.events.jsonl`);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function publicSession(session: StoredAiSession): AiSessionSummary {
  return {
    id: session.id,
    title: session.title,
    prompt: session.prompt,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    provider: session.provider,
    model: session.model,
    background: session.background === true,
    autoResume: session.autoResume === true,
    resumeCount: session.resumeCount ?? 0,
    error: session.error,
    diff: session.diff,
    checkpoints: (session.checkpoints ?? []).map(
      ({ patchPath: _patchPath, ...checkpoint }) => checkpoint,
    ),
    sandboxPath: session.workerRoot,
    testGates: session.testGates,
    testResults: session.testResults,
    canApply: session.status === 'awaiting-review' && Boolean(session.diff),
    canReject:
      session.status === 'awaiting-review' ||
      session.status === 'failed' ||
      session.status === 'cancelled',
    canRevert: session.status === 'applied',
    canCheckpoint: session.status === 'awaiting-review' && Boolean(session.diff),
    canPause: session.status === 'running' || session.status === 'preparing',
    canResume: session.status === 'paused' || session.status === 'failed',
    canOpenTerminal: session.status === 'awaiting-review' || session.status === 'paused',
  };
}

function scoreMergeCandidate(session: StoredAiSession): AiMergeCandidateScore {
  const reasons: string[] = [];
  let score = 50;
  const passed = session.testResults.filter((result) => result.status === 'passed').length;
  const failed = session.testResults.filter((result) => result.status === 'failed').length;
  if (passed > 0) {
    score += Math.min(24, passed * 8);
    reasons.push(`${passed} gate(s) passed`);
  }
  if (failed > 0) {
    score -= failed * 15;
    reasons.push(`${failed} gate(s) failed`);
  }
  if (session.testGates.length > 0 && passed === session.testGates.length) {
    score += 12;
    reasons.push('all detected gates passed');
  }
  const changedLines = (session.diff?.insertions ?? 0) + (session.diff?.deletions ?? 0);
  if (changedLines <= 250) {
    score += 8;
    reasons.push('focused patch');
  } else if (changedLines > 2_000) {
    score -= 12;
    reasons.push('large review surface');
  }
  if ((session.diff?.files ?? 0) > 40) {
    score -= 8;
    reasons.push('many touched files');
  }
  if (reasons.length === 0) reasons.push('review-ready candidate');
  return { sessionId: session.id, score: Math.max(0, Math.min(100, score)), reasons };
}

async function prepareSemanticMerge(
  candidates: StoredAiSession[],
): Promise<SemanticMergePreparation> {
  const baseFiles: Record<string, string | null> = {};
  const candidateFiles = candidates.map((candidate) => ({
    id: candidate.id,
    files: {} as Record<string, string | null>,
  }));
  const forcedConflicts: AiSemanticMergeConflict[] = [];
  const touchedPaths = [
    ...new Set(candidates.flatMap((candidate) => candidate.touchedFiles.map((file) => file.path))),
  ].sort();

  for (const path of touchedPaths) {
    const touching = candidates.filter((candidate) =>
      candidate.touchedFiles.some((file) => file.path === path),
    );
    const baseBuffers = await Promise.all(
      touching.map((candidate) =>
        readGitFileAt(candidate.worktreeRoot, candidate.snapshotCommit, path),
      ),
    );
    if (!buffersEqual(baseBuffers)) {
      forcedConflicts.push({
        path,
        unit: 'snapshot',
        candidateIds: touching.map((candidate) => candidate.id),
        reason: 'Candidates started from different base content for this file.',
      });
      continue;
    }
    const base = decodeMergeText(baseBuffers[0] ?? null);
    if (base === undefined) {
      forcedConflicts.push({
        path,
        unit: 'binary-or-large-file',
        candidateIds: touching.map((candidate) => candidate.id),
        reason:
          'Binary, invalid UTF-8, or oversized files require explicit model and operator review.',
      });
      continue;
    }
    baseFiles[path] = base;
    for (const candidate of touching) {
      const index = candidates.findIndex((item) => item.id === candidate.id);
      const entry = candidateFiles[index];
      if (!entry) continue;
      const content = decodeMergeText(await readCandidateFile(candidate, path));
      if (content === undefined) {
        forcedConflicts.push({
          path,
          unit: 'binary-or-large-file',
          candidateIds: [candidate.id],
          reason: 'Candidate output is binary, invalid UTF-8, or too large for semantic merge.',
        });
        continue;
      }
      entry.files[path] = content;
    }
  }

  const merged = buildSemanticMerge({
    baseFiles,
    candidates: candidateFiles,
  });
  const plan: AiSemanticMergePlan = {
    ...merged.plan,
    conflicts: [...merged.plan.conflicts, ...forcedConflicts],
  };
  const seedFiles = Object.entries(merged.files)
    .filter(([path, content]) => content !== baseFiles[path])
    .map(([path, content]) => ({ path, content }));
  return {
    seedFiles,
    plan,
    context: renderSemanticMergePlan(plan),
  };
}

async function readGitFileAt(
  worktreeRoot: string,
  commit: string,
  relativePath: string,
): Promise<Buffer | null> {
  try {
    return await gitBuffer(worktreeRoot, ['show', `${commit}:${toGitPath(relativePath)}`]);
  } catch {
    return null;
  }
}

async function readCandidateFile(
  session: StoredAiSession,
  relativePath: string,
): Promise<Buffer | null> {
  const absolute = resolve(session.worktreeRoot, relativePath);
  if (!isInside(session.worktreeRoot, absolute)) {
    throw new Error(`Unsafe semantic merge path: ${relativePath}`);
  }
  try {
    const info = await lstat(absolute);
    if (!info.isFile()) return Buffer.from([0]);
    return await readFile(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function decodeMergeText(content: Buffer | null): string | null | undefined {
  if (content === null) return null;
  if (content.length > 1_500_000 || content.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

function buffersEqual(values: Array<Buffer | null>): boolean {
  if (values.length < 2) return true;
  const first = values[0] ?? null;
  return values.every((value) => {
    if (first === null || value === null) return first === value;
    return first.equals(value);
  });
}

function renderSemanticMergePlan(plan: AiSemanticMergePlan): string {
  return [
    '# Hawk Semantic Merge v2 Plan',
    '',
    `Engine: ${plan.engine}`,
    `Primary candidate: ${plan.primaryCandidateId}`,
    `Files analyzed: ${plan.filesAnalyzed}`,
    `AST files analyzed: ${plan.astFilesAnalyzed}`,
    `Compatible changes seeded: ${plan.automaticallyMergedUnits.length}`,
    `Conflicts requiring resolution: ${plan.conflicts.length}`,
    '',
    '## Deterministically seeded changes',
    '',
    ...(plan.automaticallyMergedUnits.length
      ? plan.automaticallyMergedUnits.map(
          (item) => `- ${item.path} :: ${item.unit} <- ${item.candidateId} (${item.strategy})`,
        )
      : ['- None']),
    '',
    '## Semantic conflicts',
    '',
    ...(plan.conflicts.length
      ? plan.conflicts.map(
          (item) =>
            `- ${item.path} :: ${item.unit} [${item.candidateIds.join(', ')}] — ${item.reason}`,
        )
      : ['- None']),
  ].join('\n');
}

async function seedPreparedWorktree(worktreeRoot: string, files: SeedFile[]): Promise<void> {
  for (const file of files) {
    const absolute = resolve(worktreeRoot, file.path);
    if (!isInside(worktreeRoot, absolute)) {
      throw new Error(`Unsafe semantic merge seed path: ${file.path}`);
    }
    if (file.content === null) {
      await rm(absolute, { force: true });
      continue;
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, { encoding: 'utf8', mode: 0o600 });
  }
}

function defaultWorkerLaunch(): WorkerLaunch {
  const entry = process.argv[1];
  if (!entry) throw new Error('Cannot locate the Hawk daemon entrypoint for AI worker mode.');
  return {
    command: process.execPath,
    args: [entry, '--ai-worker'],
    env: process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : undefined,
  };
}

async function detectTestGates(workspaceRoot: string): Promise<AiTestGate[]> {
  try {
    const pkg = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = pkg.scripts ?? {};
    const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const candidates = [
      ['typecheck', 'Type check'],
      ['lint', 'Lint'],
      ['test', 'Test suite'],
      ['build', 'Production build'],
    ] as const;
    return candidates
      .filter(([name]) => typeof scripts[name] === 'string')
      .map(([name, label]) => ({
        id: `npm:${name}`,
        label,
        command: executable,
        args: ['run', name],
      }));
  } catch {
    return [];
  }
}

async function copyUntrackedFiles(repoRoot: string, worktreeRoot: string): Promise<void> {
  const output = await gitBuffer(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const relativePath of output.toString('utf8').split('\0').filter(Boolean)) {
    if (
      relativePath === '.hawk' ||
      relativePath.startsWith(`.hawk${sep}`) ||
      relativePath.startsWith('.hawk/')
    ) {
      continue;
    }
    const source = resolve(repoRoot, relativePath);
    if (!isInside(repoRoot, source)) continue;
    const info = await lstat(source);
    if (!info.isFile()) continue;
    const destination = resolve(worktreeRoot, relativePath);
    if (!isInside(worktreeRoot, destination)) continue;
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

async function linkNodeModules(repoRoot: string, worktreeRoot: string): Promise<void> {
  const source = join(repoRoot, 'node_modules');
  const destination = join(worktreeRoot, 'node_modules');
  try {
    if (!(await stat(source)).isDirectory()) return;
  } catch {
    return;
  }
  try {
    await git(worktreeRoot, ['check-ignore', '-q', 'node_modules']);
  } catch {
    return;
  }
  try {
    await lstat(destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
    await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir').catch(
      () => undefined,
    );
  }
}

async function assertWorkspaceMatchesSnapshot(session: StoredAiSession): Promise<void> {
  for (const file of session.touchedFiles) {
    const current = await hashWorkspacePath(session.repoRoot, file.path);
    if (current !== file.beforeHash) {
      throw new Error(`Cannot apply because ${file.path} changed after this Hawk session started.`);
    }
  }
}

async function ensureWorktree(session: StoredAiSession): Promise<void> {
  try {
    const info = await stat(session.workerRoot);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('The isolated worktree for this Hawk session is no longer available.');
  }
}

async function gitObjectAt(
  repoRoot: string,
  commit: string,
  relativePath: string,
): Promise<string | null> {
  try {
    return (await git(repoRoot, ['rev-parse', `${commit}:${toGitPath(relativePath)}`])).trim();
  } catch {
    return null;
  }
}

async function hashWorkspacePath(repoRoot: string, relativePath: string): Promise<string | null> {
  const absolute = resolve(repoRoot, relativePath);
  if (!isInside(repoRoot, absolute)) throw new Error(`Unsafe diff path: ${relativePath}`);
  try {
    await lstat(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return (await git(repoRoot, ['hash-object', '--', relativePath])).trim();
}

function git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 12 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  }).then((result) => result.stdout);
}

function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 12 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  }).then((result) => result.stdout as Buffer);
}

async function gitWithInput(cwd: string, args: string[], input: Buffer): Promise<void> {
  const result = await runCommand('git', args, {
    cwd,
    timeoutMs: 60_000,
    input,
    env: process.env,
  });
  if (result.exitCode !== 0) {
    throw new Error(boundText(result.stderr || result.stdout || 'git apply failed', 20_000));
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    input?: Buffer;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise<CommandResult>((resolveResult, reject) => {
    const windowsNpmShim = process.platform === 'win32' && command.toLowerCase() === 'npm.cmd';
    if (windowsNpmShim && !args.every((arg) => /^[a-z0-9:_-]+$/i.test(arg))) {
      reject(new Error('Unsafe argument in approved Windows npm gate.'));
      return;
    }
    const launchCommand = windowsNpmShim ? (process.env.ComSpec ?? 'cmd.exe') : command;
    const launchArgs = windowsNpmShim ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] : args;
    const child = spawn(launchCommand, launchArgs, {
      cwd: options.cwd,
      windowsHide: true,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let cancelled = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string =>
      boundText(current + chunk.toString('utf8'), MAX_TEST_OUTPUT);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolveResult({
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - started,
        cancelled,
      });
    };
    const abort = (): void => {
      cancelled = true;
      if (!child.killed) child.kill();
    };
    const timer = setTimeout(abort, options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => finish(code));
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function atomicWrite(path: string, body: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, body, { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, path);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (
          process.platform !== 'win32' ||
          !['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '') ||
          attempt >= 4
        ) {
          throw err;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20 * 2 ** attempt));
      }
    }
    await chmod(path, 0o600).catch(() => undefined);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function validatePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error('Hawk task prompt is required.');
  if (trimmed.length > 12_000) throw new Error('Hawk task prompt is too long.');
  return trimmed;
}

function validateSessionId(id: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid Hawk AI session id.');
}

function summarizeTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? 'Hawk AI task';
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

function normalizeEventType(type: string): AiSessionEvent['type'] {
  const allowed = new Set<AiSessionEvent['type']>([
    'status',
    'plan',
    'assistant-delta',
    'assistant-text',
    'tool-call',
    'tool-result',
    'test-output',
    'diff-ready',
    'error',
    'done',
  ]);
  return allowed.has(type as AiSessionEvent['type']) ? (type as AiSessionEvent['type']) : 'status';
}

function testSummary(results: AiTestResult[]): string {
  if (results.length === 0) return 'No test gate completed.';
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.find((result) => result.status !== 'passed');
  return failed
    ? `Test gates stopped: ${failed.label} ${failed.status}. ${passed} passed first.`
    : `All ${passed} approved test gate(s) passed.`;
}

function boundText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... truncated ${text.length - max} characters ...]`;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function toGitPath(path: string): string {
  return path.split(sep).join('/');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
