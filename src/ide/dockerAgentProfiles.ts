import type { DistributedAgentInstanceSpec } from './distributedScheduler.js';

export interface DockerAgentProfile {
  id: 'balanced' | 'security-sandbox' | 'throughput';
  title: string;
  description: string;
  maxParallel: number;
  cpuPerWorker: number;
  memoryMbPerWorker: number;
  networkMode: 'none' | 'restricted';
  capabilities: string[];
  safety: string;
}

const PROFILES: readonly DockerAgentProfile[] = [
  {
    id: 'balanced',
    title: 'Balanced local mesh',
    description: 'Conservative general-purpose agents for mixed code and security tasks.',
    maxParallel: 4,
    cpuPerWorker: 1,
    memoryMbPerWorker: 768,
    networkMode: 'none',
    capabilities: ['general', 'code', 'security', 'test'],
    safety: 'Read-only workspace, dropped capabilities, no network by default.',
  },
  {
    id: 'security-sandbox',
    title: 'Security sandbox mesh',
    description: 'Small isolated workers tuned for static analysis and offline reproductions.',
    maxParallel: 3,
    cpuPerWorker: 1,
    memoryMbPerWorker: 1_024,
    networkMode: 'none',
    capabilities: ['security', 'test'],
    safety: 'Offline-only workers with bounded CPU, memory, PIDs, artifacts, and lifetime.',
  },
  {
    id: 'throughput',
    title: 'Throughput mesh',
    description: 'Higher parallelism for independent deterministic checks on trusted local images.',
    maxParallel: 8,
    cpuPerWorker: 0.75,
    memoryMbPerWorker: 512,
    networkMode: 'none',
    capabilities: ['general', 'code', 'test'],
    safety: 'Still uses per-task isolation; operator must review image and command inputs.',
  },
] as const;

export function listDockerAgentProfiles(): DockerAgentProfile[] {
  return PROFILES.map((profile) => ({ ...profile, capabilities: [...profile.capabilities] }));
}

export function resolveDockerAgentProfile(id: DockerAgentProfile['id']): DockerAgentProfile {
  const profile = PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`unsupported Docker agent profile: ${id}`);
  return { ...profile, capabilities: [...profile.capabilities] };
}

export function profileAgentInstances(
  profileId: DockerAgentProfile['id'],
): DistributedAgentInstanceSpec[] {
  const profile = resolveDockerAgentProfile(profileId);
  return Array.from({ length: profile.maxParallel }, (_, index) => ({
    id: `${profile.id}-${String(index + 1).padStart(2, '0')}`,
    capabilities: [...profile.capabilities],
    maxConcurrent: 1,
    cpuCapacity: profile.cpuPerWorker,
    memoryMbCapacity: profile.memoryMbPerWorker,
  }));
}
