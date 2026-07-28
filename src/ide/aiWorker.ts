import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Agent } from '../agent/agent.js';
import * as config from '../config/config.js';
import { createRoutedClient, purposeForTask } from '../llm/routing.js';
import { Store } from '../session/store.js';
import { skillSearchDirs } from '../skills/discovery.js';
import { Registry as SkillRegistry } from '../skills/registry.js';
import { newTarget } from '../target/target.js';
import {
  FileEditTool,
  FileEditToolAlias,
  FileReadTool,
  FileReadToolAlias,
  FileWriteTool,
  FileWriteToolAlias,
} from '../tools/file.js';
import { Registry as ToolRegistry } from '../tools/registry.js';
import { GlobTool, GrepTool } from '../tools/search.js';
import {
  IsolatedFileDeleteTool,
  WorkspaceBoundTool,
  WorkspacePrompter,
  buildWorkerPrompt,
  serializeWorkerEvent,
} from './aiWorkerSafety.js';

export { IsolatedFileDeleteTool } from './aiWorkerSafety.js';

interface WorkerRequest {
  sessionId: string;
  agentSessionPath: string;
  workspaceRoot: string;
  prompt: string;
  context?: string;
}

interface WorkerEnvelope {
  type: 'agent-event' | 'worker-info' | 'worker-result';
  event?: ReturnType<typeof serializeWorkerEvent>;
  provider?: string;
  model?: string;
  ok?: boolean;
}

/**
 * Runs one native Hawk AI turn in an isolated git worktree. The daemon starts
 * this mode as a child process so relative file tools are naturally rooted in
 * the worktree and a crashed provider cannot take down the local control plane.
 */
export async function runAiWorkerCli(): Promise<void> {
  const request = await readWorkerRequest();
  const root = await realpath(resolve(request.workspaceRoot));
  const cfg = config.load();
  const client = createRoutedClient(cfg, purposeForTask(request.prompt));
  emit({ type: 'worker-info', provider: client.name(), model: client.model() });

  const prompter = new WorkspacePrompter(root);
  const tools = new ToolRegistry();
  for (const tool of [
    new FileReadTool(),
    new FileReadToolAlias(),
    new FileWriteTool(),
    new FileWriteToolAlias(),
    new FileEditTool(),
    new FileEditToolAlias(),
    new IsolatedFileDeleteTool(),
    new GlobTool(),
    new GrepTool(),
  ]) {
    tools.register(new WorkspaceBoundTool(root, tool));
  }

  const skills = new SkillRegistry();
  for (const directory of skillSearchDirs(cfg.skills_dirs)) skills.loadDir(directory);
  skills.setDisabledNames(cfg.disabled_skills);

  const store = new Store(request.agentSessionPath, request.sessionId);
  const agent = new Agent({
    client,
    tools,
    skills,
    prompter,
    store,
    target: newTarget(),
    thinkingEnabled: cfg.thinking_enabled,
    maxSteps: cfg.max_steps > 0 ? cfg.max_steps : 30,
    autoCompactThreshold: cfg.auto_compact_threshold,
    toolingProfile: cfg.tooling_profile ?? 'minimal',
    streamingEnabled: cfg.streaming_enabled,
  });
  if (agent.hasSavedSession()) agent.resumeSaved();

  let failed = false;
  const task = buildWorkerPrompt(request.prompt, request.context);
  await agent.run(task, new AbortController().signal, (event) => {
    if (event.type === 'error') failed = true;
    emit({ type: 'agent-event', event: serializeWorkerEvent(event) });
  });
  emit({ type: 'worker-result', ok: !failed });
}

async function readWorkerRequest(): Promise<WorkerRequest> {
  const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of reader) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as Partial<WorkerRequest>;
    if (!value.sessionId || !value.agentSessionPath || !value.workspaceRoot || !value.prompt) {
      throw new Error('AI worker request is missing required fields');
    }
    return value as WorkerRequest;
  }
  throw new Error('AI worker did not receive a request');
}

function emit(envelope: WorkerEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
