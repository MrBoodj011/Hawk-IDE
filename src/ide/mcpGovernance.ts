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
] as const;

export function listMcpToolGovernance(): McpToolGovernance[] {
  return TOOLS.map((tool) => ({ ...tool }));
}

export function getMcpToolGovernance(name: string): McpToolGovernance | undefined {
  const found = TOOLS.find((tool) => tool.name === name);
  return found ? { ...found } : undefined;
}
