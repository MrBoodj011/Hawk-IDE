import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type DistributedTaskCandidate,
  scheduleDistributedAgents,
} from './distributedScheduler.js';
import type { DurableStore } from './durableStore.js';
import {
  type FleetDispatchPlan,
  type FleetNodeSnapshot,
  type FleetSnapshot,
  IDE_PROTOCOL_VERSION,
} from './protocol.js';

interface StoredFleetNode extends FleetNodeSnapshot {
  tokenHash: string;
}

export interface FleetRegistrationInput {
  approved: boolean;
  label: string;
  endpoint: string;
  fingerprint: string;
  capabilities: string[];
  platform: string;
  arch: string;
  maxConcurrent: number;
}

export class AgentFleetRegistry {
  constructor(
    private readonly store: DurableStore,
    private readonly now: () => Date = () => new Date(),
    private readonly offlineAfterMs = 45_000,
  ) {}

  async register(
    input: FleetRegistrationInput,
  ): Promise<{ node: FleetNodeSnapshot; token: string }> {
    if (!input.approved) throw new Error('Operator approval is required to enroll a fleet node');
    const endpoint = validateEndpoint(input.endpoint);
    const fingerprint = input.fingerprint.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(fingerprint))
      throw new Error('Fleet node requires a SHA-256 mTLS/public-key fingerprint');
    const token = randomBytes(32).toString('base64url');
    const at = this.now().toISOString();
    const node: StoredFleetNode = {
      id: `fleet-${randomUUID()}`,
      label: input.label.trim().slice(0, 160) || 'Hawk worker',
      endpoint,
      fingerprint,
      capabilities: sanitizeCapabilities(input.capabilities),
      platform: input.platform.trim().slice(0, 80) || 'unknown',
      arch: input.arch.trim().slice(0, 40) || 'unknown',
      maxConcurrent: Math.max(1, Math.min(64, Math.floor(input.maxConcurrent || 1))),
      activeTasks: 0,
      cpuPercent: 0,
      memoryMbAvailable: 0,
      status: 'online',
      registeredAt: at,
      lastHeartbeatAt: at,
      tokenHash: hash(token),
    };
    await this.store.writeJson('fleet-nodes', node.id, node);
    return { node: publicNode(node), token };
  }

  async heartbeat(input: {
    nodeId: string;
    token: string;
    fingerprint: string;
    activeTasks: number;
    cpuPercent: number;
    memoryMbAvailable: number;
    draining?: boolean;
  }): Promise<FleetNodeSnapshot> {
    const node = await this.store.readJson<StoredFleetNode>('fleet-nodes', input.nodeId);
    if (!node) throw new Error('Fleet node not found');
    if (node.status === 'revoked') throw new Error('Fleet node is revoked');
    if (!secureEqual(node.tokenHash, hash(input.token)))
      throw new Error('Invalid fleet node token');
    if (node.fingerprint !== input.fingerprint.trim().toLowerCase())
      throw new Error('Fleet node fingerprint changed');
    const updated: StoredFleetNode = {
      ...node,
      activeTasks: Math.max(0, Math.min(node.maxConcurrent, Math.floor(input.activeTasks))),
      cpuPercent: Math.max(0, Math.min(100, input.cpuPercent)),
      memoryMbAvailable: Math.max(0, Math.floor(input.memoryMbAvailable)),
      status: input.draining ? 'draining' : 'online',
      lastHeartbeatAt: this.now().toISOString(),
    };
    await this.store.writeJson('fleet-nodes', updated.id, updated);
    return publicNode(updated);
  }

  async snapshot(): Promise<FleetSnapshot> {
    const now = this.now().getTime();
    const nodes = (await this.store.listJson<StoredFleetNode>('fleet-nodes'))
      .map((node) => {
        if (
          node.status !== 'revoked' &&
          node.status !== 'draining' &&
          now - Date.parse(node.lastHeartbeatAt) > this.offlineAfterMs
        ) {
          return { ...node, status: 'offline' as const };
        }
        return node;
      })
      .map(publicNode)
      .sort((left, right) => left.label.localeCompare(right.label));
    const online = nodes.filter((node) => node.status === 'online');
    return {
      protocolVersion: IDE_PROTOCOL_VERSION,
      generatedAt: this.now().toISOString(),
      nodes,
      summary: {
        total: nodes.length,
        online: online.length,
        availableSlots: online.reduce(
          (sum, node) => sum + Math.max(0, node.maxConcurrent - node.activeTasks),
          0,
        ),
        activeTasks: nodes.reduce((sum, node) => sum + node.activeTasks, 0),
        capabilities: [...new Set(online.flatMap((node) => node.capabilities))].sort(),
      },
    };
  }

  async revoke(nodeId: string, approved: boolean): Promise<FleetNodeSnapshot> {
    if (!approved) throw new Error('Operator approval is required to revoke a fleet node');
    const node = await this.store.readJson<StoredFleetNode>('fleet-nodes', nodeId);
    if (!node) throw new Error('Fleet node not found');
    const revoked = { ...node, status: 'revoked' as const, activeTasks: 0 };
    await this.store.writeJson('fleet-nodes', node.id, revoked);
    return publicNode(revoked);
  }

  async planDispatch(input: {
    tasks: DistributedTaskCandidate[];
    workspaceDigest: string;
    imageDigest: string;
    strategy?: FleetDispatchPlan['strategy'];
  }): Promise<FleetDispatchPlan> {
    const workspaceDigest = validateDigest(input.workspaceDigest, 'workspace');
    const imageDigest = validateDigest(input.imageDigest, 'container image');
    const strategy = input.strategy ?? 'balanced';
    const snapshot = await this.snapshot();
    const online = snapshot.nodes.filter((node) => node.status === 'online');
    const tasks = input.tasks.slice(0, 1_000);
    const decisions = scheduleDistributedAgents(
      tasks,
      tasks,
      online.map((node) => ({
        id: node.id,
        capabilities: node.capabilities,
        maxConcurrent: node.maxConcurrent,
        cpuCapacity: 100,
        memoryMbCapacity: Math.max(256, node.memoryMbAvailable),
        activeTaskIds: Array.from({ length: node.activeTasks }, (_, index) => `active-${index}`),
        completedTasks: 0,
        failedTasks: 0,
        averageDurationMs: 0,
        healthy: true,
      })),
      strategy,
      snapshot.summary.availableSlots,
    );
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + 60_000).toISOString();
    const assignments = decisions.flatMap((decision) => {
      const node = online.find((candidate) => candidate.id === decision.instanceId);
      if (!node) return [];
      const material = {
        taskId: decision.taskId,
        nodeId: node.id,
        endpoint: node.endpoint,
        fingerprint: node.fingerprint,
        workspaceDigest,
        imageDigest,
        expiresAt,
      };
      return [
        {
          taskId: decision.taskId,
          nodeId: node.id,
          endpoint: node.endpoint,
          fingerprint: node.fingerprint,
          score: decision.score,
          reasons: decision.reasons,
          dispatchHash: hash(JSON.stringify(material)),
        },
      ];
    });
    const assigned = new Set(assignments.map((assignment) => assignment.taskId));
    return {
      protocolVersion: IDE_PROTOCOL_VERSION,
      id: `fleet-dispatch-${randomUUID()}`,
      createdAt: createdAt.toISOString(),
      expiresAt,
      strategy,
      workspaceDigest,
      imageDigest,
      assignments,
      unassignedTaskIds: tasks.map((task) => task.id).filter((id) => !assigned.has(id)),
      statement:
        'This immutable plan binds every task to a worker fingerprint, workspace digest, image digest and one-minute lease. It does not execute remote code.',
    };
  }
}

function validateEndpoint(value: string): string {
  const url = new URL(value.trim());
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    throw new Error('Remote fleet endpoints require HTTPS');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function sanitizeCapabilities(values: string[]): string[] {
  const output = [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]
    .filter((value) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value))
    .slice(0, 64);
  return output.length > 0 ? output : ['general'];
}

function publicNode(node: StoredFleetNode): FleetNodeSnapshot {
  const { tokenHash: _, ...visible } = node;
  return visible;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateDigest(value: string, label: string): string {
  const digest = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} digest must be SHA-256`);
  return digest;
}
