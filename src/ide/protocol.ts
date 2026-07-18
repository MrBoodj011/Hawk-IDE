/**
 * Stable data contracts shared by the desktop client and the local agent
 * daemon. The first milestone deliberately keeps the protocol small:
 * workspace inventory, health, and findings. New capabilities should extend
 * this module instead of coupling UI code to the agent runtime.
 */

export const IDE_PROTOCOL_VERSION = 5;

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
  completedAt?: string;
  elapsedMs?: number;
  source?: 'har' | 'browser' | 'burp';
  initiator?: string;
  type?: string;
}

export interface TrafficInventory {
  protocolVersion: number;
  importedAt: string;
  source: 'har' | 'live' | 'mixed';
  hosts: string[];
  requests: TrafficRequest[];
  truncated: boolean;
  live: boolean;
}

export interface HawkHealthSummary {
  repositories: number;
  maintenanceScore?: number;
  governanceScore?: number;
  highRiskRepositories: number;
  failedUpdatePulls: number;
  overdueSecurityAlerts: number;
  securityAlerts: number;
  criticalSecurityAlerts: number;
  highSecurityAlerts: number;
  sbomRepositories: number;
  trackedPackages: number;
  unknownPackageLicenses: number;
  securityUnknown: number;
  inspectionErrors: number;
}

export interface HawkRepositoryRisk {
  name: string;
  url?: string;
  score: number;
  level: 'critical' | 'high' | 'moderate' | 'low' | 'unknown';
  reasons: string[];
  securityAlerts: number | null;
  criticalAlerts: number;
  highAlerts: number;
  overdueSecurityAlerts: number;
  failedChecks: number;
  sbomPackages: number;
  unknownLicenses: number;
}

/** Sanitized, local-only import of a Hawk organization health report. */
export interface HawkHealthReport {
  protocolVersion: number;
  source: 'hawk-health-json';
  importedAt: string;
  generatedAt?: string;
  organization?: string;
  outcome?: string;
  summary: HawkHealthSummary;
  priorityQueue: HawkRepositoryRisk[];
}

export type WorkspaceScanTemplateId = 'passive-workspace' | 'runtime-observe' | 'release-gate';

export interface WorkspaceScanRateLimit {
  maxRequestsPerSecond: number;
  maxRequests: number;
}

/** A governed scan recipe. Templates never grant authority outside their declared policy. */
export interface WorkspaceScanTemplate {
  id: WorkspaceScanTemplateId;
  title: string;
  description: string;
  scope: WorkspaceScanTemplateId;
  mode: 'passive' | 'observe';
  requiresApproval: true;
  networkPolicy: 'offline' | 'captured-only';
  rateLimit: WorkspaceScanRateLimit;
  checks: string[];
}

export interface WorkspaceScanTemplatesResponse {
  protocolVersion: number;
  templates: WorkspaceScanTemplate[];
}

/** A transparent scan plan that is bound to an exact approval hash. */
export interface WorkspaceScanPlan {
  protocolVersion: number;
  createdAt: string;
  templateId: WorkspaceScanTemplateId;
  title: string;
  scope: WorkspaceScanTemplateId;
  workspaceRoot: string;
  requiresApproval: true;
  approvalHash: string;
  networkPolicy: 'offline' | 'captured-only';
  rateLimit: WorkspaceScanRateLimit;
  statement: string;
  checks: string[];
}

/** Result of an approved governed scan. It is not a vulnerability verdict. */
export interface WorkspaceScanReport {
  protocolVersion: number;
  id: string;
  status: 'completed';
  templateId: WorkspaceScanTemplateId;
  title: string;
  scope: WorkspaceScanTemplateId;
  approvalHash: string;
  createdAt: string;
  completedAt: string;
  reportPath: string;
  sourceFiles: number;
  routes: number;
  findings: SecurityFinding[];
  trafficRequests: number;
  hawkOrganization?: string;
  statement: string;
}

export type EvidencePackFormat = 'markdown' | 'html' | 'json' | 'sarif';

export interface EvidencePackArtifact {
  format: EvidencePackFormat;
  path: string;
  bytes: number;
  sha256: string;
}

/** Sanitized, portable evidence bundle generated only after explicit operator approval. */
export interface EvidencePackReport {
  protocolVersion: number;
  id: string;
  status: 'completed';
  createdAt: string;
  directoryPath: string;
  primaryReportPath: string;
  statement: string;
  sourceFiles: number;
  routes: number;
  observedRoutes: number;
  trafficRequests: number;
  findings: number;
  artifacts: EvidencePackArtifact[];
}

export type GovernedMissionProfile = 'review' | 'remediate' | 'authorized-validation';

export interface GovernedMissionNode {
  id: string;
  title: string;
  capabilityId: string;
  dependsOn: string[];
  parallelGroup: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  approvalRequired: boolean;
  modelClass: string;
}

/** A persisted Smart MCP-compatible plan. Creating it never starts execution. */
export interface GovernedMissionPlan {
  protocolVersion: number;
  id: string;
  goalId: string;
  profile: GovernedMissionProfile;
  objective: string;
  planHash: string;
  decision: 'allow' | 'require-approval' | 'deny';
  reasons: string[];
  allowedActions: string[];
  hosts: string[];
  maxParallel: number;
  estimatedMinutes: number;
  estimatedCostUsd: number;
  approvalRequired: boolean;
  nodes: GovernedMissionNode[];
  reportPath: string;
  createdAt: string;
}

export interface DaemonHealth {
  ok: true;
  protocolVersion: number;
  workspaceRoot: string;
}
