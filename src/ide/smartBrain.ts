import { CapabilityRegistry } from './capabilityRegistry.js';
import { DurableStore } from './durableStore.js';
import { HawkEvalLab } from './evalLab.js';
import { GovernedMemory } from './governedMemory.js';
import { HawkModelRouter } from './modelRouter.js';
import { EvidenceVerifier, ProofGraph } from './proofGraph.js';
import { type GoalInput, ScopePolicyEngine, compileGoal, stableHash } from './scopePolicy.js';
import { McpSecuritySentinel } from './securitySentinel.js';
import { SmartPlanner } from './smartPlanner.js';
import { type CapabilityExecutor, SmartRunEngine } from './smartRunEngine.js';
import type { GoalSpec, HawkPlan, PlanApproval, PolicyEvaluation } from './smartTypes.js';

export class SmartMcpBrain {
  readonly store: DurableStore;
  readonly capabilities: CapabilityRegistry;
  readonly policy: ScopePolicyEngine;
  readonly planner: SmartPlanner;
  readonly modelRouter: HawkModelRouter;
  readonly graph: ProofGraph;
  readonly evals: HawkEvalLab;
  readonly verifier: EvidenceVerifier;
  readonly memory: GovernedMemory;
  readonly sentinel: McpSecuritySentinel;
  readonly runs: SmartRunEngine;

  constructor(
    private readonly workspaceRoot: string,
    executor: CapabilityExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.store = new DurableStore(workspaceRoot);
    this.capabilities = new CapabilityRegistry();
    this.policy = new ScopePolicyEngine();
    this.graph = new ProofGraph(this.store, now);
    this.evals = new HawkEvalLab(this.store, now);
    this.modelRouter = new HawkModelRouter();
    this.planner = new SmartPlanner(this.capabilities, now, this.modelRouter);
    this.evals.onModelProfilesChanged((profiles) => this.modelRouter.setProfiles(profiles));
    this.verifier = new EvidenceVerifier(this.graph, this.store, now);
    this.memory = new GovernedMemory(this.store, now);
    this.sentinel = new McpSecuritySentinel(this.store, now);
    this.runs = new SmartRunEngine(this.store, this.graph, executor, now);
  }

  async initialize(): Promise<void> {
    // Hydrate measured model performance before the first plan is created.
    // Subsequent eval writes publish through the subscription above, keeping
    // route decisions live for the lifetime of this brain.
    this.modelRouter.setProfiles(await this.evals.performanceProfiles());
    await this.runs.initialize();
  }

  async createPlan(
    input: GoalInput,
    requestedCapabilities: string[] = [],
  ): Promise<{ goal: GoalSpec; plan: HawkPlan; policy: PolicyEvaluation }> {
    const goal = compileGoal(this.workspaceRoot, input, this.now);
    const plan = this.planner.create(goal, requestedCapabilities);
    const capabilities = plan.nodes.map((node) => {
      const capability = this.capabilities.get(node.capabilityId);
      if (!capability) throw new Error(`Capability disappeared: ${node.capabilityId}`);
      return capability;
    });
    const policy = this.policy.evaluate(goal, plan, capabilities);
    await Promise.all([
      this.store.writeJson('goals', goal.id, goal),
      this.store.writeJson('plans', plan.id, plan),
      this.store.writeJson('policies', plan.id, policy),
    ]);
    return { goal, plan, policy };
  }

  async approvePlan(
    planId: string,
    approvedBy: string,
    expectedPlanHash: string,
    ttlMinutes?: number,
  ): Promise<PlanApproval> {
    const plan = await this.requirePlan(planId);
    if (plan.planHash !== expectedPlanHash)
      throw new Error('Plan hash changed; inspect the new plan before approving it');
    const goal = await this.requireGoal(plan.goalId);
    this.assertGoalContract(plan, goal);
    const approval = this.policy.approve(goal, plan, approvedBy, ttlMinutes, this.now);
    await this.store.writeJson('approvals', approval.id, approval);
    await this.store.writeJson('plan-approvals', plan.id, approval);
    return approval;
  }

  async startRun(planId: string, executionInputs: Record<string, unknown> = {}) {
    const plan = await this.requirePlan(planId);
    const goal = await this.requireGoal(plan.goalId);
    this.assertGoalContract(plan, goal);
    const policy = this.policy.evaluate(
      goal,
      plan,
      plan.nodes.map((node) => {
        const capability = this.capabilities.get(node.capabilityId);
        if (!capability) throw new Error(`Capability disappeared: ${node.capabilityId}`);
        return capability;
      }),
    );
    await this.store.writeJson<PolicyEvaluation>('policies', plan.id, policy);
    const approval = await this.store.readJson<PlanApproval>('plan-approvals', plan.id);
    if (
      policy.decision === 'require-approval' &&
      !this.policy.validateApproval(approval, goal, plan, this.now)
    )
      throw new Error('Plan approval is missing, expired, or bound to a different plan hash');
    return await this.runs.start(goal, plan, policy, approval, executionInputs);
  }

  async getPlan(planId: string): Promise<HawkPlan | undefined> {
    return await this.store.readJson<HawkPlan>('plans', planId);
  }

  async getGoal(goalId: string): Promise<GoalSpec | undefined> {
    return await this.store.readJson<GoalSpec>('goals', goalId);
  }

  async listPlans(): Promise<HawkPlan[]> {
    return (await this.store.listJson<HawkPlan>('plans')).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  private async requirePlan(planId: string): Promise<HawkPlan> {
    const plan = await this.getPlan(planId);
    if (!plan) throw new Error(`Unknown Hawk plan: ${planId}`);
    const { planHash, ...planBase } = plan;
    if (stableHash(planBase) !== planHash)
      throw new Error(`Hawk plan ${planId} failed its SHA-256 integrity check`);
    return plan;
  }

  private async requireGoal(goalId: string): Promise<GoalSpec> {
    const goal = await this.getGoal(goalId);
    if (!goal) throw new Error(`Unknown Hawk goal: ${goalId}`);
    return goal;
  }

  private assertGoalContract(plan: HawkPlan, goal: GoalSpec): void {
    if (plan.goalHash !== stableHash(goal))
      throw new Error(
        `Goal contract for ${plan.id} changed after planning; compile and review a new plan`,
      );
  }
}
