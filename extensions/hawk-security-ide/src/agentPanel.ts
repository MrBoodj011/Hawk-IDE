import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { renderAgentPanelHtml } from './agentPanelHtml';
import type { DaemonClient } from './daemonClient';
import type { HawkTerminalCapture } from './terminalCapture';
import type { AiSessionSummary } from './types';

const MAX_PROMPT_CHARS = 12_000;
const MAX_SELECTION_CHARS = 6_000;
const MAX_CONTEXT_CHARS = 18_000;
const POLL_INTERVAL_MS = 350;
const execFileAsync = promisify(execFile);

/** Native Hawk AI workbench backed by durable, isolated daemon sessions. */
export class HawkAgentPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private activeWorkspace: vscode.Uri | undefined;
  private activeSessionId: string | undefined;
  private lastEventId = 0;
  private parallelBatchSessionIds: string[] = [];
  private parallelBatchId: string | undefined;
  private parallelBatchCursors: Record<string, number> = {};
  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: DaemonClient,
    private readonly terminalCapture: HawkTerminalCapture,
  ) {}

  open(workspace: vscode.Uri, initialPrompt = ''): void {
    this.activeWorkspace = workspace;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      if (initialPrompt) {
        void this.panel.webview.postMessage({ type: 'prefill', prompt: initialPrompt });
      }
      void this.syncHistory();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'hawk.agent',
      'Hawk AI',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'hawk-mark.png');
    panel.webview.html = renderAgentPanelHtml(panel.webview, this.extensionUri, initialPrompt);
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      this.stopPolling();
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  async startTask(workspace: vscode.Uri, prompt: string, context = ''): Promise<AiSessionSummary> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before starting a Hawk AI task.');
    }
    this.open(workspace);
    this.post({ type: 'busy', text: 'Preparing an isolated Hawk worktree…' });
    const session = await this.client.createAiSession(
      workspace,
      prompt.slice(0, MAX_PROMPT_CHARS),
      context.slice(0, MAX_CONTEXT_CHARS),
    );
    this.activeSessionId = session.id;
    this.parallelBatchId = undefined;
    this.parallelBatchCursors = {};
    this.lastEventId = 0;
    this.post({ type: 'session', session });
    await this.syncHistory();
    this.startPolling();
    return session;
  }

  async watchTask(workspace: vscode.Uri, session: AiSessionSummary): Promise<void> {
    this.open(workspace);
    this.activeSessionId = session.id;
    this.post({ type: 'session', session });
    await this.syncHistory();
    if (isBusy(session.status)) this.startPolling();
  }

  dispose(): void {
    this.stopPolling();
    this.panel?.dispose();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    const action = typeof record.action === 'string' ? record.action : '';
    try {
      switch (action) {
        case 'ready':
          await this.syncHistory();
          if (this.activeSessionId) await this.selectSession(this.activeSessionId);
          return;
        case 'settings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'hawk');
          return;
        case 'new-session':
          this.newSession();
          return;
        case 'select-session':
          if (typeof record.sessionId === 'string') await this.selectSession(record.sessionId);
          return;
        case 'review-changes':
        case 'show-diff':
          await this.showDiff();
          return;
        case 'run-tests':
          await this.runTests();
          return;
        case 'run-reproduction':
          await this.runReproduction();
          return;
        case 'semantic-review':
          await this.runSemanticReview();
          return;
        case 'apply':
          await this.applyChanges();
          return;
        case 'reject':
          await this.rejectChanges();
          return;
        case 'revert':
          await this.revertChanges();
          return;
        case 'checkpoint':
          await this.createCheckpoint();
          return;
        case 'restore-checkpoint':
          await this.restoreCheckpoint();
          return;
        case 'open-terminal':
          await this.openTaskTerminal();
          return;
        case 'cancel':
          await this.cancelTask();
          return;
        case 'pause':
          await this.pauseTask();
          return;
        case 'resume':
          await this.resumeTask();
          return;
        case 'smart-merge':
          await this.smartMerge();
          return;
        case 'ask':
          await this.ask(record);
          return;
        case 'autonomous':
          await this.runAutonomousVerifiedTask(record);
          return;
        case 'parallel':
          await this.runParallelLanes(record);
          return;
      }
    } catch (err) {
      this.post({ type: 'error', text: errorMessage(err) });
    }
  }

  private async ask(record: Record<string, unknown>): Promise<void> {
    if (typeof record.prompt !== 'string') return;
    const prompt = record.prompt.trim();
    if (!prompt) return;
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`Keep each Hawk task below ${MAX_PROMPT_CHARS} characters.`);
    }
    const workspace = this.requireWorkspace();
    const contexts = Array.isArray(record.contexts)
      ? record.contexts.filter((value): value is string => typeof value === 'string')
      : [];
    const context = await this.composeContext(workspace, contexts, prompt);
    this.post({ type: 'busy', text: 'Preparing an isolated Hawk worktree...' });

    let session: AiSessionSummary;
    const active = this.activeSessionId
      ? await this.client
          .aiSessions(workspace, 100)
          .then((result) =>
            result.sessions.find((candidate) => candidate.id === this.activeSessionId),
          )
      : undefined;
    if (active && (active.status === 'awaiting-review' || active.status === 'failed')) {
      session = await this.client.continueAiSession(workspace, active.id, prompt, context);
    } else {
      session = await this.client.createAiSession(workspace, prompt, context);
    }
    this.activeSessionId = session.id;
    this.lastEventId = 0;
    this.post({ type: 'session', session });
    await this.syncHistory();
    this.startPolling();
  }

  private async runParallelLanes(record: Record<string, unknown>): Promise<void> {
    if (typeof record.prompt !== 'string') return;
    const prompt = record.prompt.trim();
    if (!prompt) return;
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`Keep each Hawk task below ${MAX_PROMPT_CHARS} characters.`);
    }
    const approval = await vscode.window.showWarningMessage(
      'Launch three isolated Hawk agents through the Docker scheduler? Hawk will mount one writable review worktree per container, connect the configured AI provider, enforce CPU/RAM limits, and run detected test gates with bounded repair attempts.',
      { modal: true },
      'Launch 3 Docker lanes',
    );
    if (approval !== 'Launch 3 Docker lanes') return;
    const workspace = this.requireWorkspace();
    const contexts = Array.isArray(record.contexts)
      ? record.contexts.filter((value): value is string => typeof value === 'string')
      : [];
    const context = await this.composeContext(workspace, contexts, prompt);
    this.post({ type: 'busy', text: 'Scheduling three isolated Docker AI lanes...' });
    const batch = await this.client.createParallelAiBatch(workspace, prompt, context, 3);
    const first = batch.sessions[0];
    if (!first) throw new Error('Hawk did not create any parallel lanes.');
    this.activeSessionId = first.id;
    this.parallelBatchId = batch.batchId;
    this.parallelBatchCursors = {};
    this.parallelBatchSessionIds = batch.sessions.map((session) => session.id);
    this.post({
      type: 'parallel-batch',
      batchId: batch.batchId,
      sessionIds: this.parallelBatchSessionIds,
      scheduler: batch.scheduler,
    });
    this.lastEventId = 0;
    await this.syncHistory();
    await this.selectSession(first.id);
    vscode.window.showInformationMessage(
      `Three durable Hawk Docker lanes are running with the ${batch.scheduler.strategy} scheduler. When they finish, use Smart Synthesis to combine the strongest verified parts.`,
    );
  }

  private async runAutonomousVerifiedTask(record: Record<string, unknown>): Promise<void> {
    if (typeof record.prompt !== 'string') return;
    const prompt = record.prompt.trim();
    if (!prompt) return;
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`Keep each Hawk task below ${MAX_PROMPT_CHARS} characters.`);
    }
    const workspace = this.requireWorkspace();
    const maxRepairAttempts = vscode.workspace
      .getConfiguration('hawk', workspace)
      .get<number>('agent.autonomous.maxRepairAttempts', 2);
    const approval = await vscode.window.showWarningMessage(
      `Run this task autonomously inside an isolated worktree? Hawk may run detected project test gates and make up to ${maxRepairAttempts} bounded repair attempts. The final patch will never be applied automatically.`,
      { modal: true },
      'Run autonomous task',
    );
    if (approval !== 'Run autonomous task') return;
    const contexts = Array.isArray(record.contexts)
      ? record.contexts.filter((value): value is string => typeof value === 'string')
      : [];
    const context = await this.composeContext(workspace, contexts, prompt);
    this.post({
      type: 'busy',
      text: 'Launching an autonomous verified task in an isolated worktree...',
    });
    const session = await this.client.createAiSession(workspace, prompt, context, {
      background: true,
      autoResume: true,
      autoVerify: true,
      autoVerifyApproved: true,
      maxAutoFixAttempts: maxRepairAttempts,
    });
    this.activeSessionId = session.id;
    this.lastEventId = 0;
    this.post({ type: 'session', session });
    await this.syncHistory();
    this.startPolling();
  }

  private async smartMerge(): Promise<void> {
    const workspace = this.requireWorkspace();
    if (this.parallelBatchSessionIds.length < 2) {
      throw new Error('Launch a parallel Hawk batch before using Smart Synthesis.');
    }
    const sessions = await this.client.aiSessions(workspace, 100);
    const candidates = this.parallelBatchSessionIds
      .map((id) => sessions.sessions.find((session) => session.id === id))
      .filter((session): session is AiSessionSummary => Boolean(session));
    const ready = candidates.filter(
      (session) => session.status === 'awaiting-review' && Boolean(session.diff),
    );
    if (ready.length < 2) {
      throw new Error(
        `Smart Synthesis needs at least two completed lanes. ${ready.length}/${candidates.length} are ready.`,
      );
    }
    const approval = await vscode.window.showWarningMessage(
      `Create a new intelligent merge lane from ${ready.length} review-ready candidates? Hawk will compare tests and diffs, then synthesize one clean patch. Apply remains manual.`,
      { modal: true },
      'Synthesize best patch',
    );
    if (approval !== 'Synthesize best patch') return;
    this.post({ type: 'busy', text: 'Scoring candidates and launching intelligent synthesis…' });
    const result = await this.client.mergeAiBatch(
      workspace,
      ready.map((session) => session.id),
      ready[0]?.prompt.replace(/^\[[^\]]+ lane\]\s*/, '') ?? '',
    );
    this.activeSessionId = result.mergeSession.id;
    this.parallelBatchId = undefined;
    this.parallelBatchCursors = {};
    this.lastEventId = 0;
    this.post({ type: 'merge-score', candidates: result.candidates });
    this.post({ type: 'semantic-merge-plan', plan: result.semanticMerge });
    this.post({ type: 'session', session: result.mergeSession });
    await this.syncHistory();
    this.startPolling();
  }

  private async selectSession(sessionId: string): Promise<void> {
    const workspace = this.requireWorkspace();
    this.activeSessionId = sessionId;
    this.lastEventId = 0;
    const page = await this.client.aiEvents(workspace, sessionId, 0);
    this.lastEventId = page.next;
    this.post({ type: 'session-reset', session: page.session, events: page.events });
    if (isBusy(page.session.status)) this.startPolling();
    else this.stopPolling();
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setTimeout(() => void this.poll(), 20);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    const workspace = this.activeWorkspace;
    const sessionId = this.activeSessionId;
    if (!workspace || !sessionId || !this.panel) return;
    this.polling = true;
    try {
      let batchBusy = false;
      const page = await this.client.aiEvents(workspace, sessionId, this.lastEventId);
      this.lastEventId = page.next;
      for (const event of page.events) this.post({ type: 'event', event });
      this.post({ type: 'session', session: page.session });
      if (this.parallelBatchId) {
        const batchPage = await this.client.aiBatchEvents(
          workspace,
          this.parallelBatchId,
          this.parallelBatchCursors,
        );
        this.parallelBatchCursors = batchPage.next;
        batchBusy = ['preparing', 'running', 'paused'].includes(batchPage.batch.lifecycle);
        for (const event of batchPage.events) {
          if (event.sessionId !== sessionId) this.post({ type: 'parallel-lane-event', event });
        }
        this.post({ type: 'parallel-batch-status', batch: batchPage.batch });
        if (['completed', 'failed', 'cancelled'].includes(batchPage.batch.lifecycle)) {
          this.parallelBatchId = undefined;
        }
      }
      if (isBusy(page.session.status) || batchBusy) {
        this.pollTimer = setTimeout(() => void this.poll(), POLL_INTERVAL_MS);
      } else {
        this.pollTimer = undefined;
        await this.syncHistory();
        if (page.session.status === 'awaiting-review' && page.session.diff) {
          await this.loadDiffIntoPanel();
        }
      }
    } catch (err) {
      this.post({ type: 'error', text: errorMessage(err) });
      this.pollTimer = setTimeout(() => void this.poll(), 1_000);
    } finally {
      this.polling = false;
    }
  }

  private async showDiff(): Promise<void> {
    const diff = await this.loadDiffIntoPanel();
    const document = await vscode.workspace.openTextDocument({
      language: 'diff',
      content: diff.patch,
    });
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: false,
    });
  }

  private async loadDiffIntoPanel(): Promise<{
    patch: string;
    summary: { patchHash: string };
  }> {
    const workspace = this.requireWorkspace();
    const sessionId = this.requireSession();
    const diff = await this.client.aiDiff(workspace, sessionId);
    this.post({ type: 'diff', diff });
    return diff;
  }

  private async runTests(): Promise<void> {
    const workspace = this.requireWorkspace();
    const session = await this.currentSession();
    if (session.testGates.length === 0) {
      vscode.window.showInformationMessage(
        'No automatic test gates were detected for this workspace.',
      );
      return;
    }
    const commands = session.testGates
      .map((gate) => `${gate.command} ${gate.args.join(' ')}`.trim())
      .join('\n');
    const approval = await vscode.window.showWarningMessage(
      `Run these project commands inside the isolated worktree?\n\n${commands}`,
      { modal: true },
      'Run approved gates',
    );
    if (approval !== 'Run approved gates') return;
    this.post({ type: 'busy', text: 'Running approved test gates...' });
    await this.client.runAiTests(
      workspace,
      session.id,
      session.testGates.map((gate) => gate.id),
    );
    this.startPolling();
  }

  private async applyChanges(): Promise<void> {
    const workspace = this.requireWorkspace();
    const session = await this.currentSession();
    if (!session.diff) throw new Error('There is no Hawk diff to apply.');
    if (!session.canApply) {
      const quality = session.quality;
      throw new Error(
        `Apply blocked. Required gates: reproduction=${quality?.reproduction ?? 'pending'}, tests=${quality?.tests ?? 'pending'}, semantic review=${quality?.semanticReview ?? 'pending'}.`,
      );
    }
    const approval = await vscode.window.showWarningMessage(
      `Apply the reviewed Hawk patch to ${session.diff.files} file(s)?`,
      { modal: true },
      'Apply reviewed patch',
    );
    if (approval !== 'Apply reviewed patch') return;
    const updated = await this.client.applyAiSession(
      workspace,
      session.id,
      session.diff.patchHash,
      false,
    );
    this.post({ type: 'session', session: updated });
    await vscode.commands.executeCommand('git.refresh');
    await this.syncHistory();
  }

  private async runReproduction(): Promise<void> {
    const workspace = this.requireWorkspace();
    const session = await this.currentSession();
    if (!session.diff) throw new Error('A review-ready diff is required before reproduction.');
    const defaultCommand = session.testGates[0]
      ? `${session.testGates[0].command} ${session.testGates[0].args.join(' ')}`.trim()
      : 'node -e process.exit(0)';
    const text = await vscode.window.showInputBox({
      title: 'Hawk reproduction command',
      prompt: 'Direct argv command executed in the isolated worktree (no shell).',
      value: defaultCommand,
      ignoreFocusOut: true,
    });
    if (text === undefined) return;
    const command = text.trim().split(/\s+/).filter(Boolean);
    if (command.length === 0) return;
    const approval = await vscode.window.showWarningMessage(
      `Run approved reproduction in the isolated worktree?\n\n${command.join(' ')}`,
      { modal: true },
      'Run reproduction',
    );
    if (approval !== 'Run reproduction') return;
    this.post({ type: 'busy', text: 'Running governed reproduction...' });
    const updated = await this.client.reproduceAiSession(workspace, session.id, command);
    this.post({ type: 'session', session: updated });
  }

  private async runSemanticReview(): Promise<void> {
    const workspace = this.requireWorkspace();
    const session = await this.currentSession();
    if (!session.diff) throw new Error('A review-ready diff is required before semantic review.');
    const approval = await vscode.window.showWarningMessage(
      'Run Hawk AST/semantic review on the exact isolated diff?',
      { modal: true },
      'Run semantic review',
    );
    if (approval !== 'Run semantic review') return;
    this.post({ type: 'busy', text: 'Checking AST structure and semantic conflicts...' });
    const updated = await this.client.semanticReviewAiSession(workspace, session.id);
    this.post({ type: 'session', session: updated });
  }

  private async rejectChanges(): Promise<void> {
    const workspace = this.requireWorkspace();
    const session = await this.currentSession();
    const approval = await vscode.window.showWarningMessage(
      'Reject all changes from this isolated Hawk session?',
      { modal: true },
      'Reject changes',
    );
    if (approval !== 'Reject changes') return;
    const updated = await this.client.rejectAiSession(workspace, session.id);
    this.post({ type: 'session', session: updated });
    await this.syncHistory();
  }

  private async revertChanges(): Promise<void> {
    const workspace = this.requireWorkspace();
    const session = await this.currentSession();
    const approval = await vscode.window.showWarningMessage(
      'Revert the exact Hawk patch? Revert will stop if any touched file changed afterward.',
      { modal: true },
      'Revert Hawk patch',
    );
    if (approval !== 'Revert Hawk patch') return;
    const updated = await this.client.revertAiSession(workspace, session.id);
    this.post({ type: 'session', session: updated });
    await vscode.commands.executeCommand('git.refresh');
    await this.syncHistory();
  }

  private async cancelTask(): Promise<void> {
    const workspace = this.requireWorkspace();
    const sessionId = this.requireSession();
    const approval = await vscode.window.showWarningMessage(
      'Stop the running Hawk task?',
      { modal: true },
      'Stop task',
    );
    if (approval !== 'Stop task') return;
    const updated = await this.client.cancelAiSession(workspace, sessionId);
    this.post({ type: 'session', session: updated });
    this.stopPolling();
    await this.syncHistory();
  }

  private async pauseTask(): Promise<void> {
    const workspace = this.requireWorkspace();
    const sessionId = this.requireSession();
    const updated = await this.client.pauseAiSession(workspace, sessionId);
    this.post({ type: 'session', session: updated });
    this.stopPolling();
    await this.syncHistory();
  }

  private async resumeTask(): Promise<void> {
    const workspace = this.requireWorkspace();
    const sessionId = this.requireSession();
    const updated = await this.client.resumeAiSession(workspace, sessionId);
    this.post({ type: 'session', session: updated });
    this.startPolling();
    await this.syncHistory();
  }

  private newSession(): void {
    this.stopPolling();
    this.activeSessionId = undefined;
    this.parallelBatchId = undefined;
    this.parallelBatchCursors = {};
    this.parallelBatchSessionIds = [];
    this.lastEventId = 0;
    this.post({ type: 'session-clear' });
    void this.syncHistory();
  }

  private async createCheckpoint(): Promise<void> {
    const workspace = this.requireWorkspace();
    const session = await this.currentSession();
    if (!session.canCheckpoint) throw new Error('This Hawk task is not ready for a checkpoint.');
    const label = await vscode.window.showInputBox({
      title: 'Save Hawk Checkpoint',
      prompt: 'Name this isolated patch state.',
      value: `Checkpoint ${session.checkpoints.length + 1}`,
      ignoreFocusOut: true,
    });
    if (label === undefined) return;
    const updated = await this.client.checkpointAiSession(workspace, session.id, label.trim());
    this.post({ type: 'session', session: updated });
    await this.syncHistory();
  }

  private async restoreCheckpoint(): Promise<void> {
    const workspace = this.requireWorkspace();
    const session = await this.currentSession();
    if (session.checkpoints.length === 0) throw new Error('This task has no checkpoints.');
    const selected = await vscode.window.showQuickPick(
      [...session.checkpoints].reverse().map((checkpoint) => ({
        label: `$(history) ${checkpoint.label}`,
        description: `${checkpoint.files} file(s) · ${relativeTime(checkpoint.createdAt)}`,
        checkpoint,
      })),
      {
        title: 'Restore an isolated Hawk checkpoint',
        placeHolder: 'The current un-applied worktree state will be replaced.',
      },
    );
    if (!selected) return;
    const approval = await vscode.window.showWarningMessage(
      `Restore "${selected.checkpoint.label}" inside the isolated Hawk worktree?`,
      { modal: true },
      'Restore checkpoint',
    );
    if (approval !== 'Restore checkpoint') return;
    const updated = await this.client.restoreAiCheckpoint(
      workspace,
      session.id,
      selected.checkpoint.id,
    );
    this.post({ type: 'session', session: updated });
    await this.loadDiffIntoPanel();
    await this.syncHistory();
  }

  private async openTaskTerminal(): Promise<void> {
    const session = await this.currentSession();
    if (!session.canOpenTerminal || !session.sandboxPath) {
      throw new Error('A review-ready isolated worktree is required for the task terminal.');
    }
    const terminal = vscode.window.createTerminal({
      name: `Hawk · ${session.title.slice(0, 42)}`,
      cwd: session.sandboxPath,
      iconPath: new vscode.ThemeIcon('terminal'),
      message:
        'Hawk isolated task terminal. Commands stream here and cannot modify the operator workspace until Apply.',
    });
    terminal.show(false);
  }

  private async currentSession(): Promise<AiSessionSummary> {
    const workspace = this.requireWorkspace();
    const sessionId = this.requireSession();
    const sessions = await this.client.aiSessions(workspace, 100);
    const session = sessions.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error('Hawk AI session was not found.');
    return session;
  }

  private async syncHistory(): Promise<void> {
    const workspace = this.activeWorkspace;
    if (!workspace) return;
    const result = await this.client.aiSessions(workspace, 30);
    this.post({ type: 'history', items: result.sessions });
    if (!this.activeSessionId && result.sessions[0]) {
      this.activeSessionId = result.sessions[0].id;
    }
  }

  private async composeContext(
    workspace: vscode.Uri,
    contexts: string[],
    semanticQuery = '',
  ): Promise<string> {
    const pieces = [
      'Safety: work only in the authorized isolated workspace. Network access is disabled.',
    ];
    const editor = vscode.window.activeTextEditor;
    if (contexts.includes('activeFile') && editor) {
      pieces.push('', `Active file: ${vscode.workspace.asRelativePath(editor.document.uri)}`);
    }
    if (contexts.includes('selection') && editor && !editor.selection.isEmpty) {
      const selection = editor.document.getText(editor.selection).slice(0, MAX_SELECTION_CHARS);
      pieces.push(
        '',
        `Active selection from ${vscode.workspace.asRelativePath(editor.document.uri)}:`,
        '```',
        selection,
        '```',
      );
    }
    if (contexts.includes('openTabs')) {
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => tab.input)
        .filter((input): input is vscode.TabInputText => input instanceof vscode.TabInputText)
        .map((input) => vscode.workspace.asRelativePath(input.uri))
        .slice(0, 30);
      if (tabs.length) pieces.push('', 'Open editor tabs:', ...tabs.map((tab) => `- ${tab}`));
    }
    if (contexts.includes('diagnostics')) {
      const diagnostics = vscode.languages
        .getDiagnostics()
        .filter(
          ([uri]) => vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath === workspace.fsPath,
        )
        .flatMap(([uri, entries]) =>
          entries.slice(0, 8).map((diagnostic) => {
            const level = vscode.DiagnosticSeverity[diagnostic.severity];
            return `- ${vscode.workspace.asRelativePath(uri)}:${diagnostic.range.start.line + 1} [${level}] ${diagnostic.message}`;
          }),
        )
        .slice(0, 40);
      if (diagnostics.length) pieces.push('', 'Workspace diagnostics:', ...diagnostics);
    }
    if (contexts.includes('terminal')) {
      const terminal = this.terminalCapture.renderContext(workspace);
      if (terminal) pieces.push('', terminal);
    }
    if (contexts.includes('gitDiff')) {
      const diff = await readGitDiff(workspace.fsPath);
      if (diff) pieces.push('', 'Current git diff (read-only context):', '```diff', diff, '```');
    }
    if (contexts.includes('semantic') && semanticQuery.trim()) {
      const search = await this.client.semanticSearch(workspace, semanticQuery, 6);
      if (search.results.length) {
        pieces.push('', 'Semantically related workspace code:');
        for (const result of search.results) {
          pieces.push(
            '',
            `${result.file}:${result.startLine}-${result.endLine} [score ${result.score}]`,
            '```',
            result.preview.slice(0, 1_500),
            '```',
          );
        }
      }
    }
    return pieces.join('\n').slice(0, MAX_CONTEXT_CHARS);
  }

  private requireWorkspace(): vscode.Uri {
    if (!this.activeWorkspace || !vscode.workspace.isTrusted) {
      throw new Error('Open and trust a workspace before using Hawk AI.');
    }
    return this.activeWorkspace;
  }

  private requireSession(): string {
    if (!this.activeSessionId) throw new Error('Select or start a Hawk AI session first.');
    return this.activeSessionId;
  }

  private post(message: Record<string, unknown>): void {
    void this.panel?.webview.postMessage(message);
  }
}

function isBusy(status: AiSessionSummary['status']): boolean {
  return status === 'preparing' || status === 'running' || status === 'testing';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function relativeTime(value: string): string {
  const milliseconds = Date.now() - Date.parse(value);
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function readGitDiff(workspaceRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--no-ext-diff', '--unified=3', 'HEAD', '--', '.'],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
        maxBuffer: 512 * 1024,
        timeout: 5_000,
      },
    );
    return stdout.slice(0, 8_000);
  } catch {
    return '';
  }
}
