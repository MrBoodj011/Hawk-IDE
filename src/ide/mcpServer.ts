import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgentFleetRegistry } from './agentFleet.js';
import { buildAttackTwin } from './attackTwin.js';
import { AutonomousSecurityService } from './autonomousSecurity.js';
import { analyzeBehavioralSecurity, createBehavioralExperimentPlan } from './behavioralSecurity.js';
import { listDockerAgentProfiles, profileAgentInstances } from './dockerAgentProfiles.js';
import { DockerDesktopController } from './dockerDesktop.js';
import { DurableMcpTaskStore } from './durableMcpTaskStore.js';
import { governancePolicyHash, loadGovernancePolicy } from './governancePolicy.js';
import { evaluateHawkHook } from './governedHooks.js';
import { importHawkHealthReport } from './hawkReport.js';
import { listHawkIntegrations } from './integrationHub.js';
import { analyzeInteractionChaos } from './interactionChaos.js';
import { listMcpToolGovernance } from './mcpGovernance.js';
import {
  errorMessage,
  mcpHelp,
  parseMcpServerArgs,
  textResult,
  toolError,
} from './mcpServerSupport.js';
import { McpTrustPlatform } from './mcpTrust.js';
import { estimateParallelExecution } from './orchestrationEstimate.js';
import { HawkDockerOrchestrator } from './orchestrator.js';
import { privacySpeedPosture } from './privacySpeed.js';
import { ProjectLearningLedger } from './projectLearning.js';
import { IDE_PROTOCOL_VERSION, type WorkspaceInventory } from './protocol.js';
import { scanProtocolSurfaces } from './protocolIntelligence.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import { SandboxVulnerabilityReproducer } from './sandboxReproduction.js';
import { buildUnifiedSecurityGraph } from './securityGraph.js';
import {
  type SecurityTestTemplateId,
  createSecurityTestPlan,
  listSecurityTestTemplates,
  runApprovedSecurityTest,
} from './securityTesting.js';
import { GovernedSecurityToolRunner, type SecurityToolRunPlan } from './securityToolRunner.js';
import { SmartMcpBrain } from './smartBrain.js';
import { createCoreCapabilityExecutor } from './smartExecutor.js';
import { registerSmartMcp } from './smartMcp.js';
import { planSpecialistSwarm } from './specialistSwarm.js';
import { scanWorkspaceSecurity } from './staticAudit.js';

const SERVER_NAME = 'hawk-ide';
const SERVER_VERSION = '0.7.0';

function printHelp(): void {
  process.stderr.write(mcpHelp(SERVER_VERSION));
}

async function main(): Promise<void> {
  const args = parseMcpServerArgs(process.argv.slice(2));
  if (args.showHelp) {
    printHelp();
    return;
  }

  const orchestrator = new HawkDockerOrchestrator(args.workspaceRoot);
  await orchestrator.initialize();
  const brainReference: { current?: SmartMcpBrain } = {};
  const executor = createCoreCapabilityExecutor(args.workspaceRoot, orchestrator, () => {
    if (!brainReference.current) throw new Error('Hawk Smart MCP Brain is not initialized');
    return brainReference.current;
  });
  const brain = new SmartMcpBrain(args.workspaceRoot, executor);
  brainReference.current = brain;
  await brain.initialize();
  const autonomousSecurity = new AutonomousSecurityService(args.workspaceRoot, brain.store);
  const agentFleet = new AgentFleetRegistry(brain.store);
  const mcpTrust = new McpTrustPlatform(brain.store);
  const learning = new ProjectLearningLedger(brain.store, args.workspaceRoot);
  const reproducer = new SandboxVulnerabilityReproducer(
    args.workspaceRoot,
    brain.store,
    orchestrator,
  );
  const securityToolRunner = new GovernedSecurityToolRunner({
    workspaceRoot: args.workspaceRoot,
    store: brain.store,
    orchestrator,
  });
  const durableTaskStore = new DurableMcpTaskStore(
    brain.store,
    () => new Date(),
    async (taskId, status) => {
      if (status !== 'cancelled') return;
      const mapping = await brain.store.readJson<{ runId: string }>('mcp-task-runs', taskId);
      if (mapping) await brain.runs.control(mapping.runId, 'cancel').catch(() => undefined);
    },
  );
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      taskStore: durableTaskStore,
      capabilities: {
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
      instructions:
        'Hawk is an evidence-driven security IDE for authorized workspaces. Start with hawk_capabilities_search or hawk_context_snapshot. Compile work with hawk_plan_create, respect policy decisions, bind approvals to the exact plan hash, and never promote a static signal without hawk_evidence_verify.',
    },
  );
  const dockerDesktop = new DockerDesktopController();
  brain.runs.onEvent(async (event) => {
    await Promise.allSettled([
      mcp.sendLoggingMessage({
        level: 'info',
        logger: 'hawk.smart-run',
        data: {
          runId: event.runId,
          sequence: event.sequence,
          type: event.type,
          at: event.at,
          hash: event.hash,
        },
      }),
      mcp.server.sendResourceUpdated({ uri: `hawk://run/${event.runId}/events` }),
    ]);
  });
  mcp.registerTool(
    'ide_route_inventory',
    {
      title: 'IDE route inventory',
      description:
        'Passively index Express, Fastify, and Next.js routes in the local workspace. This reads source text only and never starts the application.',
      inputSchema: {
        path_contains: z.string().optional().describe('Optional substring filter for route paths.'),
      },
    },
    async (input) => {
      const inventory = await scanWorkspaceRoutes(args.workspaceRoot);
      const query = input.path_contains?.toLowerCase();
      const routes = query
        ? inventory.routes.filter((route) => route.path.toLowerCase().includes(query))
        : inventory.routes;
      return textResult(JSON.stringify({ sourceFiles: inventory.sourceFiles, routes }, null, 2));
    },
  );
  mcp.registerTool(
    'hawk_integrations',
    {
      title: 'List Hawk integrations',
      description:
        'List GitHub, GitLab, Jira, Slack, Burp, Browser, CI/CD, Docker, and Kubernetes integration contracts with their governance mode.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify({ integrations: listHawkIntegrations() }, null, 2)),
  );
  mcp.registerTool(
    'hawk_privacy_posture',
    {
      title: 'Inspect Hawk privacy and speed posture',
      description:
        'Show local-first Ollama policy, bounded cache, persistent incremental index, memory budget, and redaction guarantees.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(privacySpeedPosture(), null, 2)),
  );
  mcp.registerTool(
    'hawk_learning_profile',
    {
      title: 'Inspect Hawk project learning profile',
      description:
        'Read the local, redacted learning profile built from findings, reproductions, fixes, tests, and decisions.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(await learning.profile(), null, 2)),
  );
  mcp.registerTool(
    'hawk_learning_query',
    {
      title: 'Query Hawk cross-project learning',
      description:
        'Find relevant redacted local evidence from this and previous projects without sending it to a hosted service.',
      inputSchema: {
        query: z.string().max(2_000),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async (input) =>
      textResult(
        JSON.stringify({ signals: await learning.query(input.query, input.limit) }, null, 2),
      ),
  );
  mcp.registerTool(
    'hawk_protocol_inventory',
    {
      title: 'Discover protocol and infrastructure surfaces',
      description:
        'Passively map GraphQL, WebSocket, gRPC, OpenAPI, identity, Kubernetes, Terraform, cloud IAM, and mobile API surfaces.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(await scanProtocolSurfaces(args.workspaceRoot), null, 2)),
  );
  mcp.registerTool(
    'hawk_attack_twin',
    {
      title: 'Build Hawk Attack Twin',
      description:
        'Build an evidence-aware attack-path model. Unreproduced paths remain hypotheses.',
      inputSchema: {},
    },
    async () => {
      try {
        const [routeScan, protocols, audit] = await Promise.all([
          scanWorkspaceRoutes(args.workspaceRoot),
          scanProtocolSurfaces(args.workspaceRoot),
          scanWorkspaceSecurity(args.workspaceRoot),
        ]);
        const inventory: WorkspaceInventory = {
          protocolVersion: IDE_PROTOCOL_VERSION,
          root: args.workspaceRoot,
          indexedAt: new Date().toISOString(),
          sourceFiles: routeScan.sourceFiles,
          routes: routeScan.routes,
        };
        const graph = await buildUnifiedSecurityGraph(brain.graph, {
          inventory,
          protocols,
          findings: audit.findings,
        });
        return textResult(
          JSON.stringify(
            buildAttackTwin({ inventory, protocols, graph, findings: audit.findings }),
            null,
            2,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_security_autopilot_plan',
    {
      title: 'Plan autonomous security discovery',
      description:
        'Create an exact hash-bound offline or captured-only mission. Planning does not execute stages.',
      inputSchema: {
        objective: z.string().min(1).max(2_000).optional(),
        network_policy: z.enum(['offline', 'captured-only']).optional(),
        scope_hosts: z.array(z.string().min(1).max(253)).max(100).optional(),
      },
    },
    async (input) =>
      textResult(
        JSON.stringify(
          await autonomousSecurity.createPlan({
            objective: input.objective,
            networkPolicy: input.network_policy,
            scopeHosts: input.scope_hosts,
          }),
          null,
          2,
        ),
      ),
  );
  mcp.registerTool(
    'hawk_security_autopilot_run',
    {
      title: 'Run approved autonomous security discovery',
      description:
        'Execute passive stages and stop at reproduction gates. Requires the exact plan id and hash.',
      inputSchema: {
        plan_id: z.string().min(1),
        plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
        approved: z.literal(true),
      },
    },
    async (input) => {
      try {
        let inventory: WorkspaceInventory | undefined;
        let protocols: Awaited<ReturnType<typeof scanProtocolSurfaces>> | undefined;
        let findings: Awaited<ReturnType<typeof scanWorkspaceSecurity>> | undefined;
        const run = await autonomousSecurity.run(
          { planId: input.plan_id, planHash: input.plan_hash, approved: input.approved },
          {
            inventory: async () => {
              const scan = await scanWorkspaceRoutes(args.workspaceRoot);
              inventory = {
                protocolVersion: IDE_PROTOCOL_VERSION,
                root: args.workspaceRoot,
                indexedAt: new Date().toISOString(),
                sourceFiles: scan.sourceFiles,
                routes: scan.routes,
              };
              return inventory;
            },
            protocols: async () => {
              protocols = await scanProtocolSurfaces(args.workspaceRoot);
              return protocols;
            },
            audit: async () => {
              findings = await scanWorkspaceSecurity(args.workspaceRoot);
              return findings;
            },
            attackTwin: async () => {
              if (!inventory || !protocols || !findings)
                throw new Error('Autopilot stages are incomplete');
              const graph = await buildUnifiedSecurityGraph(brain.graph, {
                inventory,
                protocols,
                findings: findings.findings,
              });
              return buildAttackTwin({
                inventory,
                protocols,
                graph,
                findings: findings.findings,
              });
            },
          },
        );
        return textResult(JSON.stringify(run, null, 2));
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_fleet_status',
    {
      title: 'Inspect Hawk multi-host fleet',
      description: 'Read authenticated worker health, capabilities, load and available slots.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(await agentFleet.snapshot(), null, 2)),
  );
  mcp.registerTool(
    'hawk_fleet_dispatch_plan',
    {
      title: 'Plan a multi-host fleet dispatch',
      description:
        'Schedule bounded tasks across authenticated healthy workers and bind them to immutable workspace and image digests. Planning never executes code.',
      inputSchema: {
        workspace_digest: z.string().regex(/^(?:sha256:)?[a-fA-F0-9]{64}$/),
        image_digest: z.string().regex(/^(?:sha256:)?[a-fA-F0-9]{64}$/),
        strategy: z.enum(['balanced', 'latency', 'throughput']).optional(),
        tasks: z
          .array(
            z.object({
              id: z.string().min(1).max(160),
              dependsOn: z.array(z.string().min(1).max(160)).max(100),
              requiredCapabilities: z.array(z.string().min(1).max(64)).max(32),
              preferredCapabilities: z.array(z.string().min(1).max(64)).max(32),
              priority: z.number().int().min(0).max(100),
              estimatedSeconds: z.number().int().min(1).max(86_400),
              cpu: z.number().min(0.1).max(100),
              memoryMb: z.number().int().min(16).max(1_048_576),
            }),
          )
          .min(1)
          .max(1_000),
      },
    },
    async (input) => {
      try {
        return textResult(
          JSON.stringify(
            await agentFleet.planDispatch({
              tasks: input.tasks,
              workspaceDigest: input.workspace_digest,
              imageDigest: input.image_digest,
              strategy: input.strategy,
            }),
            null,
            2,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_mcp_trust_inspect',
    {
      title: 'Inspect an MCP trust manifest',
      description:
        'Verify the declared artifact digest, Ed25519 signature, capabilities, network policy and trust pin.',
      inputSchema: {
        manifest: z.record(z.unknown()),
        actual_artifact_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
      },
    },
    async (input) => {
      try {
        return textResult(
          JSON.stringify(
            await mcpTrust.inspect(input.manifest, input.actual_artifact_sha256),
            null,
            2,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_memory_posture',
    {
      title: 'Inspect provenance memory posture',
      description: 'Read counts of active, stale and revoked provenance-bound Hawk memories.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(await brain.memory.posture(), null, 2)),
  );
  mcp.registerTool(
    'hawk_interaction_chaos_analyze',
    {
      title: 'Analyze rapid UI interactions and duplicate mutations',
      description:
        'Correlate sanitized captured click/submit metadata with already-observed mutation requests. This is captured-only analysis: it never clicks a page or sends target traffic.',
      inputSchema: {
        interactions: z
          .array(
            z.object({
              id: z.string().min(1).max(160),
              kind: z.enum(['click', 'submit']),
              url: z.string().url().max(4_096),
              tab_id: z.number().int().optional(),
              occurred_at: z.number().int().nonnegative(),
              trusted: z.boolean().optional().default(true),
              detail: z.number().int().min(0).max(10).optional(),
              target: z.object({
                fingerprint: z.string().min(1).max(240),
                tag: z.string().min(1).max(32),
                role: z.string().max(64).optional(),
                input_type: z.string().max(32).optional(),
                disabled: z.boolean().optional(),
              }),
            }),
          )
          .max(5_000),
        mutation_requests: z
          .array(
            z.object({
              id: z.string().min(1).max(160),
              method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
              url: z.string().url().max(4_096),
              tab_id: z.number().int().optional(),
              initiator: z.string().url().max(4_096).optional(),
              status: z.number().int().min(100).max(599).optional(),
              occurred_at: z.number().int().nonnegative(),
            }),
          )
          .max(5_000),
        rapid_window_ms: z.number().int().min(100).max(5_000).optional(),
        request_window_ms: z.number().int().min(250).max(10_000).optional(),
        minimum_burst: z.number().int().min(2).max(20).optional(),
      },
    },
    async (input) =>
      textResult(
        JSON.stringify(
          analyzeInteractionChaos(
            input.interactions.map((event) => ({
              id: event.id,
              kind: event.kind,
              url: event.url,
              tabId: event.tab_id,
              occurredAt: event.occurred_at,
              receivedAt: event.occurred_at,
              trusted: event.trusted,
              detail: event.detail ?? 0,
              target: {
                fingerprint: event.target.fingerprint,
                tag: event.target.tag,
                role: event.target.role,
                inputType: event.target.input_type,
                disabled: event.target.disabled === true,
              },
            })),
            input.mutation_requests.map((request) => ({
              id: request.id,
              source: 'webRequest',
              method: request.method,
              url: request.url,
              tabId: request.tab_id,
              initiator: request.initiator,
              status: request.status,
              timeStart: request.occurred_at,
              receivedAt: request.occurred_at,
            })),
            {
              rapidWindowMs: input.rapid_window_ms,
              requestWindowMs: input.request_window_ms,
              minimumBurst: input.minimum_burst,
            },
          ),
          null,
          2,
        ),
      ),
  );
  mcp.registerTool(
    'hawk_behavioral_lab_analyze',
    {
      title: 'Build the Hawk Behavioral Intelligence model',
      description:
        'Build a captured-and-static state machine, invariants, race plans, deterministic replays, accessibility and client-state scenarios, mutation plans, failure timeline, and project digital twin. This tool sends no target traffic.',
      inputSchema: {
        routes: z
          .array(
            z.object({
              method: z.string().min(1).max(16),
              path: z.string().min(1).max(2_000),
              file: z.string().min(1).max(2_000),
              line: z.number().int().min(1).max(10_000_000),
              framework: z
                .enum(['express', 'fastify', 'next-app', 'next-pages'])
                .optional()
                .default('express'),
            }),
          )
          .max(2_000),
        interactions: z
          .array(
            z.object({
              id: z.string().min(1).max(160),
              kind: z.enum(['click', 'submit']),
              url: z.string().url().max(4_096),
              tab_id: z.number().int().optional(),
              occurred_at: z.number().int().nonnegative().max(8_640_000_000_000_000),
              trusted: z.boolean().optional().default(true),
              detail: z.number().int().min(0).max(10).optional().default(1),
              target: z.object({
                fingerprint: z.string().min(1).max(240),
                tag: z.string().min(1).max(32),
                role: z.string().max(64).optional(),
                input_type: z.string().max(32).optional(),
                disabled: z.boolean().optional().default(false),
              }),
            }),
          )
          .max(2_000),
        mutation_requests: z
          .array(
            z.object({
              id: z.string().min(1).max(160),
              method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
              url: z.string().url().max(4_096),
              initiator: z.string().url().max(4_096).optional(),
              tab_id: z.number().int().optional(),
              status: z.number().int().min(100).max(599).optional(),
              occurred_at: z.number().int().nonnegative().max(8_640_000_000_000_000),
            }),
          )
          .max(2_000),
        objective: z.string().min(1).max(1_000).optional(),
        plan_mode: z.enum(['passive', 'authorized-active']).optional(),
        allowed_hosts: z.array(z.string().max(2_000)).max(100).optional(),
        max_concurrency: z.number().int().min(1).max(10).optional(),
        max_requests: z.number().int().min(0).max(100).optional(),
      },
    },
    async (input) => {
      const interactions = input.interactions.map((event) => ({
        id: event.id,
        kind: event.kind,
        url: event.url,
        tabId: event.tab_id,
        occurredAt: event.occurred_at,
        receivedAt: event.occurred_at,
        trusted: event.trusted,
        detail: event.detail,
        target: {
          fingerprint: event.target.fingerprint,
          tag: event.target.tag,
          role: event.target.role,
          inputType: event.target.input_type,
          disabled: event.target.disabled,
        },
      }));
      const capturedRequests = input.mutation_requests.map((request) => ({
        id: request.id,
        source: 'webRequest' as const,
        method: request.method,
        url: request.url,
        initiator: request.initiator,
        tabId: request.tab_id,
        status: request.status,
        timeStart: request.occurred_at,
        receivedAt: request.occurred_at,
      }));
      const interactionChaos = analyzeInteractionChaos(interactions, capturedRequests);
      const report = analyzeBehavioralSecurity({
        inventory: {
          protocolVersion: IDE_PROTOCOL_VERSION,
          root: 'mcp://explicit-input',
          indexedAt: new Date().toISOString(),
          sourceFiles: new Set(input.routes.map((route) => route.file)).size,
          routes: input.routes,
        },
        traffic: {
          protocolVersion: IDE_PROTOCOL_VERSION,
          importedAt: new Date().toISOString(),
          source: 'live',
          hosts: [...new Set(input.mutation_requests.map((request) => new URL(request.url).host))],
          requests: input.mutation_requests.map((request) => ({
            id: request.id,
            method: request.method,
            url: request.url,
            host: new URL(request.url).host,
            status: request.status,
            startedAt: new Date(request.occurred_at).toISOString(),
            source: 'browser',
            initiator: request.initiator,
          })),
          truncated: false,
          live: true,
        },
        interactions,
        interactionChaos,
      });
      const plan = input.objective
        ? createBehavioralExperimentPlan(report, {
            objective: input.objective,
            mode: input.plan_mode,
            allowedHosts: input.allowed_hosts,
            maxConcurrency: input.max_concurrency,
            maxRequests: input.max_requests,
          })
        : undefined;
      return textResult(JSON.stringify({ report, ...(plan ? { plan } : {}) }, null, 2));
    },
  );
  mcp.registerTool(
    'hawk_agent_hook_evaluate',
    {
      title: 'Evaluate a governed Hawk agent hook',
      description:
        'Evaluate deterministic lifecycle policy before or after a tool, on agent stop, or on failure. Raw arguments are hashed and not retained in the result.',
      inputSchema: {
        event: z.enum([
          'sessionStart',
          'sessionEnd',
          'userPromptSubmitted',
          'preToolUse',
          'postToolUse',
          'agentStop',
          'subagentStop',
          'errorOccurred',
        ]),
        tool: z.string().max(160).optional(),
        arguments: z.record(z.unknown()).optional(),
        approved: z.boolean().optional(),
        outcome: z.enum(['success', 'failure']).optional(),
        error: z.string().max(2_000).optional(),
      },
    },
    async (input) => textResult(JSON.stringify(evaluateHawkHook(input), null, 2)),
  );
  mcp.registerTool(
    'hawk_specialist_swarm_plan',
    {
      title: 'Plan the Hawk specialist agent swarm',
      description:
        'Plan eight scoped specialists for business logic, races, authorization, frontend reliability, API contracts, debugging, fixing, and independent verification. Planning starts no workers.',
      inputSchema: {
        objective: z.string().min(1).max(1_000),
        max_parallel: z.number().int().min(1).max(8).optional(),
      },
    },
    async (input) =>
      textResult(
        JSON.stringify(
          planSpecialistSwarm({
            objective: input.objective,
            maxParallel: input.max_parallel,
          }),
          null,
          2,
        ),
      ),
  );
  mcp.registerTool(
    'hawk_security_test_templates',
    {
      title: 'List governed security-test templates',
      description:
        'List bounded security tests. Every test is approval-bound; offline and captured-only tests never generate target traffic.',
      inputSchema: {},
    },
    async () =>
      textResult(JSON.stringify({ templates: await listSecurityTestTemplates() }, null, 2)),
  );
  mcp.registerTool(
    'hawk_security_test_plan',
    {
      title: 'Plan a governed security test',
      description:
        'Create a deterministic SHA-256 plan for a passive, captured-only, dependency, or sandbox hand-off test. Planning never executes project code.',
      inputSchema: {
        template_id: z.enum([
          'static-code',
          'route-coverage',
          'dependency-manifest',
          'sandbox-signal',
        ]),
        scope_hosts: z.array(z.string().min(1).max(253)).max(32).optional(),
        max_requests_per_second: z.number().min(0).max(1_000).optional(),
      },
    },
    async (input) => {
      try {
        return textResult(
          JSON.stringify(
            await createSecurityTestPlan({
              workspaceRoot: args.workspaceRoot,
              templateId: input.template_id as SecurityTestTemplateId,
              scopeHosts: input.scope_hosts,
              maxRequestsPerSecond: input.max_requests_per_second,
            }),
            null,
            2,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_security_test_run',
    {
      title: 'Run an approved security test',
      description:
        'Run the exact approved passive/captured-only security-test plan. No target request is replayed or generated; sandbox-signal remains a hand-off plan.',
      inputSchema: {
        template_id: z.enum([
          'static-code',
          'route-coverage',
          'dependency-manifest',
          'sandbox-signal',
        ]),
        scope_hosts: z.array(z.string().min(1).max(253)).max(32).optional(),
        max_requests_per_second: z.number().min(0).max(1_000).optional(),
        approval_hash: z.string().regex(/^[a-f0-9]{64}$/),
        approved: z.literal(true),
      },
    },
    async (input) => {
      try {
        const plan = await createSecurityTestPlan({
          workspaceRoot: args.workspaceRoot,
          templateId: input.template_id as SecurityTestTemplateId,
          scopeHosts: input.scope_hosts,
          maxRequestsPerSecond: input.max_requests_per_second,
        });
        return textResult(
          JSON.stringify(
            await runApprovedSecurityTest({
              workspaceRoot: args.workspaceRoot,
              plan,
              approvalHash: input.approval_hash,
              approved: input.approved,
            }),
            null,
            2,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_governance_policy',
    {
      title: 'Inspect Hawk governance policy',
      description:
        'Read .hawk/governance.json or the safe default policy and return its content hash. This never changes policy.',
      inputSchema: {},
    },
    async () => {
      try {
        const policy = await loadGovernancePolicy(args.workspaceRoot);
        return textResult(
          JSON.stringify({ policy, policyHash: governancePolicyHash(policy) }, null, 2),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_mcp_registry',
    {
      title: 'Inspect Hawk MCP governance registry',
      description: 'List Hawk tools with risk, approval, mutation, and network metadata.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify({ tools: listMcpToolGovernance() }, null, 2)),
  );
  mcp.registerTool(
    'hawk_docker_agent_profiles',
    {
      title: 'List bounded Docker agent profiles',
      description:
        'List safe local Docker worker pool presets with capability, resource, and network boundaries.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify({ profiles: listDockerAgentProfiles() }, null, 2)),
  );
  mcp.registerTool(
    'hawk_supply_chain_health',
    {
      title: 'Hawk supply-chain health',
      description:
        'Read the sanitized local .hawk/health.json import created from a Hawk health report. This never contacts GitHub and does not expose credentials or raw alert payloads.',
      inputSchema: {},
    },
    async () => {
      try {
        const report = importHawkHealthReport(
          JSON.parse(await readFile(join(args.workspaceRoot, '.hawk', 'health.json'), 'utf8')),
        );
        return textResult(JSON.stringify(report, null, 2));
      } catch (err) {
        return textResult(
          JSON.stringify({
            available: false,
            message: `No local Hawk health report: ${errorMessage(err)}`,
          }),
        );
      }
    },
  );
  mcp.registerTool(
    'ide_static_audit',
    {
      title: 'IDE local static audit',
      description:
        'Run a passive, redacted code audit for high-signal insecure patterns. Results are suspected signals requiring manual validation, not confirmed vulnerabilities.',
      inputSchema: {
        severity: z
          .enum(['critical', 'high', 'medium', 'low', 'info'])
          .optional()
          .describe('Optional exact severity filter.'),
      },
    },
    async (input) => {
      const report = await scanWorkspaceSecurity(args.workspaceRoot);
      const severity = input.severity;
      const findings = severity
        ? report.findings.filter((finding) => finding.severity === severity)
        : report.findings;
      return textResult(
        JSON.stringify(
          {
            scannedAt: report.scannedAt,
            sourceFiles: report.sourceFiles,
            validationRequired: true,
            findings,
          },
          null,
          2,
        ),
      );
    },
  );
  mcp.registerTool(
    'hawk_reproduction_plan',
    {
      title: 'Plan an offline sandbox reproduction',
      description:
        'Create an expiring, hash-bound plan for a static finding or a generic operator-supplied control/reproduction command pair. Generic commands are direct argv from an allow-list and run in an existing local Docker image with a read-only workspace, no network, dropped capabilities, and bounded resources. Planning does not execute code.',
      inputSchema: {
        finding_id: z.string().min(1).max(256),
        image: z.string().min(1).max(256).optional().default('hawk-worker:local'),
        generic: z
          .object({
            mode: z
              .enum(['command', 'http', 'unit-test', 'fuzz', 'protocol', 'dependency'])
              .optional(),
            control: z.array(z.string().min(1).max(1_000)).min(1).max(32),
            reproduction: z.array(z.string().min(1).max(1_000)).min(1).max(32),
            controlExpectedExitCode: z.number().int().min(0).max(255).optional(),
            reproductionExpectedExitCode: z.number().int().min(0).max(255).optional(),
            label: z.string().min(1).max(160).optional(),
          })
          .optional(),
      },
    },
    async (input) => {
      try {
        const report = await scanWorkspaceSecurity(args.workspaceRoot);
        const finding = report.findings.find((candidate) => candidate.id === input.finding_id);
        if (!finding) throw new Error(`Current static finding not found: ${input.finding_id}`);
        return textResult(
          JSON.stringify(await reproducer.createPlan(finding, input.image, input.generic), null, 2),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_security_adapter_plan',
    {
      title: 'Plan an official security adapter run',
      description:
        'Create a hash-bound, expiring Docker plan for CodeQL, Semgrep, ZAP, Nuclei, Trivy, or OSS-Fuzz. Planning never executes the adapter.',
      inputSchema: {
        adapter: z.enum(['codeql', 'semgrep', 'zap', 'nuclei', 'trivy', 'oss-fuzz']),
        image: z.string().min(1).max(255),
        target: z.string().min(1).max(500),
        args: z.array(z.string().min(1).max(2_000)).max(64),
        network_mode: z.enum(['none', 'restricted']).optional(),
        allowed_hosts: z.array(z.string().min(1).max(253)).max(64).optional(),
        approved_external_access: z.literal(true).optional(),
      },
    },
    async (input) => {
      try {
        return textResult(
          JSON.stringify(
            await securityToolRunner.createPlan({
              adapter: input.adapter,
              image: input.image,
              target: input.target,
              args: input.args,
              networkMode: input.network_mode,
              allowedHosts: input.allowed_hosts,
              ...(input.approved_external_access ? { approvedExternalAccess: true } : {}),
            }),
            null,
            2,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_security_adapter_run',
    {
      title: 'Run an approved official security adapter',
      description:
        'Execute the exact stored adapter plan after explicit operator approval and import bounded SARIF findings.',
      inputSchema: {
        approved: z.literal(true),
        plan: z.record(z.unknown()),
      },
    },
    async (input) => {
      try {
        return textResult(
          JSON.stringify(
            await securityToolRunner.execute(
              input.plan as unknown as SecurityToolRunPlan,
              input.approved,
            ),
            null,
            2,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_reproduction_execute',
    {
      title: 'Execute an approved offline sandbox reproduction',
      description:
        'Execute the exact approved plan through baseline, safe negative-control, and deterministic reproduction gates. A reproduced signal remains unverified until independent identity, impact, scope, and review gates pass.',
      inputSchema: {
        finding_id: z.string().min(1).max(256),
        plan_id: z.string().regex(/^repro-plan-[a-f0-9-]{36}$/),
        plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
        approved: z.literal(true),
      },
    },
    async (input) => {
      try {
        const report = await scanWorkspaceSecurity(args.workspaceRoot);
        const finding = report.findings.find((candidate) => candidate.id === input.finding_id);
        if (!finding) throw new Error(`Current static finding not found: ${input.finding_id}`);
        return textResult(
          JSON.stringify(
            await reproducer.execute(finding, {
              planId: input.plan_id,
              planHash: input.plan_hash,
              approved: input.approved,
            }),
            null,
            2,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_reproductions_list',
    {
      title: 'List sandbox reproduction history',
      description:
        'List persisted offline reproduction attempts and their proof-gate status. Results never imply that a vulnerability was independently verified.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
    },
    async (input) =>
      textResult(JSON.stringify({ reproductions: await reproducer.list(input.limit) }, null, 2)),
  );
  mcp.registerTool(
    'hawk_parallel_estimate',
    {
      title: 'Estimate a Hawk parallel task graph',
      description:
        'Estimate the scheduling floor, critical path, and theoretical speedup for a proposed dependency graph before starting containers. This is advisory and does not execute work.',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              estimated_minutes: z.number().positive().max(43_200),
              depends_on: z.array(z.string()).max(32).optional(),
            }),
          )
          .min(1)
          .max(64),
        max_parallel: z.number().int().min(1).max(32),
        startup_seconds_per_task: z.number().nonnegative().max(300).optional(),
      },
    },
    async (input) => {
      try {
        return textResult(
          JSON.stringify(
            estimateParallelExecution(
              input.tasks.map((task) => ({
                id: task.id,
                estimatedMinutes: task.estimated_minutes,
                dependsOn: task.depends_on,
              })),
              input.max_parallel,
              input.startup_seconds_per_task,
            ),
            null,
            2,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_parallel_runtime',
    {
      title: 'Hawk parallel runtime status',
      description:
        'Check whether the local Docker daemon is ready for isolated Hawk worker orchestration. This does not start containers.',
      inputSchema: {},
    },
    async () => {
      const runtime = await orchestrator.availability();
      return textResult(
        JSON.stringify(
          {
            ...runtime,
            scheduler: orchestrator.schedulerStatus(),
            isolation: {
              workspace: 'read-only',
              output: '.hawk/orchestrations/<run>/<task>',
              network: 'none by default; restricted allowlist proxy requires explicit approval',
              capabilities: 'dropped',
            },
          },
          null,
          2,
        ),
      );
    },
  );
  mcp.registerTool(
    'hawk_scheduler_status',
    {
      title: 'Inspect the distributed Hawk agent scheduler',
      description:
        'Read Docker agent instances, capabilities, health, load, resource reservations, leases, and recent placement decisions without changing runtime state.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(orchestrator.schedulerStatus(), null, 2)),
  );
  mcp.registerTool(
    'hawk_docker_desktop_status',
    {
      title: 'Read Docker Desktop lifecycle status',
      description:
        'Read Docker Desktop application status without starting or stopping it. Use this after an asynchronous lifecycle request.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(await dockerDesktop.status(), null, 2)),
  );
  mcp.registerTool(
    'hawk_docker_desktop_start',
    {
      title: 'Start Docker Desktop for Hawk workers',
      description:
        'Request an asynchronous start of the local Docker Desktop engine. This changes host application state and requires explicit operator approval. Poll hawk_parallel_runtime until workers are available.',
      inputSchema: {
        approved: z
          .literal(true)
          .describe('Explicit confirmation that Docker Desktop may be started on this host.'),
      },
    },
    async () => {
      try {
        return textResult(JSON.stringify(await dockerDesktop.start(), null, 2));
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_docker_desktop_stop',
    {
      title: 'Stop Docker Desktop after Hawk work',
      description:
        'Stop Docker Desktop after worker runs finish. This can stop unrelated containers owned by the operator, so the caller must explicitly acknowledge that impact. Refuses while Hawk runs are active unless force is true.',
      inputSchema: {
        approved: z.literal(true),
        acknowledge_stops_other_containers: z.literal(true),
        force: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        const active = orchestrator
          .list()
          .filter((run) => run.status === 'queued' || run.status === 'running');
        if (active.length > 0 && input.force !== true) {
          throw new Error(
            `Docker Desktop cannot stop while ${active.length} Hawk run(s) are active; cancel them or set force`,
          );
        }
        if (active.length > 0) {
          await Promise.all(active.map((run) => orchestrator.cancel(run.id)));
        }
        return textResult(JSON.stringify(await dockerDesktop.stop(input.force === true), null, 2));
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_parallel_start',
    {
      title: 'Start isolated parallel Hawk workers',
      description:
        'Start a background dependency graph of independent tasks in isolated Docker containers. The image must already exist locally. Workers receive a read-only workspace, write only to per-task artifact folders, use CPU/RAM/PID/time limits, and are removed when done. Network is none by default; approved external access must use the restricted allowlist proxy. Credential inheritance also requires explicit approval. Use this only for authorized work.',
      inputSchema: {
        image: z
          .string()
          .min(1)
          .max(255)
          .describe('Existing local Docker image. Hawk never pulls images automatically.'),
        tasks: z
          .array(
            z.object({
              id: z
                .string()
                .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
                .describe('Unique stable task id.'),
              title: z.string().min(1).max(160),
              command: z
                .array(z.string().min(1).max(4096))
                .min(1)
                .max(64)
                .describe('Executable and arguments passed directly without a host shell.'),
              depends_on: z.array(z.string()).max(32).optional(),
              timeout_seconds: z.number().int().min(10).max(43_200).optional(),
              retries: z.number().int().min(0).max(3).optional(),
              required_capabilities: z
                .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/))
                .max(16)
                .optional(),
              preferred_capabilities: z
                .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/))
                .max(16)
                .optional(),
              priority: z.number().int().min(0).max(100).optional(),
              estimated_seconds: z.number().int().min(1).max(86_400).optional(),
            }),
          )
          .min(1)
          .max(64),
        max_parallel: z.number().int().min(1).max(32).optional(),
        cpu_per_worker: z.number().min(0.25).max(8).optional(),
        memory_mb_per_worker: z.number().int().min(128).max(16_384).optional(),
        artifact_mb_per_worker: z
          .number()
          .int()
          .min(32)
          .max(4_096)
          .optional()
          .describe('Hard tmpfs ceiling for one worker artifact directory. Defaults to 512 MB.'),
        network_mode: z
          .enum(['none', 'restricted', 'bridge'])
          .optional()
          .describe(
            'Container network mode. Defaults to none. Restricted uses an internal Docker network plus the Hawk allowlist proxy. Bridge is accepted only as a compatibility alias for restricted.',
          ),
        egress_allowed_hosts: z
          .array(
            z
              .string()
              .min(1)
              .max(253)
              .describe('Exact hostname/IP or a wildcard such as *.example.com.'),
          )
          .min(1)
          .max(64)
          .optional()
          .describe('Required allowlist whenever network_mode is restricted or bridge.'),
        egress_allowed_ports: z
          .array(z.number().int().min(1).max(65_535))
          .min(1)
          .max(16)
          .optional()
          .describe('Allowed TCP destination ports. Defaults to 80 and 443.'),
        egress_proxy_image: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Existing local Hawk proxy image. Defaults to hawk-egress-proxy:0.1.0.'),
        inherit_env: z
          .array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/))
          .max(16)
          .optional()
          .describe(
            'Names of host environment variables to pass into workers. Values are never returned by Hawk. Requires approved_external_access.',
          ),
        approved_external_access: z
          .boolean()
          .optional()
          .describe(
            'Must be true to enable network access or inherit credentials. This can trigger external API usage and cost across every parallel worker.',
          ),
        schedule_strategy: z.enum(['balanced', 'latency', 'throughput']).optional(),
        lease_seconds: z.number().int().min(15).max(600).optional(),
        agent_profile: z
          .enum(['balanced', 'security-sandbox', 'throughput'])
          .optional()
          .describe(
            'Optional bounded worker-pool preset. Explicit agent_instances take precedence.',
          ),
        agent_instances: z
          .array(
            z.object({
              id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
              capabilities: z
                .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/))
                .max(32)
                .optional(),
              max_concurrent: z.number().int().min(1).max(8).optional(),
              cpu_capacity: z.number().min(0.25).max(64).optional(),
              memory_mb_capacity: z.number().int().min(128).max(65_536).optional(),
            }),
          )
          .max(32)
          .optional()
          .describe(
            'Optional logical Docker agent pool. Every assignment still launches a separate isolated task container.',
          ),
      },
    },
    async (input) => {
      try {
        const profileInstances = input.agent_instances
          ? input.agent_instances.map((instance) => ({
              id: instance.id,
              capabilities: instance.capabilities,
              maxConcurrent: instance.max_concurrent,
              cpuCapacity: instance.cpu_capacity,
              memoryMbCapacity: instance.memory_mb_capacity,
            }))
          : input.agent_profile
            ? profileAgentInstances(input.agent_profile)
            : undefined;
        const run = await orchestrator.start({
          image: input.image,
          tasks: input.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            command: task.command,
            dependsOn: task.depends_on,
            timeoutSeconds: task.timeout_seconds,
            retries: task.retries,
            requiredCapabilities: task.required_capabilities,
            preferredCapabilities: task.preferred_capabilities,
            priority: task.priority,
            estimatedSeconds: task.estimated_seconds,
          })),
          maxParallel: input.max_parallel,
          cpuPerWorker: input.cpu_per_worker,
          memoryMbPerWorker: input.memory_mb_per_worker,
          artifactMbPerWorker: input.artifact_mb_per_worker,
          networkMode: input.network_mode,
          egressPolicy: input.egress_allowed_hosts
            ? {
                allowedHosts: input.egress_allowed_hosts,
                allowedPorts: input.egress_allowed_ports,
                proxyImage: input.egress_proxy_image,
              }
            : undefined,
          inheritEnv: input.inherit_env,
          approvedExternalAccess: input.approved_external_access,
          scheduleStrategy: input.schedule_strategy,
          leaseSeconds: input.lease_seconds,
          agentInstances: profileInstances,
        });
        return textResult(JSON.stringify(run, null, 2));
      } catch (err) {
        return toolError(err);
      }
    },
  );
  mcp.registerTool(
    'hawk_parallel_status',
    {
      title: 'Read a Hawk parallel run',
      description:
        'Read progress, task states, exit codes, artifact folders, and optionally capped local worker output for one background run.',
      inputSchema: {
        run_id: z.string().min(1),
        include_output: z.boolean().optional(),
      },
    },
    async (input) => {
      const run = orchestrator.get(input.run_id, input.include_output === true);
      return run
        ? textResult(JSON.stringify(run, null, 2))
        : toolError(new Error(`Unknown orchestration run: ${input.run_id}`));
    },
  );
  mcp.registerTool(
    'hawk_parallel_runs',
    {
      title: 'List Hawk parallel runs',
      description:
        'List restored and current background orchestration runs for this workspace. Worker output is omitted.',
      inputSchema: {},
    },
    async () => textResult(JSON.stringify({ runs: orchestrator.list() }, null, 2)),
  );
  mcp.registerTool(
    'hawk_parallel_cancel',
    {
      title: 'Cancel a Hawk parallel run',
      description:
        'Cancel pending work and force-remove running containers for one Hawk orchestration run.',
      inputSchema: { run_id: z.string().min(1) },
    },
    async (input) => {
      try {
        return textResult(JSON.stringify(await orchestrator.cancel(input.run_id), null, 2));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  registerSmartMcp(mcp, brain, args.workspaceRoot, orchestrator, durableTaskStore);
  await mcp.connect(new StdioServerTransport());
  const shutdown = (): void => {
    void Promise.allSettled([brain.runs.shutdown(), reproducer.shutdown()]).finally(() =>
      process.exit(0),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>(() => undefined);
}

main().catch((err: unknown) => {
  process.stderr.write(`[hawk-ide-mcp] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
