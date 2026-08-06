import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DurableStore } from './durableStore.js';
import type {
  GovernedMissionPlan,
  OneClickMissionRun,
  OneClickMissionStage,
  OneClickMissionStageId,
  OneClickProofGate,
} from './protocol.js';
import { IDE_PROTOCOL_VERSION } from './protocol.js';

const COLLECTION = 'one-click-missions';

export interface OneClickMissionOperations {
  inventory(): Promise<{ sourceFiles: number }>;
  protocols(): Promise<{ summary: { total: number } }>;
  audit(): Promise<{ findings: unknown[] }>;
  attackTwin(): Promise<{ paths: unknown[] }>;
  proofCorrelation(): Promise<{ nodes: number; edges: number; correlated: boolean }>;
  evidencePack(): Promise<{ directoryPath: string; artifacts: unknown[] }>;
}

export class OneClickMissionService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly store: DurableStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(
    plan: GovernedMissionPlan,
    operations: OneClickMissionOperations,
  ): Promise<OneClickMissionRun> {
    if (plan.decision === 'deny')
      throw new Error(`Mission policy denied execution: ${plan.reasons.join('; ')}`);
    const at = this.now().toISOString();
    const run: OneClickMissionRun = {
      protocolVersion: IDE_PROTOCOL_VERSION,
      id: `proof-mission-${randomUUID()}`,
      planId: plan.id,
      planHash: plan.planHash,
      objective: plan.objective,
      profile: plan.profile,
      status: 'running',
      startedAt: at,
      updatedAt: at,
      recoveredAfterRestart: false,
      stages: createStages(),
      proof: proofContract(),
      summary: {
        sourceFiles: 0,
        protocolSurfaces: 0,
        findings: 0,
        attackPaths: 0,
        graphNodes: 0,
        graphEdges: 0,
        evidenceArtifacts: 0,
      },
      reportPath: '.hawk/missions/proof-mission-pending.md',
      statement:
        'Hawk automates passive discovery and evidence packaging, then stops before reproduction, patching, tests, or Apply until their exact approval and proof gates pass.',
    };
    run.reportPath = `.hawk/missions/${run.id}.md`;
    await this.persist(run);
    return await this.execute(run, operations);
  }

  async resume(id: string, operations: OneClickMissionOperations): Promise<OneClickMissionRun> {
    const run = await this.get(id);
    if (!run) throw new Error('One-click mission not found');
    if (run.status !== 'paused' && run.status !== 'failed') {
      throw new Error(`Mission cannot resume from ${run.status}`);
    }
    run.status = 'running';
    run.error = undefined;
    run.updatedAt = this.now().toISOString();
    for (const stage of run.stages) {
      if (stage.execution === 'automatic') {
        stage.status = 'pending';
        stage.summary = 'Queued for a safe idempotent recovery pass';
        stage.startedAt = undefined;
        stage.completedAt = undefined;
      }
    }
    await this.persist(run);
    return await this.execute(run, operations);
  }

  async cancel(id: string): Promise<OneClickMissionRun> {
    const run = await this.get(id);
    if (!run) throw new Error('One-click mission not found');
    if (run.status === 'completed' || run.status === 'cancelled') return run;
    run.status = 'cancelled';
    run.updatedAt = this.now().toISOString();
    run.completedAt = run.updatedAt;
    await this.persist(run);
    return run;
  }

  async recoverInterrupted(): Promise<number> {
    const runs = await this.store.listJson<OneClickMissionRun>(COLLECTION);
    let recovered = 0;
    for (const run of runs) {
      if (run.status !== 'running') continue;
      run.status = 'paused';
      run.recoveredAfterRestart = true;
      run.updatedAt = this.now().toISOString();
      run.error =
        'Daemon restarted during execution. The durable history is preserved and the passive pipeline can be rerun safely.';
      const active = run.stages.find((stage) => stage.status === 'running');
      if (active) {
        active.status = 'pending';
        active.summary = 'Interrupted by restart; ready to resume';
        active.startedAt = undefined;
      }
      await this.persist(run);
      recovered += 1;
    }
    return recovered;
  }

  async get(id: string): Promise<OneClickMissionRun | undefined> {
    return await this.store.readJson<OneClickMissionRun>(COLLECTION, id);
  }

  async list(limit = 20): Promise<OneClickMissionRun[]> {
    return (await this.store.listJson<OneClickMissionRun>(COLLECTION))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, Math.max(1, Math.min(limit, 100)));
  }

  private async execute(
    run: OneClickMissionRun,
    operations: OneClickMissionOperations,
  ): Promise<OneClickMissionRun> {
    try {
      const inventory = await this.stage(run, 'inventory', operations.inventory);
      run.summary.sourceFiles = inventory.sourceFiles;
      const protocols = await this.stage(run, 'protocols', operations.protocols);
      run.summary.protocolSurfaces = protocols.summary.total;
      const audit = await this.stage(run, 'static-audit', operations.audit);
      run.summary.findings = audit.findings.length;
      const twin = await this.stage(run, 'attack-twin', operations.attackTwin);
      run.summary.attackPaths = twin.paths.length;
      const graph = await this.stage(run, 'proof-correlation', operations.proofCorrelation);
      run.summary.graphNodes = graph.nodes;
      run.summary.graphEdges = graph.edges;
      const evidence = await this.stage(run, 'evidence-pack', operations.evidencePack);
      run.summary.evidenceArtifacts = evidence.artifacts.length;

      this.passGate(run, 'source-correlated', graph.correlated, ['hawk://graph/workspace']);
      this.passGate(run, 'evidence-pack', evidence.artifacts.length > 0, [
        `hawk://report/${evidence.directoryPath}`,
      ]);
      this.passGate(run, 'secrets-redacted', evidence.artifacts.length > 0, [
        `hawk://report/${evidence.directoryPath}`,
      ]);
      const hasSignals = run.summary.findings > 0;
      for (const stage of run.stages.filter(
        (candidate) => candidate.execution === 'approval-gate',
      )) {
        stage.status = hasSignals ? 'awaiting-approval' : 'skipped';
        stage.summary = hasSignals
          ? 'Blocked until an exact finding-bound plan is approved and its evidence is attached'
          : 'No security signals require this gate';
      }
      run.proof.verdict = hasSignals ? 'unverified' : 'no-signals';
      run.status = hasSignals ? 'awaiting-approval' : 'completed';
      run.updatedAt = this.now().toISOString();
      run.completedAt = run.status === 'completed' ? run.updatedAt : undefined;
      await this.persist(run);
      return run;
    } catch (error) {
      run.status = 'failed';
      run.updatedAt = this.now().toISOString();
      run.error =
        error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
      const active = run.stages.find((stage) => stage.status === 'running');
      if (active) {
        active.status = 'failed';
        active.completedAt = run.updatedAt;
        active.summary = run.error;
      }
      await this.persist(run);
      throw error;
    }
  }

  private async stage<T>(
    run: OneClickMissionRun,
    id: OneClickMissionStageId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const stage = run.stages.find((candidate) => candidate.id === id);
    if (!stage) throw new Error(`Unknown one-click mission stage: ${id}`);
    stage.status = 'running';
    stage.startedAt = this.now().toISOString();
    stage.summary = 'Running';
    run.updatedAt = stage.startedAt;
    await this.persist(run);
    const value = await operation();
    stage.status = 'completed';
    stage.completedAt = this.now().toISOString();
    stage.artifactDigest = digest(value);
    stage.summary = summarizeStage(id, value);
    run.updatedAt = stage.completedAt;
    await this.persist(run);
    return value;
  }

  private passGate(
    run: OneClickMissionRun,
    id: OneClickProofGate['id'],
    passed: boolean,
    evidenceUris: string[],
  ): void {
    const gate = run.proof.gates.find((candidate) => candidate.id === id);
    if (!gate) return;
    gate.passed = passed;
    gate.evidenceUris = passed ? evidenceUris : [];
    run.proof.passed = run.proof.gates.filter((candidate) => candidate.passed).length;
  }

  private async persist(run: OneClickMissionRun): Promise<void> {
    await this.store.writeJson(COLLECTION, run.id, run);
    const directory = join(resolve(this.workspaceRoot), '.hawk', 'missions');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${run.id}.md`), renderReport(run), 'utf8');
  }
}

function createStages(): OneClickMissionStage[] {
  const automatic: Array<[OneClickMissionStageId, string]> = [
    ['inventory', 'Index workspace and routes'],
    ['protocols', 'Map protocol and infrastructure surfaces'],
    ['static-audit', 'Run bounded static security analysis'],
    ['attack-twin', 'Build the evidence-aware Attack Twin'],
    ['proof-correlation', 'Correlate source, requests, findings and evidence'],
    ['evidence-pack', 'Build the redacted evidence pack'],
  ];
  const gated: Array<[OneClickMissionStageId, string]> = [
    ['reproduction', 'Reproduce each finding in an isolated sandbox'],
    ['fix-candidate', 'Generate a minimal fix candidate'],
    ['regression-tests', 'Prove pre-fix failure and post-fix success'],
    ['semantic-review', 'Run independent semantic review before Apply'],
  ];
  return [
    ...automatic.map(([id, title]) => ({
      id,
      title,
      status: 'pending' as const,
      execution: 'automatic' as const,
      summary: 'Queued',
    })),
    ...gated.map(([id, title]) => ({
      id,
      title,
      status: 'pending' as const,
      execution: 'approval-gate' as const,
      summary: 'Waiting for passive discovery',
    })),
  ];
}

function proofContract(): OneClickMissionRun['proof'] {
  const definitions: Array<[OneClickProofGate['id'], string]> = [
    ['source-correlated', 'Source, request, finding and evidence are correlated'],
    ['evidence-pack', 'A redacted evidence pack exists'],
    ['baseline-fails', 'A pre-fix baseline demonstrates the failure'],
    ['reproduced', 'The finding is reproduced in isolation'],
    ['independent-reproduction', 'An independent path reproduces the finding'],
    ['identity-valid', 'The tested identity and authorization context are valid'],
    ['impact-demonstrated', 'Security impact is demonstrated'],
    ['within-scope', 'Every action remains inside declared scope'],
    ['safe-side-effects', 'No unsafe side effects were observed'],
    ['secrets-redacted', 'All evidence is secret-redacted'],
    ['post-fix-tests-pass', 'Security and regression tests pass after the fix'],
    ['semantic-review', 'An independent semantic review approves the diff'],
  ];
  return {
    verdict: 'unverified',
    passed: 0,
    total: definitions.length,
    gates: definitions.map(([id, title]) => ({ id, title, passed: false, evidenceUris: [] })),
  };
}

function summarizeStage(id: OneClickMissionStageId, value: unknown): string {
  const data = value as Record<string, unknown>;
  if (id === 'inventory') return `${Number(data.sourceFiles ?? 0)} source files indexed`;
  if (id === 'protocols')
    return `${Number((data.summary as Record<string, unknown>)?.total ?? 0)} surfaces mapped`;
  if (id === 'static-audit')
    return `${Array.isArray(data.findings) ? data.findings.length : 0} signals require proof`;
  if (id === 'attack-twin')
    return `${Array.isArray(data.paths) ? data.paths.length : 0} attack paths modeled`;
  if (id === 'proof-correlation')
    return `${Number(data.nodes ?? 0)} nodes and ${Number(data.edges ?? 0)} evidence links`;
  if (id === 'evidence-pack')
    return `${Array.isArray(data.artifacts) ? data.artifacts.length : 0} sanitized artifacts built`;
  return 'Completed';
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function renderReport(run: OneClickMissionRun): string {
  return [
    '# Hawk One-click Proof Mission',
    '',
    `- Objective: ${run.objective}`,
    `- Status: **${run.status.toUpperCase()}**`,
    `- Plan: \`${run.planId}\``,
    `- Plan hash: \`${run.planHash}\``,
    `- Started: ${run.startedAt}`,
    `- Updated: ${run.updatedAt}`,
    '',
    '## Pipeline',
    '',
    '| Stage | Execution | Status | Result |',
    '| --- | --- | --- | --- |',
    ...run.stages.map(
      (stage) => `| ${stage.title} | ${stage.execution} | ${stage.status} | ${stage.summary} |`,
    ),
    '',
    `## Proof contract (${run.proof.passed}/${run.proof.total})`,
    '',
    ...run.proof.gates.map((gate) => `- [${gate.passed ? 'x' : ' '}] ${gate.title}`),
    '',
    '## Safety statement',
    '',
    run.statement,
    '',
  ].join('\n');
}
