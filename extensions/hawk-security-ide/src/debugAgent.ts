import * as vscode from 'vscode';
import type { HawkAgentPanel } from './agentPanel';
import type { DaemonClient } from './daemonClient';
import {
  runAutomaticDebugFixLoop,
  type DebugFixLoopProgress,
  type DebugReproductionResult,
} from './debugFixLoop';
import type { AiSessionSummary } from './types';

const MAX_STACK_FRAMES = 24;
const MAX_SCOPES = 10;
const MAX_VARIABLES = 80;
const MAX_VALUE_CHARS = 500;
const MAX_SNAPSHOT_CHARS = 28_000;
const DEBUG_RELAUNCH_TIMEOUT_MS = 30_000;

interface DapThread {
  id: number;
  name?: string;
}

interface DapStackFrame {
  id: number;
  name?: string;
  line?: number;
  column?: number;
  source?: { name?: string; path?: string };
}

interface DapScope {
  name?: string;
  variablesReference?: number;
  expensive?: boolean;
}

interface DapVariable {
  name?: string;
  value?: string;
  type?: string;
  variablesReference?: number;
}

export interface HawkDebugSnapshot {
  capturedAt: string;
  session: { name: string; type: string };
  breakpoints: string[];
  threads: Array<{
    id: number;
    name: string;
    frames: Array<{
      id: number;
      name: string;
      source: string;
      line: number;
      column: number;
      scopes: Array<{
        name: string;
        variables: Array<{ name: string; type: string; value: string }>;
      }>;
    }>;
  }>;
  diagnostics: string[];
  warnings: string[];
}

/**
 * Native debugger bridge for Hawk AI. It reads the active Debug Adapter
 * Protocol session without pausing or mutating it, then sends a bounded,
 * redacted snapshot to an isolated Hawk agent when the operator asks for a fix.
 */
export class HawkDebugAgent implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output = vscode.window.createOutputChannel('Hawk Debug Agent');
  private activeLoop: AbortController | undefined;
  private activeLoopSession: { workspace: vscode.Uri; id: string } | undefined;

  constructor(
    private readonly agentPanel: HawkAgentPanel,
    private readonly client: DaemonClient,
  ) {
    this.disposables.push(
      this.output,
      vscode.commands.registerCommand('hawk.debug.capture', async () => {
        const snapshot = await this.capture();
        const document = await vscode.workspace.openTextDocument({
          language: 'markdown',
          content: renderSnapshot(snapshot),
        });
        await vscode.window.showTextDocument(document, {
          preview: true,
          viewColumn: vscode.ViewColumn.Beside,
        });
      }),
      vscode.commands.registerCommand('hawk.debug.fixFailure', async () => {
        await this.startFixLoop();
      }),
      vscode.commands.registerCommand('hawk.debug.stopFixLoop', () => {
        if (!this.activeLoop) {
          vscode.window.showInformationMessage('No Hawk automatic debug loop is running.');
          return;
        }
        this.activeLoop.abort();
        const active = this.activeLoopSession;
        if (active) {
          void this.client.cancelAiTests(active.workspace, active.id).catch(() => undefined);
        }
      }),
      vscode.debug.onDidStartDebugSession((session) => {
        this.output.appendLine(`Attached to ${session.name} (${session.type}).`);
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.output.appendLine(`Debug session ended: ${session.name}.`);
      }),
    );
  }

  dispose(): void {
    this.activeLoop?.abort();
    for (const disposable of this.disposables) disposable.dispose();
  }

  async capture(): Promise<HawkDebugSnapshot> {
    const session = vscode.debug.activeDebugSession;
    if (!session) throw new Error('Start a debugger and stop on a breakpoint or exception first.');
    const warnings: string[] = [];
    const threads: HawkDebugSnapshot['threads'] = [];
    let dapThreads: DapThread[] = [];
    try {
      const response = (await session.customRequest('threads')) as { threads?: DapThread[] };
      dapThreads = Array.isArray(response.threads) ? response.threads.slice(0, 12) : [];
    } catch (err) {
      warnings.push(`Threads are unavailable: ${errorMessage(err)}`);
    }

    for (const thread of dapThreads) {
      const frames = await this.captureFrames(session, thread.id, warnings);
      threads.push({
        id: thread.id,
        name: bound(thread.name || `Thread ${thread.id}`, 200),
        frames,
      });
    }
    const snapshot: HawkDebugSnapshot = {
      capturedAt: new Date().toISOString(),
      session: { name: bound(session.name, 200), type: bound(session.type, 100) },
      breakpoints: captureBreakpoints(),
      threads,
      diagnostics: captureDiagnostics(),
      warnings,
    };
    return shrinkSnapshot(snapshot);
  }

  private async startFixLoop(): Promise<void> {
    if (this.activeLoop) {
      throw new Error('A Hawk automatic debug loop is already running.');
    }
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspace || !vscode.workspace.isTrusted) {
      throw new Error('Open and trust a workspace before using the Hawk Debug Agent.');
    }
    const snapshot = await this.capture();
    const launch = this.captureLaunchConfiguration();
    const approval = await vscode.window.showWarningMessage(
      'Start a Hawk agent in an isolated worktree with this debugger snapshot? It can edit and run detected test gates, but Apply remains manual.',
      { modal: true },
      'Start debug fix',
    );
    if (approval !== 'Start debug fix') return;
    const context = renderSnapshot(snapshot).slice(0, MAX_SNAPSHOT_CHARS);
    const session = await this.agentPanel.startTask(
      workspace,
      [
        'Diagnose the stopped debugger state below, identify the root cause, implement the smallest production-safe fix, and add or update a regression test.',
        'Use the stack, variables, breakpoints, and diagnostics as evidence. Do not guess secrets or modify unrelated code.',
        'Do not run project commands yourself. After editing, leave an exact reviewable diff; the Hawk control plane will run only the operator-approved test gates.',
      ].join(' '),
      context,
    );
    if (session.testGates.length === 0) {
      vscode.window.showWarningMessage(
        'Hawk started the isolated debug fix, but no safe automatic test gate was detected. It will stop at manual review after this attempt.',
      );
      return;
    }
    const maxAttempts = Math.max(
      1,
      Math.min(
        6,
        Math.floor(
          vscode.workspace.getConfiguration('hawk.debug.autoFix').get<number>('maxAttempts', 3),
        ),
      ),
    );
    const commands = session.testGates
      .map((gate) => `${gate.command} ${gate.args.join(' ')}`.trim())
      .join('\n');
    const testApproval = await vscode.window.showWarningMessage(
      `Let Hawk run these commands inside the isolated worktree after every fix, for at most ${maxAttempts} attempts?\n\n${commands}\n\nNo patch will be applied automatically.`,
      { modal: true },
      'Approve automatic loop',
    );
    if (testApproval !== 'Approve automatic loop') {
      vscode.window.showInformationMessage(
        'The first isolated debug attempt is still running. Automatic tests and retries were not approved.',
      );
      return;
    }

    const controller = new AbortController();
    this.activeLoop = controller;
    this.activeLoopSession = { workspace, id: session.id };
    let latestSession = session;
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Hawk Debug Agent',
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            controller.abort();
            void this.client.cancelAiTests(workspace, session.id).catch(() => undefined);
          });
          return await runAutomaticDebugFixLoop({
            session,
            maxAttempts,
            signal: controller.signal,
            driver: {
              getSession: async (sessionId) => {
                latestSession = (await this.client.aiEvents(workspace, sessionId, 0)).session;
                return latestSession;
              },
              runTests: async (sessionId, gateIds) => {
                const updated = await this.client.runAiTests(workspace, sessionId, gateIds);
                latestSession = updated;
                await this.agentPanel.watchTask(workspace, updated);
                return updated;
              },
              continueSession: async (sessionId, prompt, retryContext) => {
                const updated = await this.client.continueAiSession(
                  workspace,
                  sessionId,
                  prompt,
                  retryContext,
                );
                latestSession = updated;
                await this.agentPanel.watchTask(workspace, updated);
                return updated;
              },
              relaunchDebugger: launch
                ? async () => {
                    await this.relaunchDebugger(launch, latestSession.sandboxPath);
                  }
                : undefined,
              reproduceFailure: launch ? async () => await this.reproduceFailure() : undefined,
            },
            buildRetry: async (failed, attempt, reproduction) =>
              await this.buildRetry(failed, snapshot, attempt, maxAttempts, reproduction),
            onProgress: async (update) => {
              const message = debugProgressMessage(update);
              progress.report({ message });
              this.output.appendLine(message);
            },
          });
        },
      );
      await this.agentPanel.watchTask(workspace, result.session);
      if (result.outcome === 'passed') {
        vscode.window.showInformationMessage(
          `Hawk fixed and verified the debugger failure in ${result.attempts} attempt(s). Review the diff, then Apply or Reject it manually.`,
        );
      } else if (result.outcome === 'exhausted') {
        vscode.window.showWarningMessage(
          `Hawk reached the ${result.attempts}-attempt safety limit. The latest diff and failing evidence are preserved for manual review.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        vscode.window.showInformationMessage(
          'Hawk stopped automatic retries. The isolated worktree and current patch are preserved.',
        );
        return;
      }
      throw err;
    } finally {
      if (this.activeLoop === controller) this.activeLoop = undefined;
      if (this.activeLoopSession?.id === session.id) this.activeLoopSession = undefined;
    }
  }

  private async buildRetry(
    session: AiSessionSummary,
    originalSnapshot: HawkDebugSnapshot,
    attempt: number,
    maxAttempts: number,
    reproduction?: DebugReproductionResult,
  ): Promise<{ prompt: string; context: string }> {
    let snapshot = originalSnapshot;
    if (vscode.debug.activeDebugSession) {
      snapshot = await this.capture().catch(() => originalSnapshot);
    }
    const failures = session.testResults
      .filter((result) => result.status !== 'passed')
      .map(
        (result) =>
          `${result.label} (${result.status}, exit ${result.exitCode ?? 'none'}):\n${bound(result.output, 7_000)}`,
      )
      .join('\n\n');
    return {
      prompt: [
        `Automatic debug attempt ${attempt} of ${maxAttempts} did not verify.`,
        'Diagnose the exact failing gate output and debugger evidence, repair the current isolated worktree, and strengthen the regression test.',
        'Preserve correct changes already made, do not run project commands yourself, and stop with a reviewable diff for the approved Hawk test runner.',
      ].join(' '),
      context: [
        '# Latest approved test evidence',
        '',
        failures || 'The agent failed before approved gates completed.',
        '',
        '# Latest debugger reproduction evidence',
        '',
        reproduction
          ? `${reproduction.status}:\n${bound(reproduction.output, 7_000)}`
          : 'Debugger reproduction was not run.',
        '',
        renderSnapshot(snapshot),
      ]
        .join('\n')
        .slice(0, MAX_SNAPSHOT_CHARS),
    };
  }

  private captureLaunchConfiguration():
    | { folder: vscode.WorkspaceFolder | undefined; configuration: vscode.DebugConfiguration }
    | undefined {
    const active = vscode.debug.activeDebugSession;
    if (!active) return undefined;
    return {
      folder: active.workspaceFolder,
      configuration: { ...active.configuration },
    };
  }

  /** Stop and start the exact launch profile that produced the original failure. */
  private async relaunchDebugger(
    launch: {
      folder: vscode.WorkspaceFolder | undefined;
      configuration: vscode.DebugConfiguration;
    },
    isolatedRoot?: string,
  ): Promise<void> {
    const current = vscode.debug.activeDebugSession;
    if (current) await vscode.debug.stopDebugging(current);
    const configuration = isolatedRoot
      ? rewriteDebugConfiguration(launch.configuration, isolatedRoot)
      : launch.configuration;
    const started = await vscode.debug.startDebugging(launch.folder, configuration);
    if (!started)
      throw new Error('Hawk could not relaunch the debugger with the saved launch configuration.');

    const deadline = Date.now() + DEBUG_RELAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const active = vscode.debug.activeDebugSession;
      if (
        active &&
        active.type === configuration.type &&
        (!configuration.name || active.name === configuration.name)
      ) {
        // Give the adapter a short window to emit its initial stopped/exception
        // event before the DAP snapshot is captured.
        await delay(250);
        this.output.appendLine(`Relaunched debugger: ${active.name} (${active.type}).`);
        return;
      }
      await delay(100);
    }
    throw new Error('The relaunched debugger did not become active before the Hawk timeout.');
  }

  private async reproduceFailure(): Promise<DebugReproductionResult> {
    const active = vscode.debug.activeDebugSession;
    if (!active) return { status: 'failed', output: 'No active debugger session after relaunch.' };
    try {
      const outcome = waitForReproductionEvent(active, DEBUG_RELAUNCH_TIMEOUT_MS);
      await Promise.resolve(active.customRequest('continue')).catch(() => undefined);
      const event = await outcome;
      if (event === 'timeout') {
        return {
          status: 'failed',
          output:
            'No debugger stopped/exception event arrived before the relaunch timeout; reproduction is inconclusive.',
        };
      }
      if (event === 'terminated' || event === 'exited') {
        return {
          status: 'not-reproduced',
          output: `Debugger ${event} without a failure stop event.`,
        };
      }
      const snapshot = await this.capture();
      const output = renderSnapshot(snapshot);
      const unavailable = snapshot.warnings.some((warning) =>
        /threads are unavailable/i.test(warning),
      );
      return {
        // A running session with no stopped threads is the expected signal after
        // a fix. An adapter that cannot expose threads is an inconclusive run.
        status: unavailable
          ? 'failed'
          : snapshot.threads.some((thread) => thread.frames.length > 0)
            ? 'reproduced'
            : 'not-reproduced',
        output,
      };
    } catch (err) {
      return { status: 'failed', output: errorMessage(err) };
    }
  }

  private async captureFrames(
    session: vscode.DebugSession,
    threadId: number,
    warnings: string[],
  ): Promise<HawkDebugSnapshot['threads'][number]['frames']> {
    let frames: DapStackFrame[] = [];
    try {
      const response = (await session.customRequest('stackTrace', {
        threadId,
        startFrame: 0,
        levels: MAX_STACK_FRAMES,
      })) as { stackFrames?: DapStackFrame[] };
      frames = Array.isArray(response.stackFrames)
        ? response.stackFrames.slice(0, MAX_STACK_FRAMES)
        : [];
    } catch (err) {
      warnings.push(`Stack for thread ${threadId} is unavailable: ${errorMessage(err)}`);
      return [];
    }

    const output: HawkDebugSnapshot['threads'][number]['frames'] = [];
    for (const [index, frame] of frames.entries()) {
      const scopes = index < 3 ? await this.captureScopes(session, frame.id, warnings) : [];
      output.push({
        id: frame.id,
        name: bound(frame.name || 'anonymous frame', 300),
        source: bound(frame.source?.path || frame.source?.name || 'unknown source', 800),
        line: Math.max(0, Number(frame.line) || 0),
        column: Math.max(0, Number(frame.column) || 0),
        scopes,
      });
    }
    return output;
  }

  private async captureScopes(
    session: vscode.DebugSession,
    frameId: number,
    warnings: string[],
  ): Promise<HawkDebugSnapshot['threads'][number]['frames'][number]['scopes']> {
    let scopes: DapScope[] = [];
    try {
      const response = (await session.customRequest('scopes', { frameId })) as {
        scopes?: DapScope[];
      };
      scopes = Array.isArray(response.scopes) ? response.scopes.slice(0, MAX_SCOPES) : [];
    } catch (err) {
      warnings.push(`Scopes for frame ${frameId} are unavailable: ${errorMessage(err)}`);
      return [];
    }

    const output: HawkDebugSnapshot['threads'][number]['frames'][number]['scopes'] = [];
    for (const scope of scopes) {
      if (!scope.variablesReference || scope.expensive) continue;
      try {
        const response = (await session.customRequest('variables', {
          variablesReference: scope.variablesReference,
          start: 0,
          count: MAX_VARIABLES,
        })) as { variables?: DapVariable[] };
        const variables = (response.variables ?? []).slice(0, MAX_VARIABLES).map((variable) => ({
          name: bound(variable.name || 'value', 200),
          type: bound(variable.type || '', 200),
          value: redactVariable(
            bound(variable.name || 'value', 200),
            bound(variable.value || '', MAX_VALUE_CHARS),
          ),
        }));
        output.push({ name: bound(scope.name || 'scope', 200), variables });
      } catch (err) {
        warnings.push(
          `Variables for ${scope.name || 'scope'} are unavailable: ${errorMessage(err)}`,
        );
      }
    }
    return output;
  }
}

function captureBreakpoints(): string[] {
  return vscode.debug.breakpoints.slice(0, 100).map((breakpoint) => {
    if (breakpoint instanceof vscode.SourceBreakpoint) {
      const location = breakpoint.location;
      return `${breakpoint.enabled ? 'enabled' : 'disabled'} source ${vscode.workspace.asRelativePath(
        location.uri,
      )}:${location.range.start.line + 1}${breakpoint.condition ? ` if ${redactValue(bound(breakpoint.condition, 300))}` : ''}`;
    }
    if (breakpoint instanceof vscode.FunctionBreakpoint) {
      return `${breakpoint.enabled ? 'enabled' : 'disabled'} function ${bound(breakpoint.functionName, 300)}`;
    }
    return `${breakpoint.enabled ? 'enabled' : 'disabled'} data/instruction breakpoint`;
  });
}

function captureDiagnostics(): string[] {
  return vscode.languages
    .getDiagnostics()
    .flatMap(([uri, diagnostics]) =>
      diagnostics
        .filter((diagnostic) => diagnostic.severity <= vscode.DiagnosticSeverity.Warning)
        .slice(0, 20)
        .map(
          (diagnostic) =>
            `${vscode.workspace.asRelativePath(uri)}:${diagnostic.range.start.line + 1} [${vscode.DiagnosticSeverity[diagnostic.severity]}] ${bound(diagnostic.message, 500)}`,
        ),
    )
    .slice(0, 80);
}

function shrinkSnapshot(snapshot: HawkDebugSnapshot): HawkDebugSnapshot {
  let serialized = JSON.stringify(snapshot);
  if (serialized.length <= MAX_SNAPSHOT_CHARS) return snapshot;
  for (const thread of snapshot.threads) {
    for (const frame of thread.frames) {
      for (const scope of frame.scopes) scope.variables = scope.variables.slice(0, 20);
    }
    thread.frames = thread.frames.slice(0, 12);
  }
  snapshot.diagnostics = snapshot.diagnostics.slice(0, 30);
  serialized = JSON.stringify(snapshot);
  if (serialized.length > MAX_SNAPSHOT_CHARS) {
    snapshot.threads = snapshot.threads.slice(0, 4);
  }
  return snapshot;
}

function renderSnapshot(snapshot: HawkDebugSnapshot): string {
  return [
    '# Hawk Debug Snapshot',
    '',
    `Captured: ${snapshot.capturedAt}`,
    `Session: ${snapshot.session.name} (${snapshot.session.type})`,
    '',
    '## Breakpoints',
    '',
    ...(snapshot.breakpoints.length ? snapshot.breakpoints.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Threads and stack',
    '',
    ...snapshot.threads.flatMap((thread) => [
      `### ${thread.name} · ${thread.id}`,
      '',
      ...thread.frames.flatMap((frame) => [
        `- ${frame.name} — ${frame.source}:${frame.line}:${frame.column}`,
        ...frame.scopes.flatMap((scope) => [
          `  - ${scope.name}`,
          ...scope.variables.map(
            (variable) =>
              `    - ${variable.name}${variable.type ? ` (${variable.type})` : ''} = ${variable.value}`,
          ),
        ]),
      ]),
      '',
    ]),
    '## Diagnostics',
    '',
    ...(snapshot.diagnostics.length ? snapshot.diagnostics.map((item) => `- ${item}`) : ['- None']),
    ...(snapshot.warnings.length
      ? ['', '## Capture warnings', '', ...snapshot.warnings.map((item) => `- ${item}`)]
      : []),
    '',
  ]
    .join('\n')
    .slice(0, MAX_SNAPSHOT_CHARS);
}

function redactValue(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|authorization|cookie|password|secret|token)\b\s*[:=]\s*["']?[^"',}\s]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED_AUTH]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:gh[pousr]|github_pat|sk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]');
}

function redactVariable(name: string, value: string): string {
  if (
    /(?:^|[_-])(api[_-]?key|authorization|cookie|credential|password|secret|token)(?:$|[_-])/i.test(
      name,
    )
  ) {
    return '[REDACTED]';
  }
  return redactValue(value);
}

function bound(value: string, length: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, length);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rewriteDebugConfiguration(
  configuration: vscode.DebugConfiguration,
  isolatedRoot: string,
): vscode.DebugConfiguration {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let output = value.replaceAll('${workspaceFolder}', isolatedRoot);
      if (workspaceRoot) output = output.replaceAll(workspaceRoot, isolatedRoot);
      return output;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]));
    }
    return value;
  };
  const rewritten = rewrite(configuration) as vscode.DebugConfiguration;
  rewritten.cwd = isolatedRoot;
  return rewritten;
}

type ReproductionEvent = 'stopped' | 'terminated' | 'exited' | 'timeout';

function waitForReproductionEvent(
  session: vscode.DebugSession,
  timeoutMs: number,
): Promise<ReproductionEvent> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (event: ReproductionEvent): void => {
      if (settled) return;
      settled = true;
      disposable.dispose();
      clearTimeout(timer);
      resolve(event);
    };
    const disposable = vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
      if (event.session.id !== session.id) return;
      if (
        event.event === 'stopped' ||
        event.event === 'terminated' ||
        event.event === 'exited'
      ) {
        finish(event.event);
      }
    });
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function debugProgressMessage(update: DebugFixLoopProgress): string {
  const prefix = `Attempt ${update.attempt}/${update.maxAttempts}`;
  switch (update.phase) {
    case 'waiting':
      return `${prefix}: agent is diagnosing and editing the isolated worktree.`;
    case 'relaunching':
      return `${prefix}: relaunching the saved debugger configuration.`;
    case 'reproducing':
      return `${prefix}: reproducing the original failure and capturing DAP evidence.`;
    case 'testing':
      return `${prefix}: running operator-approved test gates.`;
    case 'retrying':
      return `${prefix}: verification failed; feeding exact evidence back to the agent.`;
    case 'passed':
      return `${prefix}: every approved gate passed.`;
    case 'exhausted':
      return `${prefix}: safety limit reached; preserving the latest reviewable state.`;
  }
}
