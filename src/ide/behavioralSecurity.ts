import { createHash } from 'node:crypto';
import type { CapturedInteraction } from '../browser/store.js';
import type { InteractionChaosReport } from './interactionChaos.js';
import {
  IDE_PROTOCOL_VERSION,
  type SecurityFinding,
  type TrafficInventory,
  type TrafficRequest,
  type WorkspaceInventory,
} from './protocol.js';

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_ITEMS = 2_000;

export type BehavioralFeatureId =
  | 'state-machine'
  | 'invariant-engine'
  | 'controlled-race-lab'
  | 'deterministic-replay'
  | 'agent-hooks'
  | 'specialist-swarm'
  | 'evidence-pr-review'
  | 'accessibility-chaos'
  | 'client-state-chaos'
  | 'fix-mutation-testing'
  | 'failure-timeline'
  | 'project-digital-twin';

export type BehavioralSignalSeverity = 'high' | 'medium' | 'low';

export interface BehavioralCapability {
  id: BehavioralFeatureId;
  title: string;
  status: 'ready';
  mode: 'captured-only' | 'offline' | 'approval-gated';
  description: string;
}

export interface BehavioralState {
  id: string;
  label: string;
  pageUrl: string;
  kind: 'page' | 'route';
  observations: number;
}

export interface BehavioralTransition {
  id: string;
  from: string;
  to: string;
  action: string;
  occurrences: number;
  interactionIds: string[];
}

export interface BehavioralWorkflow {
  id: string;
  title: string;
  stateIds: string[];
  transitionIds: string[];
  risk: 'high' | 'medium' | 'low';
}

export interface BehavioralInvariant {
  id: string;
  title: string;
  expression: string;
  category: 'side-effect' | 'authorization' | 'integrity' | 'workflow' | 'availability';
  status: 'holding' | 'signal' | 'untested';
  evidence: string[];
}

export type BehavioralExperimentKind =
  | 'repeat'
  | 'skip'
  | 'reorder'
  | 'multi-tab'
  | 'logout-reuse'
  | 'concurrency'
  | 'offline-transition'
  | 'stale-cache'
  | 'expired-session'
  | 'storage-corruption'
  | 'service-worker-drift'
  | 'keyboard-activation';

export interface BehavioralExperiment {
  id: string;
  kind: BehavioralExperimentKind;
  title: string;
  target: string;
  mode: 'captured-only' | 'approval-required';
  steps: string[];
  invariantIds: string[];
  maxConcurrency?: number;
  requestIds: string[];
}

export interface BehavioralReplay {
  id: string;
  tabId?: number;
  startedAt: string;
  completedAt: string;
  pageUrls: string[];
  interactionIds: string[];
  requestIds: string[];
  deterministicInputs: string[];
}

export interface BehavioralMutationPlan {
  id: string;
  operator:
    | 'remove-auth-guard'
    | 'invert-condition'
    | 'duplicate-side-effect'
    | 'remove-idempotency'
    | 'accept-invalid-transition';
  target: string;
  findingIds: string[];
  expectedTest: string;
  mode: 'isolated-offline';
}

export interface BehavioralTimelineEvent {
  id: string;
  occurredAt: string;
  kind: 'interaction' | 'request' | 'signal' | 'failure';
  label: string;
  referenceIds: string[];
}

export interface BehavioralSignal {
  id: string;
  ruleId:
    | 'hawk.behavior.duplicate-side-effect'
    | 'hawk.behavior.inconsistent-outcome'
    | 'hawk.behavior.disabled-control-activated'
    | 'hawk.behavior.non-native-button'
    | 'hawk.behavior.keyboard-double-activation'
    | 'hawk.behavior.workflow-gap';
  severity: BehavioralSignalSeverity;
  confidence: 'signal';
  title: string;
  description: string;
  evidence: string[];
  interactionIds: string[];
  requestIds: string[];
  invariantIds: string[];
}

export interface BehavioralDigitalTwin {
  actors: Array<{ id: string; label: string; evidence: string[] }>;
  assets: Array<{ id: string; label: string; kind: string; evidence: string[] }>;
  trustBoundaries: Array<{ id: string; label: string; evidence: string[] }>;
  workflowIds: string[];
  invariantIds: string[];
  learningFingerprint: string;
}

export interface BehavioralSecurityReport {
  protocolVersion: number;
  generatedAt: string;
  mode: 'captured-and-static';
  summary: {
    capabilities: number;
    states: number;
    transitions: number;
    workflows: number;
    invariants: number;
    invariantSignals: number;
    experiments: number;
    raceExperiments: number;
    replays: number;
    accessibilitySignals: number;
    clientStateExperiments: number;
    mutationPlans: number;
    timelineEvents: number;
    signals: number;
  };
  capabilities: BehavioralCapability[];
  states: BehavioralState[];
  transitions: BehavioralTransition[];
  workflows: BehavioralWorkflow[];
  invariants: BehavioralInvariant[];
  experiments: BehavioralExperiment[];
  replays: BehavioralReplay[];
  mutationPlans: BehavioralMutationPlan[];
  timeline: BehavioralTimelineEvent[];
  signals: BehavioralSignal[];
  digitalTwin: BehavioralDigitalTwin;
  statement: string;
}

export interface BehavioralSecurityInput {
  inventory: WorkspaceInventory;
  traffic?: TrafficInventory | null;
  interactions?: CapturedInteraction[];
  findings?: SecurityFinding[];
  interactionChaos?: InteractionChaosReport | null;
  now?: Date;
}

export interface BehavioralExperimentPlan {
  protocolVersion: number;
  id: string;
  createdAt: string;
  expiresAt: string;
  objective: string;
  mode: 'passive' | 'authorized-active';
  allowedHosts: string[];
  maxConcurrency: number;
  maxRequests: number;
  networkPolicy: 'captured-only' | 'restricted';
  experimentIds: string[];
  invariantIds: string[];
  requiresApproval: true;
  approvalHash: string;
  statement: string;
}

export function analyzeBehavioralSecurity(
  input: BehavioralSecurityInput,
): BehavioralSecurityReport {
  const now = input.now ?? new Date();
  const interactions = (input.interactions ?? [])
    .filter((item) => item.trusted)
    .slice(-MAX_ITEMS)
    .sort((left, right) => left.occurredAt - right.occurredAt);
  const traffic = input.traffic?.requests.slice(0, MAX_ITEMS) ?? [];
  const mutations = traffic.filter((request) => MUTATIONS.has(request.method.toUpperCase()));
  const states = buildStates(input.inventory, interactions);
  const transitions = buildTransitions(interactions, states);
  const workflows = buildWorkflows(states, transitions, mutations);
  const invariants = buildInvariants(input.inventory, input.findings ?? [], input.interactionChaos);
  const signals = buildSignals(interactions, input.interactionChaos, invariants);
  const experiments = buildExperiments(workflows, invariants, mutations, interactions);
  const replays = buildReplays(interactions, traffic);
  const mutationPlans = buildMutationPlans(input.findings ?? [], invariants);
  const timeline = buildTimeline(interactions, traffic, signals, input.interactionChaos, now);
  const digitalTwin = buildDigitalTwin(
    input.inventory,
    workflows,
    invariants,
    traffic,
    input.findings ?? [],
  );
  const accessibilitySignals = signals.filter((signal) =>
    [
      'hawk.behavior.disabled-control-activated',
      'hawk.behavior.non-native-button',
      'hawk.behavior.keyboard-double-activation',
    ].includes(signal.ruleId),
  ).length;
  const clientStateExperiments = experiments.filter((experiment) =>
    [
      'offline-transition',
      'stale-cache',
      'expired-session',
      'storage-corruption',
      'service-worker-drift',
    ].includes(experiment.kind),
  ).length;
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    generatedAt: now.toISOString(),
    mode: 'captured-and-static',
    summary: {
      capabilities: CAPABILITIES.length,
      states: states.length,
      transitions: transitions.length,
      workflows: workflows.length,
      invariants: invariants.length,
      invariantSignals: invariants.filter((invariant) => invariant.status === 'signal').length,
      experiments: experiments.length,
      raceExperiments: experiments.filter((experiment) => experiment.kind === 'concurrency').length,
      replays: replays.length,
      accessibilitySignals,
      clientStateExperiments,
      mutationPlans: mutationPlans.length,
      timelineEvents: timeline.length,
      signals: signals.length,
    },
    capabilities: CAPABILITIES,
    states,
    transitions,
    workflows,
    invariants,
    experiments,
    replays,
    mutationPlans,
    timeline,
    signals,
    digitalTwin,
    statement:
      'Behavioral Intelligence combines captured and static evidence. Passive analysis generates no target traffic; active experiments remain restricted, exact-hash, approval-gated plans.',
  };
}

export function createBehavioralExperimentPlan(
  report: BehavioralSecurityReport,
  input: {
    objective: string;
    mode?: 'passive' | 'authorized-active';
    allowedHosts?: string[];
    maxConcurrency?: number;
    maxRequests?: number;
    now?: Date;
  },
): BehavioralExperimentPlan {
  const objective = input.objective.trim().slice(0, 1_000);
  if (!objective) throw new Error('behavioral experiment objective is required');
  const mode = input.mode ?? 'passive';
  const allowedHosts = [
    ...new Set((input.allowedHosts ?? []).map(normalizeHost).filter(Boolean)),
  ].sort();
  if (mode === 'authorized-active' && allowedHosts.length === 0) {
    throw new Error('authorized active experiments require at least one exact allowed host');
  }
  const maxConcurrency = bounded(input.maxConcurrency, 1, 10, mode === 'passive' ? 1 : 2);
  const maxRequests = bounded(input.maxRequests, 0, 100, mode === 'passive' ? 0 : 20);
  if (mode === 'passive' && maxRequests !== 0) {
    throw new Error('passive behavioral plans cannot generate requests');
  }
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const experimentIds = report.experiments
    .filter((experiment) => mode === 'authorized-active' || experiment.mode === 'captured-only')
    .map((experiment) => experiment.id)
    .slice(0, 100);
  const invariantIds = report.invariants.map((invariant) => invariant.id).slice(0, 100);
  const canonical = {
    objective,
    mode,
    allowedHosts,
    maxConcurrency,
    maxRequests,
    experimentIds,
    invariantIds,
    createdAt,
    expiresAt,
  };
  const approvalHash = hash(JSON.stringify(canonical), 64);
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    id: `behavior-plan-${approvalHash.slice(0, 20)}`,
    createdAt,
    expiresAt,
    objective,
    mode,
    allowedHosts,
    maxConcurrency,
    maxRequests,
    networkPolicy: mode === 'passive' ? 'captured-only' : 'restricted',
    experimentIds,
    invariantIds,
    requiresApproval: true,
    approvalHash,
    statement:
      mode === 'passive'
        ? 'This exact plan analyzes captured evidence only and sends zero requests.'
        : 'This plan describes restricted active experiments. Execution requires a separate exact-hash approval and a bounded isolated browser worker.',
  };
}

const CAPABILITIES: BehavioralCapability[] = [
  capability(
    'state-machine',
    'Behavioral State Machine Explorer',
    'captured-only',
    'Learns pages, transitions, repeated actions, and workflow gaps from structural interaction evidence.',
  ),
  capability(
    'invariant-engine',
    'Invariant Engine',
    'offline',
    'Builds explicit side-effect, authorization, integrity, workflow, and availability rules.',
  ),
  capability(
    'controlled-race-lab',
    'Controlled Race Lab',
    'approval-gated',
    'Builds exact concurrency experiments with bounded request and host budgets.',
  ),
  capability(
    'deterministic-replay',
    'Deterministic Browser Replay',
    'captured-only',
    'Produces sanitized replay bundles with stable interaction and request references.',
  ),
  capability(
    'agent-hooks',
    'Governed Agent Hooks',
    'offline',
    'Evaluates pre-tool, post-tool, stop, and failure policy hooks deterministically.',
  ),
  capability(
    'specialist-swarm',
    'Specialist Agent Swarm',
    'approval-gated',
    'Plans scoped behavioral, race, auth, frontend, API, debug, fix, and verification agents.',
  ),
  capability(
    'evidence-pr-review',
    'Evidence-gated PR Review',
    'offline',
    'Keeps PR security findings below pass until reproduction, tests, and review gates are present.',
  ),
  capability(
    'accessibility-chaos',
    'Accessibility Chaos',
    'captured-only',
    'Finds disabled control activation, non-native controls, and keyboard double activation signals.',
  ),
  capability(
    'client-state-chaos',
    'Client State Corruption Lab',
    'approval-gated',
    'Plans offline, stale cache, expired session, storage corruption, and service-worker drift scenarios.',
  ),
  capability(
    'fix-mutation-testing',
    'Fix Mutation Testing',
    'offline',
    'Plans isolated security mutations that prove regression tests can catch the original failure.',
  ),
  capability(
    'failure-timeline',
    'Failure Timeline',
    'captured-only',
    'Orders interactions, requests, failures, and signals into one provenance timeline.',
  ),
  capability(
    'project-digital-twin',
    'Project Digital Twin',
    'offline',
    'Models actors, assets, workflows, trust boundaries, invariants, and a stable learning fingerprint.',
  ),
];

function capability(
  id: BehavioralFeatureId,
  title: string,
  mode: BehavioralCapability['mode'],
  description: string,
): BehavioralCapability {
  return { id, title, status: 'ready', mode, description };
}

function buildStates(
  inventory: WorkspaceInventory,
  interactions: CapturedInteraction[],
): BehavioralState[] {
  const states = new Map<string, BehavioralState>();
  for (const interaction of interactions) {
    const page = safePage(interaction.url);
    const id = `state-page-${hash(page)}`;
    const existing = states.get(id);
    states.set(id, {
      id,
      label: pageLabel(page),
      pageUrl: page,
      kind: 'page',
      observations: (existing?.observations ?? 0) + 1,
    });
  }
  for (const route of inventory.routes.slice(0, MAX_ITEMS)) {
    const key = `${route.method.toUpperCase()} ${route.path}`;
    const id = `state-route-${hash(key)}`;
    states.set(id, {
      id,
      label: key,
      pageUrl: route.path,
      kind: 'route',
      observations: 0,
    });
  }
  return [...states.values()].sort(
    (left, right) =>
      right.observations - left.observations || left.label.localeCompare(right.label),
  );
}

function buildTransitions(
  interactions: CapturedInteraction[],
  states: BehavioralState[],
): BehavioralTransition[] {
  const pageState = new Map(
    states.filter((state) => state.kind === 'page').map((state) => [state.pageUrl, state.id]),
  );
  const groups = groupBy(interactions, (interaction) => String(interaction.tabId ?? 'unknown'));
  const transitions = new Map<string, BehavioralTransition>();
  for (const values of groups.values()) {
    for (let index = 0; index < values.length; index += 1) {
      const current = values[index];
      if (!current) continue;
      const next = values[index + 1] ?? current;
      const from = pageState.get(safePage(current.url));
      const to = pageState.get(safePage(next.url));
      if (!from || !to) continue;
      const action = `${current.kind}:${current.target.fingerprint}`;
      const key = `${from}\u0000${to}\u0000${action}`;
      const existing = transitions.get(key);
      transitions.set(key, {
        id: existing?.id ?? `transition-${hash(key)}`,
        from,
        to,
        action,
        occurrences: (existing?.occurrences ?? 0) + 1,
        interactionIds: [...(existing?.interactionIds ?? []), current.id].slice(-100),
      });
    }
  }
  return [...transitions.values()].sort(
    (left, right) => right.occurrences - left.occurrences || left.id.localeCompare(right.id),
  );
}

function buildWorkflows(
  states: BehavioralState[],
  transitions: BehavioralTransition[],
  mutations: TrafficRequest[],
): BehavioralWorkflow[] {
  const pageStates = states.filter((state) => state.kind === 'page');
  const workflows: BehavioralWorkflow[] = [];
  if (pageStates.length > 0) {
    workflows.push({
      id: `workflow-observed-${hash(pageStates.map((state) => state.id).join('\u0000'))}`,
      title: 'Observed browser workflow',
      stateIds: pageStates.map((state) => state.id).slice(0, 100),
      transitionIds: transitions.map((transition) => transition.id).slice(0, 100),
      risk: mutations.length > 0 ? 'high' : transitions.length > 2 ? 'medium' : 'low',
    });
  }
  const routeStates = states.filter((state) => state.kind === 'route');
  if (routeStates.length > 0) {
    workflows.push({
      id: `workflow-api-${hash(routeStates.map((state) => state.id).join('\u0000'))}`,
      title: 'Static API workflow surface',
      stateIds: routeStates.map((state) => state.id).slice(0, 200),
      transitionIds: [],
      risk: routeStates.some((state) => sensitiveWords(state.label)) ? 'high' : 'medium',
    });
  }
  return workflows;
}

function buildInvariants(
  inventory: WorkspaceInventory,
  findings: SecurityFinding[],
  chaos?: InteractionChaosReport | null,
): BehavioralInvariant[] {
  const chaosSignals = chaos?.signals ?? [];
  const duplicate = chaosSignals.filter((signal) => signal.requestIds.length > 1);
  const failing = chaosSignals.filter(
    (signal) => signal.statuses.some((status) => status >= 500) || signal.statuses.length > 1,
  );
  const invariants: BehavioralInvariant[] = [
    invariant(
      'one-intent-one-mutation',
      'One user intent creates at most one durable mutation',
      'durable_mutations(user_intent) <= 1',
      'side-effect',
      duplicate.length > 0 ? 'signal' : chaos ? 'holding' : 'untested',
      duplicate.map((signal) => `${signal.id}: ${signal.requestIds.length} mutation requests`),
    ),
    invariant(
      'stable-outcome',
      'Repeated equivalent operations return one stable outcome class',
      'unique(status_class(equivalent_requests)) <= 1',
      'availability',
      failing.length > 0 ? 'signal' : chaos ? 'holding' : 'untested',
      failing.map((signal) => `${signal.id}: ${signal.statuses.join(', ')}`),
    ),
    invariant(
      'server-authority',
      'Security-relevant identity and totals are derived server-side',
      'trusted_values.source == server',
      'integrity',
      findings.some((finding) => /auth|cors|sql|secret/i.test(finding.ruleId))
        ? 'signal'
        : 'untested',
      findings.slice(0, 10).map((finding) => `${finding.ruleId}: ${finding.title}`),
    ),
    invariant(
      'workflow-transition',
      'Every sensitive workflow transition is explicitly authorized',
      'transition.allowed(actor, previous_state, next_state) == true',
      'workflow',
      inventory.routes.some((route) => sensitiveWords(`${route.method} ${route.path}`))
        ? 'untested'
        : 'holding',
      inventory.routes
        .filter((route) => sensitiveWords(`${route.method} ${route.path}`))
        .slice(0, 20)
        .map((route) => `${route.method} ${route.path}`),
    ),
    invariant(
      'ownership',
      'An actor cannot operate on another actor resource without explicit authority',
      'resource.owner == actor || policy.allows(actor, action, resource)',
      'authorization',
      findings.some((finding) => /idor|bola|authorization|ownership/i.test(finding.title))
        ? 'signal'
        : 'untested',
      findings
        .filter((finding) => /idor|bola|authorization|ownership/i.test(finding.title))
        .map((finding) => finding.title),
    ),
  ];
  for (const keyword of ['payment', 'coupon', 'balance', 'order', 'admin']) {
    const routes = inventory.routes.filter((route) =>
      `${route.method} ${route.path}`.toLowerCase().includes(keyword),
    );
    if (routes.length === 0) continue;
    invariants.push(
      invariant(
        `domain-${keyword}`,
        `${keyword} operations preserve their business limit`,
        `${keyword}.side_effects <= authorized_limit`,
        keyword === 'admin' ? 'authorization' : 'integrity',
        'untested',
        routes.slice(0, 20).map((route) => `${route.method} ${route.path}`),
      ),
    );
  }
  return invariants;
}

function invariant(
  id: string,
  title: string,
  expression: string,
  category: BehavioralInvariant['category'],
  status: BehavioralInvariant['status'],
  evidence: string[],
): BehavioralInvariant {
  return {
    id: `invariant-${id}`,
    title,
    expression,
    category,
    status,
    evidence: evidence.slice(0, 50),
  };
}

function buildSignals(
  interactions: CapturedInteraction[],
  chaos: InteractionChaosReport | null | undefined,
  invariants: BehavioralInvariant[],
): BehavioralSignal[] {
  const output: BehavioralSignal[] = [];
  for (const signal of chaos?.signals ?? []) {
    output.push({
      id: `behavior-${hash(signal.id)}`,
      ruleId:
        signal.statuses.some((status) => status >= 500) || signal.statuses.length > 1
          ? 'hawk.behavior.inconsistent-outcome'
          : 'hawk.behavior.duplicate-side-effect',
      severity: signal.severity,
      confidence: 'signal',
      title:
        signal.requestIds.length > 1
          ? 'Equivalent user intent produced duplicate mutations'
          : 'Rapid workflow action needs invariant validation',
      description:
        'Captured structural interactions and mutation metadata indicate a possible business-logic race or missing in-flight guard.',
      evidence: signal.evidence,
      interactionIds: signal.interactionIds,
      requestIds: signal.requestIds,
      invariantIds: invariants
        .filter((invariant) => invariant.status === 'signal')
        .map((invariant) => invariant.id),
    });
  }
  for (const interaction of interactions) {
    if (interaction.target.disabled) {
      output.push(
        accessibilitySignal(
          interaction,
          'hawk.behavior.disabled-control-activated',
          'Disabled control emitted a trusted interaction',
          'A structurally disabled control still produced a trusted captured event.',
          'high',
        ),
      );
    }
    if (
      interaction.target.role === 'button' &&
      !['button', 'input'].includes(interaction.target.tag)
    ) {
      output.push(
        accessibilitySignal(
          interaction,
          'hawk.behavior.non-native-button',
          'Non-native button needs keyboard and disabled-state validation',
          'A role=button element may implement keyboard, focus, and disabled behavior inconsistently.',
          'low',
        ),
      );
    }
  }
  const keyboardGroups = groupBy(
    interactions.filter((interaction) => interaction.detail === 0),
    (interaction) =>
      `${interaction.tabId ?? 'tab'}\u0000${interaction.url}\u0000${interaction.target.fingerprint}`,
  );
  for (const group of keyboardGroups.values()) {
    const sorted = [...group].sort((left, right) => left.occurredAt - right.occurredAt);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (!previous || !current || current.occurredAt - previous.occurredAt > 500) continue;
      output.push({
        id: `behavior-${hash(`${previous.id}\u0000${current.id}`)}`,
        ruleId: 'hawk.behavior.keyboard-double-activation',
        severity: 'medium',
        confidence: 'signal',
        title: 'Keyboard activation may have fired twice',
        description:
          'Two trusted zero-detail activations hit the same control inside 500 ms. Validate Enter/Space handler deduplication.',
        evidence: [`${current.occurredAt - previous.occurredAt} ms between activations`],
        interactionIds: [previous.id, current.id],
        requestIds: [],
        invariantIds: ['invariant-one-intent-one-mutation'],
      });
      break;
    }
  }
  return deduplicate(output, (signal) => signal.id).slice(0, 500);
}

function accessibilitySignal(
  interaction: CapturedInteraction,
  ruleId: Extract<
    BehavioralSignal['ruleId'],
    'hawk.behavior.disabled-control-activated' | 'hawk.behavior.non-native-button'
  >,
  title: string,
  description: string,
  severity: BehavioralSignalSeverity,
): BehavioralSignal {
  return {
    id: `behavior-${hash(`${ruleId}\u0000${interaction.id}`)}`,
    ruleId,
    severity,
    confidence: 'signal',
    title,
    description,
    evidence: [
      `${interaction.kind} on ${interaction.target.fingerprint}`,
      `tag=${interaction.target.tag}; role=${interaction.target.role ?? 'none'}; disabled=${interaction.target.disabled}`,
    ],
    interactionIds: [interaction.id],
    requestIds: [],
    invariantIds: ['invariant-one-intent-one-mutation'],
  };
}

function buildExperiments(
  workflows: BehavioralWorkflow[],
  invariants: BehavioralInvariant[],
  mutations: TrafficRequest[],
  interactions: CapturedInteraction[],
): BehavioralExperiment[] {
  const invariantIds = invariants.map((invariant) => invariant.id).slice(0, 50);
  const experiments: BehavioralExperiment[] = [];
  for (const workflow of workflows) {
    for (const kind of ['repeat', 'skip', 'reorder', 'multi-tab', 'logout-reuse'] as const) {
      experiments.push({
        id: `experiment-${hash(`${workflow.id}\u0000${kind}`)}`,
        kind,
        title: experimentTitle(kind),
        target: workflow.title,
        mode: 'captured-only',
        steps: experimentSteps(kind),
        invariantIds,
        requestIds: [],
      });
    }
  }
  const mutationGroups = groupBy(
    mutations,
    (request) => `${request.method} ${safeEndpoint(request.url)}`,
  );
  for (const requests of mutationGroups.values()) {
    const first = requests[0];
    if (!first) continue;
    experiments.push({
      id: `experiment-${hash(`race\u0000${first.method}\u0000${safeEndpoint(first.url)}`)}`,
      kind: 'concurrency',
      title: `Race ${first.method.toUpperCase()} ${safeEndpoint(first.url)}`,
      target: safeEndpoint(first.url),
      mode: 'approval-required',
      steps: [
        'Capture a stable baseline state fingerprint.',
        'Dispatch the exact approved request concurrently inside a bounded worker.',
        'Capture response fingerprints and the durable post-state.',
        'Assert one authorized side effect and stable outcome semantics.',
      ],
      invariantIds: invariantIds.filter((id) =>
        ['invariant-one-intent-one-mutation', 'invariant-stable-outcome'].includes(id),
      ),
      maxConcurrency: 2,
      requestIds: requests.map((request) => request.id).slice(0, 20),
    });
  }
  const observedTarget = interactions[0]?.target.fingerprint ?? 'captured application state';
  for (const kind of [
    'offline-transition',
    'stale-cache',
    'expired-session',
    'storage-corruption',
    'service-worker-drift',
    'keyboard-activation',
  ] as const) {
    experiments.push({
      id: `experiment-${hash(`${kind}\u0000${observedTarget}`)}`,
      kind,
      title: experimentTitle(kind),
      target: observedTarget,
      mode: kind === 'keyboard-activation' ? 'captured-only' : 'approval-required',
      steps: experimentSteps(kind),
      invariantIds,
      requestIds: [],
    });
  }
  return deduplicate(experiments, (experiment) => experiment.id).slice(0, 500);
}

function buildReplays(
  interactions: CapturedInteraction[],
  traffic: TrafficRequest[],
): BehavioralReplay[] {
  const groups = groupBy(interactions, (interaction) => String(interaction.tabId ?? 'unknown'));
  return [...groups.entries()]
    .map(([tab, values]) => {
      const first = values[0];
      const last = values.at(-1);
      if (!first || !last) return undefined;
      const pages = [...new Set(values.map((interaction) => safePage(interaction.url)))];
      const requestIds = traffic
        .filter((request) => {
          const at = Date.parse(request.startedAt);
          return at >= first.occurredAt - 1_000 && at <= last.occurredAt + 5_000;
        })
        .map((request) => request.id)
        .slice(0, 500);
      return {
        id: `replay-${hash(`${tab}\u0000${first.id}\u0000${last.id}`)}`,
        ...(tab !== 'unknown' ? { tabId: Number(tab) } : {}),
        startedAt: new Date(first.occurredAt).toISOString(),
        completedAt: new Date(last.occurredAt).toISOString(),
        pageUrls: pages.slice(0, 100),
        interactionIds: values.map((interaction) => interaction.id).slice(0, 500),
        requestIds,
        deterministicInputs: [
          'structural DOM target fingerprints',
          'sanitized page origin and path',
          'captured request identifiers',
          'relative event timing',
          'explicit network and clock controls required before active replay',
        ],
      } satisfies BehavioralReplay;
    })
    .filter((value): value is BehavioralReplay => Boolean(value))
    .slice(0, 100);
}

function buildMutationPlans(
  findings: SecurityFinding[],
  invariants: BehavioralInvariant[],
): BehavioralMutationPlan[] {
  const plans: BehavioralMutationPlan[] = [];
  const operators: BehavioralMutationPlan['operator'][] = [
    'remove-auth-guard',
    'invert-condition',
    'duplicate-side-effect',
    'remove-idempotency',
    'accept-invalid-transition',
  ];
  const targets =
    findings.length > 0 ? findings : [{ id: 'behavioral-model', title: 'behavioral model' }];
  for (const [index, target] of targets.slice(0, 100).entries()) {
    const operator = operators[index % operators.length] ?? 'invert-condition';
    plans.push({
      id: `mutation-${hash(`${target.id}\u0000${operator}`)}`,
      operator,
      target: target.title,
      findingIds: target.id === 'behavioral-model' ? [] : [target.id],
      expectedTest: expectedMutationTest(operator, invariants),
      mode: 'isolated-offline',
    });
  }
  return plans;
}

function buildTimeline(
  interactions: CapturedInteraction[],
  traffic: TrafficRequest[],
  signals: BehavioralSignal[],
  chaos?: InteractionChaosReport | null,
  now = new Date(),
): BehavioralTimelineEvent[] {
  const events: Array<BehavioralTimelineEvent & { timestamp: number }> = [];
  for (const interaction of interactions) {
    events.push({
      id: `timeline-${hash(interaction.id)}`,
      occurredAt: new Date(interaction.occurredAt).toISOString(),
      timestamp: interaction.occurredAt,
      kind: 'interaction',
      label: `${interaction.kind} ${interaction.target.fingerprint}`,
      referenceIds: [interaction.id],
    });
  }
  for (const request of traffic) {
    const timestamp = Date.parse(request.startedAt);
    if (!Number.isFinite(timestamp)) continue;
    events.push({
      id: `timeline-${hash(request.id)}`,
      occurredAt: new Date(timestamp).toISOString(),
      timestamp,
      kind: (request.status ?? 0) >= 500 ? 'failure' : 'request',
      label: `${request.method.toUpperCase()} ${safeEndpoint(request.url)} -> ${request.status ?? 'pending'}`,
      referenceIds: [request.id],
    });
  }
  const interactionTimes = new Map(
    interactions.map((interaction) => [interaction.id, interaction.occurredAt]),
  );
  for (const signal of signals) {
    const timestamp = Math.max(
      0,
      ...signal.interactionIds.map((id) => interactionTimes.get(id) ?? 0),
    );
    events.push({
      id: `timeline-${hash(signal.id)}`,
      occurredAt: new Date(timestamp || now.getTime()).toISOString(),
      timestamp: timestamp || now.getTime(),
      kind: 'signal',
      label: signal.title,
      referenceIds: [signal.id, ...signal.interactionIds, ...signal.requestIds].slice(0, 100),
    });
  }
  for (const signal of chaos?.signals ?? []) {
    if (!signal.statuses.some((status) => status >= 500)) continue;
    const timestamp = Date.parse(signal.completedAt);
    events.push({
      id: `timeline-${hash(`failure\u0000${signal.id}`)}`,
      occurredAt: signal.completedAt,
      timestamp,
      kind: 'failure',
      label: `Mutation failure after rapid interaction: ${signal.statuses.join(', ')}`,
      referenceIds: [signal.id, ...signal.requestIds].slice(0, 100),
    });
  }
  return deduplicate(
    events.sort((left, right) => left.timestamp - right.timestamp),
    (event) => event.id,
  )
    .slice(-1_000)
    .map(({ timestamp: _timestamp, ...event }) => event);
}

function buildDigitalTwin(
  inventory: WorkspaceInventory,
  workflows: BehavioralWorkflow[],
  invariants: BehavioralInvariant[],
  traffic: TrafficRequest[],
  findings: SecurityFinding[],
): BehavioralDigitalTwin {
  const actorEvidence = inventory.routes.map((route) => route.path.toLowerCase());
  const actors = [
    actorEvidence.some((path) => /login|account|user|profile/.test(path))
      ? {
          id: 'actor-user',
          label: 'Authenticated user',
          evidence: ['identity-related route discovered'],
        }
      : undefined,
    actorEvidence.some((path) => /admin|manage|staff/.test(path))
      ? {
          id: 'actor-admin',
          label: 'Privileged operator',
          evidence: ['privileged route discovered'],
        }
      : undefined,
    traffic.length > 0
      ? {
          id: 'actor-browser',
          label: 'Browser client',
          evidence: [`${traffic.length} captured requests`],
        }
      : undefined,
    {
      id: 'actor-service',
      label: 'Application service',
      evidence: [`${inventory.routes.length} source routes`],
    },
  ].filter((value): value is { id: string; label: string; evidence: string[] } => Boolean(value));
  const assets = inventory.routes.slice(0, 250).map((route) => ({
    id: `asset-${hash(`${route.method}\u0000${route.path}`)}`,
    label: `${route.method} ${route.path}`,
    kind: sensitiveWords(route.path) ? 'sensitive-route' : 'route',
    evidence: [`${route.file}:${route.line}`],
  }));
  const trustBoundaries = [
    traffic.length > 0
      ? {
          id: 'boundary-browser-server',
          label: 'Browser to application boundary',
          evidence: [`${traffic.length} captured requests`],
        }
      : undefined,
    inventory.routes.some((route) => /auth|login|oauth|saml/i.test(route.path))
      ? {
          id: 'boundary-identity',
          label: 'Identity and session boundary',
          evidence: inventory.routes
            .filter((route) => /auth|login|oauth|saml/i.test(route.path))
            .slice(0, 20)
            .map((route) => route.path),
        }
      : undefined,
    findings.length > 0
      ? {
          id: 'boundary-code-proof',
          label: 'Source signal to verified evidence boundary',
          evidence: [`${findings.length} unverified static signals`],
        }
      : undefined,
  ].filter((value): value is { id: string; label: string; evidence: string[] } => Boolean(value));
  const learningFingerprint = hash(
    JSON.stringify({
      actors: actors.map((actor) => actor.id),
      assets: assets.map((asset) => asset.id),
      workflows: workflows.map((workflow) => workflow.id),
      invariants: invariants.map((invariant) => [invariant.id, invariant.status]),
    }),
    64,
  );
  return {
    actors,
    assets,
    trustBoundaries,
    workflowIds: workflows.map((workflow) => workflow.id),
    invariantIds: invariants.map((invariant) => invariant.id),
    learningFingerprint,
  };
}

function experimentTitle(kind: BehavioralExperimentKind): string {
  return {
    repeat: 'Repeat a sensitive workflow action',
    skip: 'Skip a required workflow state',
    reorder: 'Reorder workflow transitions',
    'multi-tab': 'Execute the workflow from two tabs',
    'logout-reuse': 'Reuse an action after logout or session change',
    concurrency: 'Race an exact mutation request',
    'offline-transition': 'Toggle offline during a mutation',
    'stale-cache': 'Replay the workflow with stale client cache',
    'expired-session': 'Expire the session between decision and mutation',
    'storage-corruption': 'Corrupt bounded client state and recover safely',
    'service-worker-drift': 'Run with mismatched service-worker and application versions',
    'keyboard-activation': 'Activate controls through Enter and Space',
  }[kind];
}

function experimentSteps(kind: BehavioralExperimentKind): string[] {
  const common = [
    'Capture the baseline state.',
    'Execute the bounded scenario.',
    'Assert every declared invariant.',
  ];
  const details: Record<BehavioralExperimentKind, string> = {
    repeat: 'Repeat the same user intent before the first operation settles.',
    skip: 'Attempt the final transition without the required predecessor.',
    reorder: 'Execute valid transitions in an invalid order.',
    'multi-tab': 'Start the same workflow from two isolated tab contexts.',
    'logout-reuse': 'Change identity state, then reuse the captured action.',
    concurrency: 'Dispatch the exact approved mutation concurrently.',
    'offline-transition': 'Move offline while the request is in flight, then reconnect.',
    'stale-cache': 'Restore a stale cache snapshot before the action.',
    'expired-session': 'Expire the session immediately before the mutation.',
    'storage-corruption': 'Replace one bounded client-state key with invalid structured data.',
    'service-worker-drift': 'Serve a previous worker against the current application shell.',
    'keyboard-activation':
      'Trigger the same control with Enter and Space and count durable effects.',
  };
  return [common[0] ?? '', details[kind], common[1] ?? '', common[2] ?? ''];
}

function expectedMutationTest(
  operator: BehavioralMutationPlan['operator'],
  invariants: BehavioralInvariant[],
): string {
  const invariant = invariants.find((item) => item.status !== 'holding') ?? invariants[0];
  return `A regression test must fail when Hawk applies ${operator} and must preserve ${invariant?.expression ?? 'the declared behavioral invariant'}.`;
}

function normalizeHost(value: string): string {
  try {
    const parsed = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
    return parsed.host.toLowerCase();
  } catch {
    return '';
  }
}

function safePage(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 2_000);
  } catch {
    return value.split(/[?#]/, 1)[0]?.slice(0, 2_000) ?? '';
  }
}

function safeEndpoint(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 2_000);
  } catch {
    return value.split(/[?#]/, 1)[0]?.slice(0, 2_000) ?? '';
  }
}

function pageLabel(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.pathname === '/' ? parsed.host : parsed.pathname;
  } catch {
    return value;
  }
}

function sensitiveWords(value: string): boolean {
  return /auth|admin|payment|checkout|order|coupon|balance|transfer|token|session|permission/i.test(
    value,
  );
}

function bounded(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const output = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    const current = output.get(id) ?? [];
    current.push(value);
    output.set(id, current);
  }
  return output;
}

function deduplicate<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function hash(value: string, length = 20): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}
