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
  ruleId: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  status: FindingStatus;
  confidence: 'signal';
  createdAt: string;
  description: string;
  remediation: string;
  evidence: EvidenceSnippet[];
  route?: Pick<WorkspaceRoute, 'method' | 'path'>;
  source?: Pick<WorkspaceRoute, 'file' | 'line'>;
}

export interface EvidenceSnippet {
  kind: 'code';
  summary: string;
}

export interface StaticAuditReport {
  protocolVersion: number;
  scannedAt: string;
  sourceFiles: number;
  findings: SecurityFinding[];
}

export interface RetestResult {
  finding: SecurityFinding;
  present: boolean;
}

export interface TrafficRequest {
  id: string;
  method: string;
  url: string;
  host: string;
  status?: number;
  startedAt: string;
}

export interface TrafficInventory {
  protocolVersion: number;
  importedAt: string;
  source: 'har';
  hosts: string[];
  requests: TrafficRequest[];
  truncated: boolean;
}

export interface DaemonHealth {
  ok: true;
  protocolVersion: number;
  workspaceRoot: string;
}
