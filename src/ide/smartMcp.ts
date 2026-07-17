import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DurableMcpTaskStore } from './durableMcpTaskStore.js';
import { HAWK_MCP_APP_HTML, HAWK_MCP_APP_MIME, HAWK_MCP_APP_URI } from './missionControlApp.js';
import type { HawkDockerOrchestrator } from './orchestrator.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import type { SmartMcpBrain } from './smartBrain.js';
import type { HawkAction, SmartRun } from './smartTypes.js';
import { scanWorkspaceSecurity } from './staticAudit.js';

const actionSchema = z.enum([
  'read-workspace',
  'write-workspace',
  'run-local',
  'run-container',
  'network-access',
  'credential-access',
  'active-security-test',
]);
const structuredOutput = { data: z.unknown() };
const passiveAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const localWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export function registerSmartMcp(
  mcp: McpServer,
  brain: SmartMcpBrain,
  workspaceRoot: string,
  orchestrator: HawkDockerOrchestrator,
  durableTaskStore: DurableMcpTaskStore,
): void {
  mcp.registerTool(
    'hawk_capabilities_search',
    {
      title: 'Search the Hawk capability mesh',
      description:
        'Semantic entrypoint for discovering a small, relevant set of Hawk capabilities without loading every implementation schema into context.',
      inputSchema: {
        query: z.string().max(1_000).default(''),
        limit: z.number().int().min(1).max(20).optional(),
      },
      outputSchema: structuredOutput,
      annotations: passiveAnnotations,
    },
    async ({ query, limit }) =>
      structured({
        capabilities: brain.capabilities.search(query, limit),
        totalRegistered: brain.capabilities.list().length,
      }),
  );

  mcp.registerTool(
    'hawk_context_snapshot',
    {
      title: 'Build a redacted Hawk context snapshot',
      description:
        'Read the current workspace, static signals, route surface, imported traffic summary, git metadata, and active Smart MCP runs without executing project code.',
      inputSchema: {},
      outputSchema: structuredOutput,
      annotations: passiveAnnotations,
    },
    async () => structured(await contextSnapshot(workspaceRoot, brain)),
  );

  mcp.registerTool(
    'hawk_plan_create',
    {
      title: 'Compile an objective into a governed agent DAG',
      description:
        'Compile an objective and explicit scope into a typed GoalSpec, dependency DAG, budgets, risk labels, approval reasons, and immutable plan hash. This plans work but does not execute it.',
      inputSchema: {
        objective: z.string().min(1).max(1_000),
        repositories: z.array(z.string().max(512)).max(64).optional(),
        hosts: z.array(z.string().max(253)).max(128).optional(),
        routes: z.array(z.string().max(2_048)).max(256).optional(),
        identities: z.array(z.string().max(160)).max(64).optional(),
        allowed_actions: z.array(actionSchema).max(7).optional(),
        forbidden_actions: z.array(actionSchema).max(7).optional(),
        max_parallel: z.number().int().min(1).max(32).optional(),
        max_minutes: z.number().int().min(1).max(43_200).optional(),
        max_tokens: z.number().int().min(0).max(100_000_000).optional(),
        max_cost_usd: z.number().min(0).max(100_000).optional(),
        requests_per_second: z.number().min(0.01).max(1_000).optional(),
        data_policy: z.enum(['local-only', 'allow-hosted']).optional(),
        preferred_models: z.record(z.string().min(1).max(160)).optional(),
        approval_mode: z.enum(['never', 'on-risk', 'always']).optional(),
        success_criteria: z.array(z.string().max(500)).max(32).optional(),
        retention_days: z.number().int().min(1).max(3_650).optional(),
        capabilities: z.array(z.string().max(128)).max(32).optional(),
      },
      outputSchema: structuredOutput,
      annotations: localWriteAnnotations,
    },
    async (input) =>
      structured(
        await brain.createPlan(
          {
            objective: input.objective,
            repositories: input.repositories,
            hosts: input.hosts,
            routes: input.routes,
            identities: input.identities,
            allowedActions: input.allowed_actions as HawkAction[] | undefined,
            forbiddenActions: input.forbidden_actions as HawkAction[] | undefined,
            maxParallel: input.max_parallel,
            maxMinutes: input.max_minutes,
            maxTokens: input.max_tokens,
            maxCostUsd: input.max_cost_usd,
            requestsPerSecond: input.requests_per_second,
            dataPolicy: input.data_policy,
            preferredModels: input.preferred_models,
            approvalMode: input.approval_mode,
            successCriteria: input.success_criteria,
            retentionDays: input.retention_days,
          },
          input.capabilities,
        ),
      ),
  );

  mcp.registerTool(
    'hawk_plan_approve',
    {
      title: 'Approve one exact Hawk plan hash',
      description:
        'Create a short-lived approval bound to the exact goal, plan id, and SHA-256 plan hash. A changed plan requires a new approval.',
      inputSchema: {
        plan_id: z.string().min(1).max(160),
        expected_plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
        approved_by: z.string().min(1).max(160),
        ttl_minutes: z.number().int().min(1).max(1_440).optional(),
        confirm_exact_plan_reviewed: z.literal(true),
      },
      outputSchema: structuredOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      structured(
        await brain.approvePlan(
          input.plan_id,
          input.approved_by,
          input.expected_plan_hash,
          input.ttl_minutes,
        ),
      ),
  );

  mcp.registerTool(
    'hawk_run_start',
    {
      title: 'Start a durable Hawk agent run',
      description:
        'Start an approved immutable plan in the durable local engine. Independent nodes run in parallel; events, leases, artifacts, retries, and recovery survive MCP restarts.',
      inputSchema: {
        plan_id: z.string().min(1).max(160),
        execution_inputs: z.record(z.unknown()).optional(),
      },
      outputSchema: structuredOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) =>
      safeTool(async () => await brain.startRun(input.plan_id, input.execution_inputs)),
  );

  mcp.registerTool(
    'hawk_run_observe',
    {
      title: 'Observe durable Hawk runs',
      description:
        'Read one run or list recent runs with node progress, lease state, artifact URIs, and an optional tamper-evident event tail.',
      inputSchema: {
        run_id: z.string().max(160).optional(),
        include_events: z.boolean().optional(),
        event_limit: z.number().int().min(1).max(2_000).optional(),
      },
      outputSchema: structuredOutput,
      annotations: passiveAnnotations,
    },
    async (input) => {
      const runs = input.run_id
        ? [brain.runs.get(input.run_id)].filter((run): run is SmartRun => Boolean(run))
        : brain.runs.list();
      if (input.run_id && runs.length === 0) return toolError(`Unknown smart run: ${input.run_id}`);
      const events =
        input.run_id && input.include_events
          ? await brain.runs.events(input.run_id, input.event_limit)
          : undefined;
      return structured({ runs, events });
    },
  );

  mcp.registerTool(
    'hawk_run_control',
    {
      title: 'Pause, resume, or cancel a Hawk run',
      description:
        'Control scheduling for one durable run. Pause stops new nodes, resume reattaches the lease, and cancel prevents pending work from starting.',
      inputSchema: {
        run_id: z.string().min(1).max(160),
        action: z.enum(['pause', 'resume', 'cancel']),
      },
      outputSchema: structuredOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: HAWK_MCP_APP_URI, visibility: ['model', 'app'] } },
    },
    async (input) => safeTool(async () => await brain.runs.control(input.run_id, input.action)),
  );

  mcp.registerTool(
    'hawk_evidence_verify',
    {
      title: 'Independently verify a security finding',
      description:
        'Apply mandatory proof gates. Hawk will not promote a signal to verified unless baseline, reproduction, independent reproduction, identity, impact, scope, safe-side-effect, redaction, and evidence gates all pass.',
      inputSchema: {
        finding_id: z.string().min(1).max(160),
        baseline_observed: z.boolean(),
        reproduced: z.boolean(),
        independent_reproduction: z.boolean(),
        identity_valid: z.boolean(),
        impact_demonstrated: z.boolean(),
        within_scope: z.boolean(),
        no_unsafe_side_effects: z.boolean(),
        secrets_redacted: z.boolean(),
        evidence_uris: z.array(z.string().max(2_000)).min(1).max(100),
        verifier: z.string().min(1).max(160),
        notes: z.string().max(5_000).optional(),
      },
      outputSchema: structuredOutput,
      annotations: localWriteAnnotations,
    },
    async (input) =>
      structured(
        await brain.verifier.verify({
          findingId: input.finding_id,
          baselineObserved: input.baseline_observed,
          reproduced: input.reproduced,
          independentReproduction: input.independent_reproduction,
          identityValid: input.identity_valid,
          impactDemonstrated: input.impact_demonstrated,
          withinScope: input.within_scope,
          noUnsafeSideEffects: input.no_unsafe_side_effects,
          secretsRedacted: input.secrets_redacted,
          evidenceUris: input.evidence_uris,
          verifier: input.verifier,
          notes: input.notes,
        }),
      ),
  );

  mcp.registerTool(
    'hawk_memory',
    {
      title: 'Query or write governed Hawk memory',
      description:
        'Query scoped long-term memory or write an evidence-backed entry. Project and organization writes require verified evidence and all writes pass secret and prompt-injection guards.',
      inputSchema: {
        action: z.enum(['query', 'write']),
        query: z.string().max(1_000).optional(),
        layer: z.enum(['run', 'project', 'organization']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        key: z.string().max(200).optional(),
        value: z.string().max(20_000).optional(),
        source_uri: z.string().max(2_000).optional(),
        evidence_uris: z.array(z.string().max(2_000)).max(100).optional(),
        confidence: z.number().min(0).max(1).optional(),
        verified: z.boolean().optional(),
        reviewer: z.string().max(160).optional(),
        retention_days: z.number().int().min(1).max(3_650).optional(),
      },
      outputSchema: structuredOutput,
      annotations: localWriteAnnotations,
    },
    async (input) => {
      if (input.action === 'query')
        return structured({
          entries: await brain.memory.query(input.query ?? '', input.layer, input.limit),
        });
      if (
        !input.layer ||
        !input.key ||
        !input.value ||
        !input.source_uri ||
        !input.evidence_uris ||
        input.confidence === undefined ||
        input.verified === undefined ||
        !input.reviewer
      )
        return toolError(
          'Memory write requires layer, key, value, source, evidence, confidence, verified, and reviewer',
        );
      const layer = input.layer;
      const key = input.key;
      const value = input.value;
      const sourceUri = input.source_uri;
      const evidenceUris = input.evidence_uris;
      const confidence = input.confidence;
      const verified = input.verified;
      const reviewer = input.reviewer;
      return safeTool(
        async () =>
          await brain.memory.write({
            layer,
            key,
            value,
            sourceUri,
            evidenceUris,
            confidence,
            verified,
            reviewer,
            retentionDays: input.retention_days,
          }),
      );
    },
  );

  mcp.registerTool(
    'hawk_mcp_security_audit',
    {
      title: 'Audit an MCP server manifest with Hawk Sentinel',
      description:
        'Fingerprint MCP tool metadata and detect tool poisoning, prompt injection, secret exposure, trust allowlist violations, and post-trust rug-pull changes without calling the inspected server.',
      inputSchema: {
        manifest: z.unknown(),
        trusted_fingerprints: z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .max(100)
          .optional(),
        previous_fingerprint: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      },
      outputSchema: structuredOutput,
      annotations: passiveAnnotations,
    },
    async (input) =>
      safeTool(
        async () =>
          await brain.sentinel.inspectManifest(input.manifest, {
            trustedFingerprints: input.trusted_fingerprints,
            previousFingerprint: input.previous_fingerprint,
          }),
      ),
  );

  mcp.registerTool(
    'hawk_patch_tournament',
    {
      title: 'Design a parallel secure patch tournament',
      description:
        'Create a deterministic tournament blueprint for multiple isolated patch candidates, independent regression lanes, evidence scoring, and a final human Apply/Reject decision. This tool plans the tournament and never edits files.',
      inputSchema: {
        finding_id: z.string().min(1).max(160),
        candidates: z.number().int().min(2).max(8).default(3),
        test_commands: z
          .array(z.array(z.string().min(1).max(4_096)).min(1).max(64))
          .min(1)
          .max(16),
        scoring: z
          .array(
            z.enum([
              'security-retest',
              'regression',
              'minimal-diff',
              'maintainability',
              'performance',
            ]),
          )
          .min(1)
          .max(5)
          .optional(),
      },
      outputSchema: structuredOutput,
      annotations: passiveAnnotations,
    },
    async (input) =>
      structured(
        patchTournament(input.finding_id, input.candidates, input.test_commands, input.scoring),
      ),
  );

  mcp.registerTool(
    'hawk_eval_lab',
    {
      title: 'Benchmark Hawk against a same-model baseline',
      description:
        'Record or summarize comparable Hawk and plain-agent evaluation runs. Comparisons are accepted only for the same scenario, model, token budget, and cost budget.',
      inputSchema: {
        action: z.enum(['record', 'list', 'summary']),
        record: z
          .object({
            scenario: z.string().min(1).max(500),
            system: z.enum(['hawk', 'baseline']),
            model: z.string().min(1).max(160),
            token_budget: z.number().int().min(0).max(100_000_000),
            cost_budget_usd: z.number().min(0).max(100_000),
            success: z.boolean(),
            signals: z.number().int().min(0).max(1_000_000),
            verified_findings: z.number().int().min(0).max(1_000_000),
            false_positives: z.number().int().min(0).max(1_000_000),
            over_scope_actions: z.number().int().min(0).max(1_000_000),
            regressions: z.number().int().min(0).max(1_000_000),
            elapsed_seconds: z.number().min(0).max(31_536_000),
            actual_cost_usd: z.number().min(0).max(100_000),
          })
          .optional(),
      },
      outputSchema: structuredOutput,
      annotations: localWriteAnnotations,
    },
    async ({ action, record }) => {
      if (action === 'list') return structured({ runs: await brain.evals.list() });
      if (action === 'summary') return structured(await brain.evals.summary());
      if (!record) return toolError('Eval record payload is required');
      return safeTool(
        async () =>
          await brain.evals.record({
            scenario: record.scenario,
            system: record.system,
            model: record.model,
            tokenBudget: record.token_budget,
            costBudgetUsd: record.cost_budget_usd,
            success: record.success,
            signals: record.signals,
            verifiedFindings: record.verified_findings,
            falsePositives: record.false_positives,
            overScopeActions: record.over_scope_actions,
            regressions: record.regressions,
            elapsedSeconds: record.elapsed_seconds,
            actualCostUsd: record.actual_cost_usd,
          }),
      );
    },
  );

  mcp.registerTool(
    'hawk_a2a_bridge',
    {
      title: 'Bridge A2A-compatible tasks and Hawk plans',
      description:
        'Import a text-only A2A task envelope into a passive Hawk plan or export a Hawk run as an A2A-compatible task status. This local bridge performs no network calls.',
      inputSchema: {
        action: z.enum(['import', 'export']),
        task: z.unknown().optional(),
        run_id: z.string().max(160).optional(),
      },
      outputSchema: structuredOutput,
      annotations: localWriteAnnotations,
    },
    async ({ action, task, run_id }) => {
      if (action === 'import') {
        return safeTool(async () => {
          const inspected = brain.sentinel.inspectResult(task);
          if (!inspected.safe)
            throw new Error(
              `A2A envelope was blocked by Hawk Sentinel: ${inspected.findings
                .map((finding) => finding.message)
                .join('; ')}`,
            );
          const imported = parseA2ATask(inspected.redacted);
          const created = await brain.createPlan({
            objective: imported.objective,
            repositories: imported.repositories,
            hosts: imported.hosts,
            approvalMode: 'on-risk',
          });
          await brain.store.writeJson('a2a-mappings', imported.id, {
            a2aTaskId: imported.id,
            contextId: imported.contextId,
            goalId: created.goal.id,
            planId: created.plan.id,
            importedAt: new Date().toISOString(),
          });
          return { imported, ...created };
        });
      }
      if (!run_id) return toolError('run_id is required for A2A export');
      const run = brain.runs.get(run_id);
      if (!run) return toolError(`Unknown smart run: ${run_id}`);
      return structured(toA2ATask(run));
    },
  );

  mcp.registerTool(
    'hawk_mission_control',
    {
      title: 'Open Hawk Smart MCP Mission Control',
      description:
        'Render the interactive Hawk MCP App with durable runs, live event chain, ProofGraph counts, progress, pause, resume, cancel, and fullscreen controls.',
      inputSchema: { run_id: z.string().max(160).optional() },
      outputSchema: structuredOutput,
      annotations: passiveAnnotations,
      _meta: { ui: { resourceUri: HAWK_MCP_APP_URI, visibility: ['model', 'app'] } },
    },
    async ({ run_id }) => structured(await missionControlState(brain, run_id)),
  );

  registerTaskTool(mcp, brain);
  registerResources(mcp, brain);
  registerPrompts(mcp);
  void reconcileDurableMcpTasks(brain, durableTaskStore).catch(() => undefined);
  void orchestrator;
}

function registerTaskTool(mcp: McpServer, brain: SmartMcpBrain): void {
  mcp.experimental.tasks.registerToolTask(
    'hawk_run_execute_task',
    {
      title: 'Execute a Hawk plan as a native MCP task',
      description:
        'Start a durable Hawk run through the MCP Tasks extension. Clients can poll tasks/get and tasks/result while Hawk persists its own run and evidence state across restarts.',
      inputSchema: {
        plan_id: z.string().min(1).max(160),
        execution_inputs: z.record(z.unknown()).optional(),
      },
      outputSchema: structuredOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: 'required' },
    },
    {
      async createTask(input, { taskStore, taskRequestedTtl }) {
        const task = await taskStore.createTask({
          ttl: taskRequestedTtl ?? 86_400_000,
          pollInterval: 1_000,
          context: { hawkPlanId: input.plan_id },
        });
        void (async () => {
          try {
            const run = await brain.startRun(input.plan_id, input.execution_inputs);
            await brain.store.writeJson('mcp-task-runs', task.taskId, {
              taskId: task.taskId,
              runId: run.id,
              planId: input.plan_id,
              createdAt: new Date().toISOString(),
            });
            const currentTask = await taskStore.getTask(task.taskId);
            if (currentTask?.status === 'cancelled') {
              await brain.runs.control(run.id, 'cancel');
              return;
            }
            const completed = await waitForSmartRun(brain, run.id);
            await storeTaskResultIfActive(
              taskStore,
              task.taskId,
              completed.status === 'succeeded' ? 'completed' : 'failed',
              structured({ run: completed }),
            );
          } catch (error) {
            await storeTaskResultIfActive(taskStore, task.taskId, 'failed', {
              isError: true,
              content: [{ type: 'text', text: errorMessage(error) }],
              structuredContent: { data: { error: errorMessage(error) } },
            });
          }
        })();
        return { task };
      },
      async getTask(_input, { taskId, taskStore }) {
        const task = await taskStore.getTask(taskId);
        if (!task) throw new Error(`Unknown MCP task: ${taskId}`);
        return task;
      },
      async getTaskResult(_input, { taskId, taskStore }) {
        const result = await taskStore.getTaskResult(taskId);
        if (!('content' in result) || !Array.isArray(result.content))
          throw new Error(`MCP task ${taskId} did not produce a tool result`);
        return result as CallToolResult;
      },
    },
  );
}

async function storeTaskResultIfActive(
  taskStore: {
    getTask(taskId: string): Promise<{ status: string } | null>;
    storeTaskResult(
      taskId: string,
      status: 'completed' | 'failed',
      result: CallToolResult,
    ): Promise<void>;
  },
  taskId: string,
  status: 'completed' | 'failed',
  result: CallToolResult,
): Promise<void> {
  const task = await taskStore.getTask(taskId);
  if (
    !task ||
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'cancelled'
  )
    return;
  await taskStore.storeTaskResult(taskId, status, result);
}

async function reconcileDurableMcpTasks(
  brain: SmartMcpBrain,
  taskStore: DurableMcpTaskStore,
): Promise<void> {
  const [records, mappings] = await Promise.all([
    taskStore.records(),
    brain.store.listJson<{ taskId: string; runId: string }>('mcp-task-runs'),
  ]);
  const byTask = new Map(mappings.map((mapping) => [mapping.taskId, mapping]));
  for (const record of records) {
    if (
      record.task.status === 'completed' ||
      record.task.status === 'failed' ||
      record.task.status === 'cancelled'
    )
      continue;
    const mapping = byTask.get(record.task.taskId);
    if (!mapping) {
      if (record.context?.hawkPlanId) {
        await taskStore.storeTaskResult(record.task.taskId, 'failed', {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'MCP server stopped before the durable Hawk run was created; start the plan again.',
            },
          ],
          structuredContent: {
            data: { error: 'run-creation-interrupted', planId: record.context.hawkPlanId },
          },
        });
      }
      continue;
    }
    void completeDurableMcpTask(brain, taskStore, record.task.taskId, mapping.runId);
  }
}

async function completeDurableMcpTask(
  brain: SmartMcpBrain,
  taskStore: DurableMcpTaskStore,
  taskId: string,
  runId: string,
): Promise<void> {
  try {
    const completed = await waitForSmartRun(brain, runId);
    const task = await taskStore.getTask(taskId);
    if (
      !task ||
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'cancelled'
    )
      return;
    await taskStore.storeTaskResult(
      taskId,
      completed.status === 'succeeded' ? 'completed' : 'failed',
      structured({ run: completed }),
    );
  } catch (error) {
    const task = await taskStore.getTask(taskId);
    if (
      !task ||
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'cancelled'
    )
      return;
    await taskStore.storeTaskResult(taskId, 'failed', {
      isError: true,
      content: [{ type: 'text', text: errorMessage(error) }],
      structuredContent: { data: { error: errorMessage(error) } },
    });
  }
}

function registerResources(mcp: McpServer, brain: SmartMcpBrain): void {
  mcp.registerResource(
    'hawk-workspace-proofgraph',
    'hawk://workspace/graph',
    {
      title: 'Hawk workspace ProofGraph',
      description:
        'Evidence graph linking code, routes, requests, findings, patches, tests, tools, and runs.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await brain.graph.snapshot()),
  );
  mcp.registerResource(
    'hawk-run-events',
    new ResourceTemplate('hawk://run/{runId}/events', { list: undefined }),
    {
      title: 'Hawk run event chain',
      description: 'Append-only SHA-256-linked event stream for one durable run.',
      mimeType: 'application/x-ndjson',
    },
    async (uri, variables) => {
      const events = await brain.runs.events(String(variables.runId), 2_000);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/x-ndjson',
            text: events.map((event) => JSON.stringify(event)).join('\n'),
          },
        ],
      };
    },
  );
  mcp.registerResource(
    'hawk-run-artifact',
    new ResourceTemplate('hawk://run/{runId}/artifact/{nodeId}', { list: undefined }),
    {
      title: 'Hawk run artifact',
      description: 'Redacted structured output created by one capability node.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const artifact = await brain.store.readJson(
        'artifacts',
        `${String(variables.runId)}--${String(variables.nodeId)}`,
      );
      return jsonResource(uri, artifact ?? { available: false });
    },
  );
  mcp.registerResource(
    'hawk-finding-proof',
    new ResourceTemplate('hawk://finding/{findingId}/proof', { list: undefined }),
    {
      title: 'Hawk finding proof bundle',
      description: 'Finding verification record and its connected ProofGraph neighborhood.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const findingId = String(variables.findingId);
      return jsonResource(uri, {
        verification: await brain.verifier.get(findingId),
        graph: await brain.graph.subgraph(findingId, 3),
      });
    },
  );
  mcp.registerResource(
    'hawk-plan-policy',
    new ResourceTemplate('hawk://policy/{planId}', { list: undefined }),
    {
      title: 'Hawk plan policy decision',
      description: 'Immutable plan, policy decision, and exact-hash approval for one plan.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const planId = String(variables.planId);
      return jsonResource(uri, {
        plan: await brain.getPlan(planId),
        policy: await brain.store.readJson('policies', planId),
        approval: await brain.store.readJson('plan-approvals', planId),
      });
    },
  );
  mcp.registerResource(
    'hawk-mission-control-app',
    HAWK_MCP_APP_URI,
    {
      title: 'Hawk Smart MCP Mission Control',
      description: 'Sandboxed, zero-egress MCP App for observing and controlling Hawk runs.',
      mimeType: HAWK_MCP_APP_MIME,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: HAWK_MCP_APP_MIME,
          text: HAWK_MCP_APP_HTML,
          _meta: {
            ui: {
              csp: {
                connectDomains: [],
                resourceDomains: [],
                frameDomains: [],
                baseUriDomains: [],
              },
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );
  mcp.registerResource(
    'hawk-a2a-profile',
    'hawk://interop/a2a-profile',
    {
      title: 'Hawk A2A interoperability profile',
      description:
        'Local A2A-compatible task-envelope contract. This is not a remotely advertised Agent Card.',
      mimeType: 'application/json',
    },
    async (uri) =>
      jsonResource(uri, {
        name: 'Hawk Security IDE',
        version: '1.0.0',
        transport: 'MCP-local-bridge',
        importTool: 'hawk_a2a_bridge',
        acceptedParts: ['text'],
        exports: ['task-status', 'artifact-uri', 'proof-uri'],
        security: [
          'scope compilation',
          'exact-plan approvals',
          'text-only import',
          'no implicit network calls',
        ],
      }),
  );
}

function registerPrompts(mcp: McpServer): void {
  mcp.registerPrompt(
    'hawk_secure_pr_review',
    {
      title: 'Evidence-driven secure PR review',
      description: 'Plan a scoped code review that separates signals from verified findings.',
      argsSchema: {
        objective: z.string().max(1_000),
        changed_files: z.string().max(20_000).optional(),
      },
    },
    ({ objective, changed_files }) =>
      prompt(`Review this change as Hawk.
Objective: ${objective}
Changed files: ${changed_files ?? 'Use the current git diff.'}
First call hawk_context_snapshot, then hawk_plan_create. Keep all work passive unless the operator explicitly expands scope. Never label a static signal as a vulnerability without hawk_evidence_verify.`),
  );
  mcp.registerPrompt(
    'hawk_idor_matrix',
    {
      title: 'Scoped IDOR/BOLA identity matrix',
      description:
        'Design a multi-identity authorization test matrix with exact scope and proof gates.',
      argsSchema: {
        hosts: z.string().max(2_000),
        identities: z.string().max(2_000),
        routes: z.string().max(10_000),
      },
    },
    ({ hosts, identities, routes }) =>
      prompt(`Build an authorized IDOR/BOLA matrix.
Hosts: ${hosts}
Identities: ${identities}
Routes: ${routes}
Use baseline/control pairs, strict rate limits, non-destructive methods, tenant-aware evidence, and an independent verifier. Stop for exact-plan approval before any live request.`),
  );
  mcp.registerPrompt(
    'hawk_verify_finding',
    {
      title: 'Verify one Hawk finding',
      description: 'Gather the minimum reproducible evidence required for verified status.',
      argsSchema: { finding_id: z.string().max(160) },
    },
    ({ finding_id }) =>
      prompt(
        `Verify finding ${finding_id}. Read hawk://finding/${finding_id}/proof, identify missing gates, collect only in-scope redacted evidence, use an independent reproduction path, then call hawk_evidence_verify. If any gate fails, keep the lifecycle below verified.`,
      ),
  );
  mcp.registerPrompt(
    'hawk_fix_and_retest',
    {
      title: 'Patch tournament and security retest',
      description:
        'Compare isolated patch candidates and require regression plus security retest evidence.',
      argsSchema: {
        finding_id: z.string().max(160),
        constraints: z.string().max(5_000).optional(),
      },
    },
    ({ finding_id, constraints }) =>
      prompt(`For verified finding ${finding_id}, design multiple minimal patch candidates.
Constraints: ${constraints ?? 'Preserve public behavior and keep the diff minimal.'}
Use hawk_patch_tournament, run candidates in isolated worktrees or containers, score security retest, regression, diff size, maintainability and performance, then show diffs for human Apply/Reject. Never auto-apply a candidate.`),
  );
}

async function contextSnapshot(workspaceRoot: string, brain: SmartMcpBrain) {
  const [routes, audit, traffic, health, plans] = await Promise.all([
    scanWorkspaceRoutes(workspaceRoot),
    scanWorkspaceSecurity(workspaceRoot),
    readOptionalJson(join(workspaceRoot, '.hawk', 'traffic.json')),
    readOptionalJson(join(workspaceRoot, '.hawk', 'health.json')),
    brain.listPlans(),
  ]);
  return {
    workspaceRoot,
    sourceFiles: Math.max(routes.sourceFiles, audit.sourceFiles),
    routes: routes.routes,
    signals: audit.findings,
    traffic:
      traffic && typeof traffic === 'object'
        ? {
            hosts: (traffic as Record<string, unknown>).hosts ?? [],
            requests: Array.isArray((traffic as Record<string, unknown>).requests)
              ? ((traffic as Record<string, unknown>).requests as unknown[]).length
              : 0,
          }
        : { available: false },
    supplyChain: health ? { available: true } : { available: false },
    smartRuns: brain.runs.list(),
    recentPlans: plans.slice(0, 10),
    graph: await brain.graph.snapshot(),
    generatedAt: new Date().toISOString(),
  };
}

async function missionControlState(brain: SmartMcpBrain, runId?: string) {
  const graph = await brain.graph.snapshot();
  const runs = brain.runs.list();
  return {
    generatedAt: new Date().toISOString(),
    capabilities: brain.capabilities.list().filter((capability) => capability.enabled).length,
    plans: (await brain.listPlans()).slice(0, 20),
    runs,
    graph: { nodes: graph.nodes.length, edges: graph.edges.length, updatedAt: graph.updatedAt },
    events: runId ? await brain.runs.events(runId, 100).catch(() => []) : [],
  };
}

function patchTournament(
  findingId: string,
  candidates: number,
  testCommands: string[][],
  scoring = ['security-retest', 'regression', 'minimal-diff', 'maintainability'],
) {
  const lanes = Array.from({ length: candidates }, (_, index) => ({
    id: `candidate-${index + 1}`,
    isolatedWorktree: true,
    requiredInputs: [`hawk://finding/${findingId}/proof`],
    stages: [
      'generate-minimal-patch',
      'capture-diff',
      ...testCommands.map((_, test) => `test-${test + 1}`),
    ],
    evidence: ['diff', 'test-output', 'security-retest', 'changed-files'],
  }));
  return {
    protocolVersion: 1,
    findingId,
    lanes,
    testCommands,
    scoring,
    judge: {
      independentFromGenerators: true,
      disqualifyOn: ['security-retest-failed', 'regression-failed', 'out-of-scope-diff'],
      finalDecision: 'human-apply-reject',
    },
    executesChanges: false,
  };
}

function parseA2ATask(value: unknown): {
  id: string;
  contextId: string;
  objective: string;
  repositories: string[];
  hosts: string[];
} {
  if (!value || typeof value !== 'object') throw new Error('A2A task must be an object');
  const task = value as Record<string, unknown>;
  const id = typeof task.id === 'string' ? task.id.slice(0, 160) : '';
  const contextId =
    typeof task.contextId === 'string' ? task.contextId.slice(0, 160) : `context-${id}`;
  const message = task.message;
  if (!id || !message || typeof message !== 'object')
    throw new Error('A2A task requires id and message');
  const parts = (message as Record<string, unknown>).parts;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 32)
    throw new Error('A2A task requires 1-32 text parts');
  const texts = parts.map((part) => {
    if (
      !part ||
      typeof part !== 'object' ||
      (part as Record<string, unknown>).kind !== 'text' ||
      typeof (part as Record<string, unknown>).text !== 'string'
    )
      throw new Error('Hawk accepts only A2A text parts; data, file, and URL parts are rejected');
    return String((part as Record<string, unknown>).text).slice(0, 10_000);
  });
  const metadata =
    task.metadata && typeof task.metadata === 'object'
      ? (task.metadata as Record<string, unknown>)
      : {};
  const repositories = stringArray(metadata.repositories, 64);
  const hosts = stringArray(metadata.hosts, 128);
  return {
    id,
    contextId,
    objective: texts.join('\n').slice(0, 1_000),
    repositories: repositories.length > 0 ? repositories : ['workspace://current'],
    hosts,
  };
}

function toA2ATask(run: SmartRun) {
  const state: Record<SmartRun['status'], string> = {
    queued: 'submitted',
    running: 'working',
    paused: 'input-required',
    'awaiting-approval': 'input-required',
    succeeded: 'completed',
    failed: 'failed',
    cancelled: 'canceled',
  };
  return {
    kind: 'task',
    id: run.id,
    contextId: run.goalId,
    status: {
      state: state[run.status],
      timestamp: run.updatedAt,
      message: {
        role: 'agent',
        parts: [
          {
            kind: 'text',
            text: `Hawk run ${run.status}: ${run.summary.succeeded}/${run.summary.total} nodes succeeded.`,
          },
        ],
      },
    },
    artifacts: run.nodes
      .filter((node) => node.artifactUri)
      .map((node) => ({
        artifactId: node.id,
        name: node.title,
        parts: [{ kind: 'text', text: node.artifactUri }],
      })),
    metadata: { planId: run.planId, planHash: run.planHash },
  };
}

function stringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, limit)
    : [];
}

async function waitForSmartRun(brain: SmartMcpBrain, runId: string): Promise<SmartRun> {
  while (true) {
    const run = brain.runs.get(runId);
    if (!run) throw new Error(`Smart run disappeared: ${runId}`);
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      await brain.runs.settled(runId);
      return run;
    }
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, 500);
      timer.unref();
    });
  }
}

function structured(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { data },
  };
}

async function safeTool(operation: () => Promise<unknown>) {
  try {
    return structured(await operation());
  } catch (error) {
    return toolError(errorMessage(error));
  }
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function prompt(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

async function readOptionalJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
