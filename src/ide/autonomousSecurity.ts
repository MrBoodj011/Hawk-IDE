import { createHash, randomUUID } from 'node:crypto';
import type { DurableStore } from './durableStore.js';
import {
  type AttackTwinResponse,
  type AutonomousSecurityPlan,
  type AutonomousSecurityRun,
  IDE_PROTOCOL_VERSION,
  type ProtocolSurfaceInventory,
  type StaticAuditReport,
  type WorkspaceInventory,
} from './protocol.js';
import { stableHash } from './scopePolicy.js';

export class AutonomousSecurityService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly store: DurableStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createPlan(
    input: {
      objective?: string;
      networkPolicy?: AutonomousSecurityPlan['networkPolicy'];
      scopeHosts?: string[];
    } = {},
  ): Promise<AutonomousSecurityPlan> {
    const createdAt = this.now();
    const material = {
      workspaceRoot: this.workspaceRoot,
      objective: (
        input.objective ?? 'Map the authorized workspace and prioritize security evidence'
      )
        .trim()
        .slice(0, 2_000),
      networkPolicy: input.networkPolicy ?? 'offline',
      scopeHosts: sanitizeHosts(input.scopeHosts ?? []),
      stages: [
        {
          id: 'inventory',
          title: 'Index source and HTTP routes',
          execution: 'automatic',
          risk: 'low',
        },
        {
          id: 'protocols',
          title: 'Discover API, identity, cloud and runtime surfaces',
          execution: 'automatic',
          risk: 'low',
        },
        {
          id: 'static-audit',
          title: 'Run bounded static security analysis',
          execution: 'automatic',
          risk: 'low',
        },
        {
          id: 'attack-twin',
          title: 'Build evidence-aware Attack Twin',
          execution: 'automatic',
          risk: 'medium',
        },
        {
          id: 'reproduction-gates',
          title: 'Prepare isolated reproduction gates',
          execution: 'approval-gate',
          risk: 'high',
        },
      ] as AutonomousSecurityPlan['stages'],
    };
    const plan: AutonomousSecurityPlan = {
      protocolVersion: IDE_PROTOCOL_VERSION,
      id: `autopilot-plan-${randomUUID()}`,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 30 * 60_000).toISOString(),
      ...material,
      planHash: stableHash(material),
      statement:
        'Approval starts only offline or captured-only stages. Active requests and reproduction remain separate approval gates.',
    };
    await this.store.writeJson('autonomous-security-plans', plan.id, plan);
    return plan;
  }

  async run(
    input: { planId: string; planHash: string; approved: boolean },
    operations: {
      inventory(): Promise<WorkspaceInventory>;
      protocols(): Promise<ProtocolSurfaceInventory>;
      audit(): Promise<StaticAuditReport>;
      attackTwin(): Promise<AttackTwinResponse>;
    },
  ): Promise<AutonomousSecurityRun> {
    if (!input.approved) throw new Error('Operator approval is required to run Hawk Autopilot');
    const plan = await this.store.readJson<AutonomousSecurityPlan>(
      'autonomous-security-plans',
      input.planId,
    );
    if (!plan) throw new Error('Autopilot plan not found');
    if (plan.planHash !== input.planHash) throw new Error('Autopilot approval hash mismatch');
    if (Date.parse(plan.expiresAt) <= this.now().getTime())
      throw new Error('Autopilot plan expired');
    const startedAt = this.now();
    const stages: AutonomousSecurityRun['stages'] = [];
    const execute = async <T>(
      id: AutonomousSecurityRun['stages'][number]['id'],
      summary: (value: T) => string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const started = this.now();
      const value = await operation();
      const completed = this.now();
      stages.push({
        id,
        status: 'completed',
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        summary: summary(value),
        artifactDigest: digest(value),
      });
      return value;
    };
    const inventory = await execute(
      'inventory',
      (value: WorkspaceInventory) =>
        `${value.sourceFiles} files and ${value.routes.length} routes indexed`,
      operations.inventory,
    );
    const protocols = await execute(
      'protocols',
      (value: ProtocolSurfaceInventory) =>
        `${value.summary.total} protocol and infrastructure surfaces mapped`,
      operations.protocols,
    );
    const audit = await execute(
      'static-audit',
      (value: StaticAuditReport) => `${value.findings.length} static signals require validation`,
      operations.audit,
    );
    const twin = await execute(
      'attack-twin',
      (value: AttackTwinResponse) => `${value.paths.length} evidence-aware attack paths modeled`,
      operations.attackTwin,
    );
    const gateAt = this.now().toISOString();
    stages.push({
      id: 'reproduction-gates',
      status: 'awaiting-approval',
      startedAt: gateAt,
      completedAt: gateAt,
      summary: `${audit.findings.length} signals held behind isolated reproduction approval`,
      artifactDigest: digest(audit.findings.map((finding) => finding.id)),
    });
    const run: AutonomousSecurityRun = {
      protocolVersion: IDE_PROTOCOL_VERSION,
      id: `autopilot-run-${randomUUID()}`,
      planId: plan.id,
      planHash: plan.planHash,
      status: 'completed-with-gates',
      startedAt: startedAt.toISOString(),
      completedAt: this.now().toISOString(),
      stages,
      summary: {
        sourceFiles: inventory.sourceFiles,
        protocolSurfaces: protocols.summary.total,
        findings: audit.findings.length,
        attackPaths: twin.paths.length,
        reproductionGates: audit.findings.length,
      },
      statement:
        'Hawk completed bounded discovery automatically. Active exploitation stays paused until a separate exact-plan approval.',
    };
    await this.store.writeJson('autonomous-security-runs', run.id, run);
    return run;
  }

  async list(limit = 20): Promise<AutonomousSecurityRun[]> {
    return (await this.store.listJson<AutonomousSecurityRun>('autonomous-security-runs'))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, Math.max(1, Math.min(limit, 100)));
  }
}

function sanitizeHosts(hosts: string[]): string[] {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))]
    .filter((host) => /^[a-z0-9.-]+(?::\d{1,5})?$/.test(host))
    .slice(0, 100);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
