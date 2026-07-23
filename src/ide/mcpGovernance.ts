export interface McpToolGovernance {
  name: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval: boolean;
  mutatesState: boolean;
  network: 'none' | 'captured-only' | 'restricted';
  description: string;
}

const TOOLS: readonly McpToolGovernance[] = [
  {
    name: 'hawk_security_test_templates',
    risk: 'low',
    requiresApproval: false,
    mutatesState: false,
    network: 'none',
    description: 'List governed security-test recipes.',
  },
  {
    name: 'hawk_security_test_plan',
    risk: 'medium',
    requiresApproval: false,
    mutatesState: true,
    network: 'none',
    description: 'Create a hash-bound security-test plan.',
  },
  {
    name: 'hawk_security_test_run',
    risk: 'high',
    requiresApproval: true,
    mutatesState: true,
    network: 'captured-only',
    description: 'Run an approved passive/captured-only security test.',
  },
  {
    name: 'hawk_governance_policy',
    risk: 'low',
    requiresApproval: false,
    mutatesState: false,
    network: 'none',
    description: 'Inspect workspace governance policy and hash.',
  },
  {
    name: 'hawk_docker_agent_profiles',
    risk: 'low',
    requiresApproval: false,
    mutatesState: false,
    network: 'none',
    description: 'List safe Docker worker profiles.',
  },
  {
    name: 'hawk_parallel_start',
    risk: 'high',
    requiresApproval: true,
    mutatesState: true,
    network: 'restricted',
    description: 'Start bounded isolated Docker workers.',
  },
  {
    name: 'hawk_reproduction_execute',
    risk: 'critical',
    requiresApproval: true,
    mutatesState: true,
    network: 'none',
    description: 'Execute an approved offline reproduction gate.',
  },
  {
    name: 'hawk_attack_twin',
    risk: 'low',
    requiresApproval: false,
    mutatesState: false,
    network: 'none',
    description: 'Build an evidence-aware attack-path model from source, runtime and proof data.',
  },
  {
    name: 'hawk_security_autopilot_plan',
    risk: 'medium',
    requiresApproval: false,
    mutatesState: true,
    network: 'none',
    description: 'Create an exact hash-bound autonomous security mission plan.',
  },
  {
    name: 'hawk_security_autopilot_run',
    risk: 'high',
    requiresApproval: true,
    mutatesState: true,
    network: 'captured-only',
    description: 'Run approved passive discovery and pause before reproduction gates.',
  },
  {
    name: 'hawk_fleet_status',
    risk: 'low',
    requiresApproval: false,
    mutatesState: false,
    network: 'none',
    description: 'Inspect authenticated multi-host worker capacity and health.',
  },
  {
    name: 'hawk_fleet_dispatch_plan',
    risk: 'medium',
    requiresApproval: false,
    mutatesState: false,
    network: 'none',
    description: 'Bind ready tasks to authenticated workers, immutable inputs and short leases.',
  },
  {
    name: 'hawk_mcp_trust_inspect',
    risk: 'medium',
    requiresApproval: false,
    mutatesState: true,
    network: 'none',
    description: 'Verify MCP artifact digests, signatures, capabilities and rug-pull pins.',
  },
  {
    name: 'hawk_memory_posture',
    risk: 'low',
    requiresApproval: false,
    mutatesState: false,
    network: 'none',
    description: 'Inspect active, stale and revoked provenance-bound security memory.',
  },
  {
    name: 'hawk_privacy_posture',
    risk: 'low',
    requiresApproval: false,
    mutatesState: false,
    network: 'none',
    description: 'Inspect local-first Ollama, cache, index and redaction guarantees.',
  },
  {
    name: 'hawk_learning_profile',
    risk: 'low',
    requiresApproval: false,
    mutatesState: false,
    network: 'none',
    description: 'Inspect the redacted local and cross-project learning profile.',
  },
  {
    name: 'hawk_learning_query',
    risk: 'low',
    requiresApproval: false,
    mutatesState: false,
    network: 'none',
    description: 'Query redacted local learning evidence for agent context.',
  },
] as const;

export function listMcpToolGovernance(): McpToolGovernance[] {
  return TOOLS.map((tool) => ({ ...tool }));
}

export function getMcpToolGovernance(name: string): McpToolGovernance | undefined {
  const found = TOOLS.find((tool) => tool.name === name);
  return found ? { ...found } : undefined;
}
