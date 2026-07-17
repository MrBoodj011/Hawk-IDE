/**
 * Stable data contracts shared by the desktop client and the local agent
 * daemon. The first milestone deliberately keeps the protocol small:
 * workspace inventory, health, and findings. New capabilities should extend
 * this module instead of coupling UI code to the agent runtime.
 */

export const IDE_PROTOCOL_VERSION = 1;

export type RouteFramework = 'express' | 'fastify' | 'next-app' | 'next-pages';

export interface WorkspaceRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: RouteFramework;
}

export interface WorkspaceInventory {
  protocolVersion: number;
  root: string;
  indexedAt: string;
  sourceFiles: number;
  routes: WorkspaceRoute[];
}

export type FindingStatus = 'suspected' | 'validated' | 'fixed' | 'retested';

export interface SecurityFinding {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  status: FindingStatus;
  createdAt: string;
  evidenceIds: string[];
  route?: Pick<WorkspaceRoute, 'method' | 'path'>;
  source?: Pick<WorkspaceRoute, 'file' | 'line'>;
}

export interface DaemonHealth {
  ok: true;
  protocolVersion: number;
  workspaceRoot: string;
}
