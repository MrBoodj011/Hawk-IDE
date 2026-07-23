import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { DaemonClient } from './daemonClient';
import type {
  MultiFileEditPredictionDocument,
  MultiFileEditPredictionResponse,
} from './types';

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_MULTI_FILE_DOCUMENT_CHARS = 80_000;
const MAX_MULTI_FILE_TOTAL_CHARS = 240_000;
const EDIT_HISTORY_LIMIT = 12;
const EDIT_PREDICTION_WINDOW_MS = 45_000;

interface TrackedEdit {
  file: string;
  before: string;
  after: string;
  line: number;
  at: number;
}

interface OfferedPrediction {
  id: string;
  workspace: vscode.Uri;
  documentKey: string;
  rejectionTimer?: NodeJS.Timeout;
}

/** Cursor-like coding ergonomics backed by Hawk's loopback-only local core. */
export class HawkCodingCore implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  private readonly documentSnapshots = new Map<string, string>();
  private readonly recentEdits: TrackedEdit[] = [];
  private rebuildTimer: NodeJS.Timeout | undefined;
  private completionSequence = 0;
  private offeredPrediction: OfferedPrediction | undefined;

  constructor(private readonly client: DaemonClient) {
    this.status.name = 'Hawk Tab';
    this.status.command = 'hawk.toggleTab';
    this.status.tooltip = 'Toggle Hawk multiline edit prediction and inline completion';
    this.status.show();
    this.refreshStatus();

    this.disposables.push(
      this.status,
      vscode.languages.registerInlineCompletionItemProvider(
        { scheme: 'file' },
        {
          provideInlineCompletionItems: async (document, position, _context, token) =>
            await this.complete(document, position, token),
        },
      ),
      vscode.commands.registerCommand('hawk.toggleTab', async () => {
        const configuration = vscode.workspace.getConfiguration('hawk');
        const enabled = configuration.get<boolean>('tab.enabled', true);
        await configuration.update('tab.enabled', !enabled, vscode.ConfigurationTarget.Global);
        this.refreshStatus();
        vscode.window.showInformationMessage(`Hawk Tab ${enabled ? 'disabled' : 'enabled'}.`);
      }),
      vscode.commands.registerCommand('hawk.triggerTab', async () => {
        await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      }),
      vscode.commands.registerCommand('hawk.rebuildSemanticIndex', async () => {
        const workspace = requireWorkspace();
        this.status.text = '$(sync~spin) Hawk Index';
        const stats = await this.client.rebuildSemanticIndex(workspace);
        this.refreshStatus();
        const vector =
          stats.embedding.status === 'ready'
            ? ` Hybrid embeddings: ${stats.embedding.chunks} chunks.`
            : '';
        vscode.window.showInformationMessage(
          `Hawk indexed ${stats.files} files, ${stats.symbols} symbols, ${stats.types} types and ${stats.chunks} chunks in ${stats.durationMs}ms.${vector}`,
        );
      }),
      vscode.commands.registerCommand('hawk.searchWorkspace', async () => {
        const workspace = requireWorkspace();
        const query = await vscode.window.showInputBox({
          title: 'Hawk Deep Workspace Search',
          prompt: 'Describe the symbol, type, call path, behavior, or security boundary you need.',
          placeHolder: 'Where is access-token validation implemented?',
          ignoreFocusOut: true,
        });
        if (!query?.trim()) return;
        const response = await this.client.semanticSearch(workspace, query, 16);
        const selected = await vscode.window.showQuickPick(
          response.results.map((result) => ({
            label: `$(symbol-method) ${result.file}:${result.startLine}`,
            description: [...result.symbols.slice(0, 3), ...result.types.slice(0, 2)].join(' · '),
            detail: `${result.match === 'hybrid' ? 'Hybrid' : 'AST'} · ${firstMeaningfulLine(result.preview)}`,
            result,
          })),
          {
            title: `Hawk found ${response.results.length} relevant code regions`,
            matchOnDescription: true,
            matchOnDetail: true,
          },
        );
        if (!selected) return;
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.joinPath(workspace, ...selected.result.file.split('/')),
        );
        const editor = await vscode.window.showTextDocument(document, {
          preview: true,
          preserveFocus: false,
        });
        const line = Math.max(0, selected.result.startLine - 1);
        editor.selection = new vscode.Selection(line, 0, line, 0);
        editor.revealRange(
          new vscode.Range(line, 0, Math.max(line, selected.result.endLine - 1), 0),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      }),
      vscode.commands.registerCommand('hawk.runCodingBenchmark', async () => {
        const workspace = requireWorkspace();
        this.status.text = '$(pulse) Hawk Benchmark';
        const benchmark = await this.client.codingCoreBenchmark(workspace);
        this.refreshStatus();
        const document = await vscode.workspace.openTextDocument({
          language: 'markdown',
          content: renderBenchmark(benchmark),
        });
        await vscode.window.showTextDocument(document, {
          preview: true,
          preserveFocus: false,
          viewColumn: vscode.ViewColumn.Beside,
        });
      }),
      vscode.commands.registerCommand('hawk.showEditPredictionEvaluation', async () => {
        const workspace = requireWorkspace();
        const evaluation = await this.client.editPredictionEvaluation(workspace);
        const document = await vscode.workspace.openTextDocument({
          language: 'markdown',
          content: renderEditPredictionEvaluation(evaluation),
        });
        await vscode.window.showTextDocument(document, {
          preview: true,
          preserveFocus: false,
          viewColumn: vscode.ViewColumn.Beside,
        });
      }),
      vscode.commands.registerCommand('hawk.clearEditPredictionCache', async () => {
        const workspace = requireWorkspace();
        await this.client.clearEditPredictionCache(workspace);
        vscode.window.showInformationMessage('Hawk Next Edit cache cleared.');
      }),
      vscode.commands.registerCommand('hawk.predictMultiFileEdit', async () => {
        await this.predictMultiFileEdit();
      }),
      vscode.commands.registerCommand(
        'hawk.editPrediction.accepted',
        async (predictionId: string) => {
          await this.acceptPrediction(predictionId);
          await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        },
      ),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.uri.scheme === 'file') {
          this.documentSnapshots.set(document.uri.toString(), document.getText());
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.documentSnapshots.delete(document.uri.toString());
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.captureEdits(event);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === 'file') void this.updateIndexedFile(document.uri);
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        for (const file of event.files) void this.updateIndexedFile(file, true);
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const file of event.files) {
          void this.updateIndexedFile(file.oldUri, true);
          void this.updateIndexedFile(file.newUri);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('hawk.tab.enabled')) this.refreshStatus();
      }),
    );
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === 'file') {
        this.documentSnapshots.set(document.uri.toString(), document.getText());
      }
    }
  }

  warmWorkspace(): void {
    this.scheduleRebuild(1_800);
  }

  dispose(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    if (this.offeredPrediction?.rejectionTimer) {
      clearTimeout(this.offeredPrediction.rejectionTimer);
    }
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | undefined> {
    if (
      !vscode.workspace.isTrusted ||
      !vscode.workspace.getConfiguration('hawk').get<boolean>('tab.enabled', true) ||
      document.uri.scheme !== 'file' ||
      document.getText().length > MAX_DOCUMENT_BYTES
    ) {
      return undefined;
    }
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
    if (!workspace) return undefined;
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const hasRecentEdit = this.recentEdits.some(
      (edit) => Date.now() - edit.at <= EDIT_PREDICTION_WINDOW_MS,
    );
    if ((!linePrefix.trim() && !hasRecentEdit) || /(?:\/\/|#)\s*$/.test(linePrefix)) {
      return undefined;
    }

    const configuration = vscode.workspace.getConfiguration('hawk');
    const debounceMs = clamp(configuration.get<number>('tab.debounceMs', 180), 80, 2_000);
    const sequence = ++this.completionSequence;
    if (!(await cancellableDelay(debounceMs, token))) return undefined;
    if (sequence !== this.completionSequence || token.isCancellationRequested) return undefined;

    const body = document.getText();
    const offset = document.offsetAt(position);
    const prefixChars = clamp(
      configuration.get<number>('tab.maxPrefixChars', 12_000),
      2_000,
      40_000,
    );
    const suffixChars = clamp(configuration.get<number>('tab.maxSuffixChars', 4_000), 500, 12_000);
    const requestBase = {
      file: vscode.workspace.asRelativePath(document.uri),
      languageId: document.languageId,
      prefix: body.slice(Math.max(0, offset - prefixChars), offset),
      suffix: body.slice(offset, offset + suffixChars),
    };
    this.status.text = '$(sparkle) Hawk Tab…';
    try {
      const recentEdits = this.recentEdits
        .filter((edit) => Date.now() - edit.at <= EDIT_PREDICTION_WINDOW_MS)
        .slice(-6)
        .map(({ at: _at, ...edit }) => edit);
      if (
        recentEdits.length > 0 &&
        configuration.get<boolean>('tab.editPrediction.enabled', true)
      ) {
        const diagnostics = vscode.languages
          .getDiagnostics(document.uri)
          .filter((diagnostic) => diagnostic.severity <= vscode.DiagnosticSeverity.Warning)
          .slice(0, 16)
          .map(
            (diagnostic) =>
              `${vscode.DiagnosticSeverity[diagnostic.severity]} line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`,
          );
        const prediction = await this.client.editPrediction(workspace, {
          ...requestBase,
          recentEdits,
          diagnostics,
          minConfidence: clamp(
            configuration.get<number>('tab.editPrediction.minConfidence', 0.55),
            0.3,
            0.95,
          ),
        });
        if (
          sequence === this.completionSequence &&
          !token.isCancellationRequested &&
          prediction.text &&
          body.slice(offset, offset + prediction.replaceText.length) === prediction.replaceText
        ) {
          const end = document.positionAt(offset + prediction.replaceText.length);
          this.rememberPrediction(prediction.predictionId, workspace, document.uri);
          const speed =
            prediction.cached || prediction.cacheKind === 'in-flight'
              ? prediction.cacheKind
              : `${Math.max(0.1, prediction.latencyMs / 1_000).toFixed(1)}s`;
          this.status.text = `$(wand) Hawk Next Edit ${Math.round(prediction.confidence * 100)}% · ${speed}`;
          return new vscode.InlineCompletionList([
            new vscode.InlineCompletionItem(
              prediction.text,
              new vscode.Range(position, end),
              {
                title: 'Accept Hawk multiline edit',
                command: 'hawk.editPrediction.accepted',
                arguments: [prediction.predictionId],
              },
            ),
          ]);
        }
      }

      const result = await this.client.inlineCompletion(workspace, requestBase);
      if (sequence !== this.completionSequence || token.isCancellationRequested || !result.text) {
        return undefined;
      }
      this.status.text = `$(sparkle) Hawk Tab ${Math.max(0.1, result.latencyMs / 1_000).toFixed(1)}s`;
      return new vscode.InlineCompletionList([
        new vscode.InlineCompletionItem(result.text, new vscode.Range(position, position)),
      ]);
    } catch {
      this.status.text = '$(circle-slash) Hawk Tab offline';
      return undefined;
    }
  }

  private captureEdits(event: vscode.TextDocumentChangeEvent): void {
    if (event.document.uri.scheme !== 'file' || event.contentChanges.length === 0) return;
    const key = event.document.uri.toString();
    let previous = this.documentSnapshots.get(key) ?? event.document.getText();
    const file = vscode.workspace.asRelativePath(event.document.uri);
    for (const change of [...event.contentChanges].sort(
      (left, right) => right.rangeOffset - left.rangeOffset,
    )) {
      const oldText = previous.slice(
        change.rangeOffset,
        change.rangeOffset + Math.max(0, change.rangeLength),
      );
      const windowStart = Math.max(0, change.rangeOffset - 600);
      const windowEnd = Math.min(previous.length, change.rangeOffset + change.rangeLength + 600);
      const before = previous.slice(windowStart, windowEnd);
      const after = `${previous.slice(windowStart, change.rangeOffset)}${change.text}${previous.slice(
        change.rangeOffset + change.rangeLength,
        windowEnd,
      )}`;
      if (oldText !== change.text) {
        this.recentEdits.push({
          file,
          before,
          after,
          line: change.range.start.line + 1,
          at: Date.now(),
        });
      }
      previous = `${previous.slice(0, change.rangeOffset)}${change.text}${previous.slice(
        change.rangeOffset + change.rangeLength,
      )}`;
    }
    if (this.recentEdits.length > EDIT_HISTORY_LIMIT) {
      this.recentEdits.splice(0, this.recentEdits.length - EDIT_HISTORY_LIMIT);
    }
    this.documentSnapshots.set(key, event.document.getText());
    this.schedulePredictionRejection(event.document.uri);
  }

  private async predictMultiFileEdit(): Promise<void> {
    const workspace = requireWorkspace();
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      throw new Error('Open a source file before requesting a multi-file Next Edit.');
    }
    const recentEdits = this.recentEdits
      .filter((edit) => Date.now() - edit.at <= EDIT_PREDICTION_WINDOW_MS)
      .slice(-8)
      .map(({ at: _at, ...edit }) => edit);
    if (recentEdits.length === 0) {
      vscode.window.showInformationMessage(
        'Make or accept one edit first so Hawk can infer the coordinated multi-file change.',
      );
      return;
    }

    const configuration = vscode.workspace.getConfiguration('hawk');
    const maxFiles = clamp(
      configuration.get<number>('tab.editPrediction.multiFile.maxFiles', 6),
      2,
      8,
    );
    const uris = await this.multiFileCandidateUris(
      workspace,
      editor.document.uri,
      recentEdits,
      maxFiles,
    );
    const documents: MultiFileEditPredictionDocument[] = [];
    let totalChars = 0;
    for (const uri of uris) {
      if (documents.length >= maxFiles) break;
      let document: vscode.TextDocument | undefined;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        document = undefined;
      }
      if (!document || document.uri.scheme !== 'file') continue;
      const content = document.getText();
      if (
        !content ||
        content.length > MAX_MULTI_FILE_DOCUMENT_CHARS ||
        totalChars + content.length > MAX_MULTI_FILE_TOTAL_CHARS
      ) {
        continue;
      }
      totalChars += content.length;
      documents.push({
        file: vscode.workspace.asRelativePath(document.uri).replaceAll('\\', '/'),
        languageId: document.languageId,
        content,
      });
    }
    if (documents.length < 2) {
      vscode.window.showWarningMessage(
        'Hawk needs at least two related files under 80 KB each for a coordinated prediction.',
      );
      return;
    }

    const candidateFiles = new Set(documents.map((document) => document.file));
    const diagnostics = vscode.languages
      .getDiagnostics()
      .flatMap(([uri, entries]) => {
        const file = vscode.workspace.asRelativePath(uri).replaceAll('\\', '/');
        if (!candidateFiles.has(file)) return [];
        return entries
          .filter((entry) => entry.severity <= vscode.DiagnosticSeverity.Warning)
          .slice(0, 8)
          .map(
            (entry) =>
              `${file}:${entry.range.start.line + 1} [${vscode.DiagnosticSeverity[entry.severity]}] ${entry.message}`,
          );
      })
      .slice(0, 40);
    this.status.text = '$(sync~spin) Hawk Multi-File';
    try {
      const prediction = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Hawk is predicting a coordinated edit across ${documents.length} files`,
          cancellable: false,
        },
        async () =>
          await this.client.multiFileEditPrediction(workspace, {
            activeFile: vscode.workspace.asRelativePath(editor.document.uri).replaceAll('\\', '/'),
            documents,
            recentEdits,
            diagnostics,
            minConfidence: clamp(
              configuration.get<number>('tab.editPrediction.minConfidence', 0.55),
              0.3,
              0.95,
            ),
          }),
      );
      if (prediction.edits.length < 2) {
        vscode.window.showInformationMessage(
          'Hawk did not find a high-confidence coordinated multi-file edit.',
        );
        return;
      }
      const preview = await vscode.workspace.openTextDocument({
        language: 'diff',
        content: renderMultiFilePrediction(prediction, documents),
      });
      await vscode.window.showTextDocument(preview, {
        preview: true,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
      const action = await vscode.window.showInformationMessage(
        `Hawk predicted ${prediction.edits.length} coordinated file edits at ${Math.round(
          prediction.confidence * 100,
        )}% confidence. Review the diff before applying.`,
        'Apply all',
        'Reject',
      );
      if (action !== 'Apply all') {
        await this.client
          .editPredictionFeedback(workspace, prediction.predictionId, 'rejected')
          .catch(() => undefined);
        return;
      }
      try {
        await this.applyMultiFilePrediction(workspace, prediction);
      } catch (error) {
        await this.client
          .editPredictionFeedback(workspace, prediction.predictionId, 'rejected')
          .catch(() => undefined);
        vscode.window.showErrorMessage(
          error instanceof Error ? error.message : 'Hawk could not apply the multi-file edit.',
        );
        return;
      }
      await this.client
        .editPredictionFeedback(workspace, prediction.predictionId, 'accepted')
        .catch(() => undefined);
      vscode.window.showInformationMessage(
        `Applied one atomic Hawk edit across ${prediction.edits.length} files. Use Undo to revert it.`,
      );
    } finally {
      this.refreshStatus();
    }
  }

  private async multiFileCandidateUris(
    workspace: vscode.Uri,
    active: vscode.Uri,
    recentEdits: Array<{ file: string; before: string; after: string; line: number }>,
    maxFiles: number,
  ): Promise<vscode.Uri[]> {
    const output: vscode.Uri[] = [];
    const seen = new Set<string>();
    const add = (uri: vscode.Uri | undefined) => {
      if (!uri || uri.scheme !== 'file') return;
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder || folder.uri.fsPath !== workspace.fsPath) return;
      const key = uri.toString();
      if (seen.has(key)) return;
      seen.add(key);
      output.push(uri);
    };
    const fromRelative = (file: string): vscode.Uri | undefined => {
      const normalized = safeRelativeFile(file);
      return normalized ? vscode.Uri.joinPath(workspace, ...normalized.split('/')) : undefined;
    };
    add(active);
    for (const edit of [...recentEdits].reverse()) add(fromRelative(edit.file));
    const semanticQuery = recentEdits
      .slice(-4)
      .map((edit) => `${edit.file}\n${edit.after}`)
      .join('\n')
      .slice(-6_000);
    const related = await this.client.semanticSearch(workspace, semanticQuery, maxFiles * 2);
    for (const result of related.results) add(fromRelative(result.file));
    for (const document of vscode.workspace.textDocuments) add(document.uri);
    for (const [uri, entries] of vscode.languages.getDiagnostics()) {
      if (entries.some((entry) => entry.severity <= vscode.DiagnosticSeverity.Warning)) add(uri);
    }
    return output.slice(0, Math.max(maxFiles * 2, maxFiles));
  }

  private async applyMultiFilePrediction(
    workspace: vscode.Uri,
    prediction: MultiFileEditPredictionResponse,
  ): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const touched: vscode.TextDocument[] = [];
    for (const proposed of prediction.edits) {
      const relative = safeRelativeFile(proposed.file);
      if (!relative) throw new Error(`Hawk rejected an unsafe predicted path: ${proposed.file}`);
      const uri = vscode.Uri.joinPath(workspace, ...relative.split('/'));
      const document = await vscode.workspace.openTextDocument(uri);
      const current = document.getText();
      if (sha256(current) !== proposed.baseSha256) {
        throw new Error(
          `${proposed.file} changed after prediction. Hawk did not apply any multi-file edits.`,
        );
      }
      const offset = current.indexOf(proposed.oldText);
      if (offset < 0 || current.indexOf(proposed.oldText, offset + 1) >= 0) {
        throw new Error(
          `${proposed.file} no longer has one unique exact replacement target. Nothing was applied.`,
        );
      }
      edit.replace(
        uri,
        new vscode.Range(
          document.positionAt(offset),
          document.positionAt(offset + proposed.oldText.length),
        ),
        proposed.newText,
      );
      touched.push(document);
    }
    const applied = await vscode.workspace.applyEdit(edit, {
      isRefactoring: true,
    });
    if (!applied) throw new Error('VS Code rejected the atomic multi-file WorkspaceEdit.');
    for (const document of touched) {
      this.documentSnapshots.set(document.uri.toString(), document.getText());
    }
  }

  private async updateIndexedFile(uri: vscode.Uri, deleted = false): Promise<void> {
    if (!vscode.workspace.isTrusted || uri.scheme !== 'file') return;
    const workspace = vscode.workspace.getWorkspaceFolder(uri)?.uri;
    if (!workspace) return;
    try {
      await this.client.updateSemanticFile(
        workspace,
        vscode.workspace.asRelativePath(uri),
        deleted,
      );
    } catch {
      this.scheduleRebuild();
    }
  }

  private scheduleRebuild(delayMs = 2_500): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!workspace || !vscode.workspace.isTrusted) return;
      this.status.text = '$(sync~spin) Hawk Index';
      void this.client
        .rebuildSemanticIndex(workspace)
        .then(() => this.refreshStatus())
        .catch(() => {
          this.status.text = '$(circle-slash) Hawk Index offline';
        });
    }, delayMs);
  }

  private refreshStatus(): void {
    const enabled = vscode.workspace.getConfiguration('hawk').get<boolean>('tab.enabled', true);
    this.status.text = enabled ? '$(sparkle) Hawk Tab' : '$(circle-slash) Hawk Tab';
  }

  private rememberPrediction(
    predictionId: string,
    workspace: vscode.Uri,
    document: vscode.Uri,
  ): void {
    if (this.offeredPrediction?.rejectionTimer) {
      clearTimeout(this.offeredPrediction.rejectionTimer);
    }
    this.offeredPrediction = {
      id: predictionId,
      workspace,
      documentKey: document.toString(),
    };
  }

  private schedulePredictionRejection(document: vscode.Uri): void {
    const offered = this.offeredPrediction;
    if (!offered || offered.documentKey !== document.toString() || offered.rejectionTimer) return;
    offered.rejectionTimer = setTimeout(() => {
      if (this.offeredPrediction?.id !== offered.id) return;
      this.offeredPrediction = undefined;
      void this.client
        .editPredictionFeedback(offered.workspace, offered.id, 'rejected')
        .catch(() => undefined);
    }, 400);
  }

  private async acceptPrediction(predictionId: string): Promise<void> {
    const offered = this.offeredPrediction;
    if (!offered || offered.id !== predictionId) return;
    if (offered.rejectionTimer) clearTimeout(offered.rejectionTimer);
    this.offeredPrediction = undefined;
    await this.client
      .editPredictionFeedback(offered.workspace, offered.id, 'accepted')
      .catch(() => undefined);
  }
}

function renderBenchmark(
  benchmark: Awaited<ReturnType<DaemonClient['codingCoreBenchmark']>>,
): string {
  const gate = (passed: boolean): string => (passed ? 'PASS' : 'NEEDS ATTENTION');
  return [
    '# Hawk Coding Core Benchmark',
    '',
    `Measured: ${benchmark.measuredAt}`,
    '',
    '## Persistent AST/type index',
    '',
    `- Files: ${benchmark.semanticIndex.files}`,
    `- Symbols: ${benchmark.semanticIndex.symbols}`,
    `- Types: ${benchmark.semanticIndex.types}`,
    `- Calls: ${benchmark.semanticIndex.calls}`,
    `- Chunks: ${benchmark.semanticIndex.chunks}`,
    `- Reused files: ${benchmark.semanticIndex.reusedFiles}`,
    `- Changed files: ${benchmark.semanticIndex.changedFiles}`,
    `- Embeddings: ${benchmark.semanticIndex.embedding.status} (${benchmark.semanticIndex.embedding.chunks} chunks)`,
    `- Source bytes: ${formatBytes(benchmark.semanticIndex.bytes)}`,
    `- Estimated resident index: ${formatBytes(benchmark.semanticIndex.memory.residentBytes)} / ${formatBytes(benchmark.semanticIndex.memory.budgetBytes)}`,
    `- Build latency: ${benchmark.semanticIndex.durationMs}ms`,
    '',
    '## Search latency',
    '',
    `- Samples: ${benchmark.search.samples}`,
    `- p50: ${benchmark.search.p50Ms}ms`,
    `- p95: ${benchmark.search.p95Ms}ms`,
    `- Max: ${benchmark.search.maxMs}ms`,
    '',
    '## Hawk Tab / Next Edit latency',
    '',
    benchmark.completion.samples
      ? `- ${benchmark.completion.samples} samples · p50 ${benchmark.completion.p50Ms}ms · p95 ${benchmark.completion.p95Ms}ms`
      : '- No prediction samples yet. Use Hawk Tab, then run the benchmark again.',
    '',
    '## Performance gates',
    '',
    `- Index under 5s: **${gate(benchmark.gates.indexUnderFiveSeconds)}**`,
    `- Search p95 under 50ms: **${gate(benchmark.gates.searchP95UnderFiftyMs)}**`,
    `- Peak daemon RSS under 500 MiB: **${gate(benchmark.gates.rssUnder500Mb)}** (${formatBytes(benchmark.process.peakRssBytes)} peak, ${formatBytes(benchmark.process.rssDeltaBytes)} index delta)`,
    '',
  ].join('\n');
}

function renderEditPredictionEvaluation(
  report: Awaited<ReturnType<DaemonClient['editPredictionEvaluation']>>,
): string {
  const percentage = (value: number | undefined): string =>
    value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
  const cacheHits =
    report.cache.exactHits + report.cache.continuationHits + report.cache.inFlightJoins;
  return [
    '# Hawk Next Edit Evaluation',
    '',
    `Measured: ${report.measuredAt}`,
    '',
    '## Speed cache',
    '',
    `- Status: ${report.cache.enabled ? 'enabled' : 'disabled'}`,
    `- Requests: ${report.cache.requests}`,
    `- Reused or deduplicated: ${cacheHits} (${percentage(report.cache.hitRate)})`,
    `- Exact hits: ${report.cache.exactHits}`,
    `- Continuation hits: ${report.cache.continuationHits}`,
    `- Concurrent requests joined: ${report.cache.inFlightJoins}`,
    `- Entries: ${report.cache.entries}/${report.cache.maxEntries}`,
    `- TTL: ${Math.round(report.cache.ttlMs / 1_000)}s`,
    '',
    '## Recommended model',
    '',
    report.recommended
      ? `- **${report.recommended.provider} / ${report.recommended.model}** · score ${report.recommended.score}/100 · ${report.recommended.confidence} evidence confidence`
      : '- Use Hawk Next Edit to begin collecting local evaluation evidence.',
    '',
    '## Model scorecard',
    '',
    ...(report.models.length
      ? report.models.flatMap((model) => [
          `### ${model.provider} / ${model.model}`,
          '',
          `- Score: ${model.score}/100 (${model.confidence} evidence confidence)`,
          `- Valid structured edits: ${percentage(model.validRate)} (${model.validSuggestions}/${model.generations})`,
          `- Operator acceptance: ${percentage(model.acceptanceRate)} (${model.accepted} accepted / ${model.rejected} rejected)`,
          `- Feedback coverage: ${percentage(model.feedbackCoverage)}`,
          `- Generation latency: p50 ${formatMilliseconds(model.p50GenerationMs)} · p95 ${formatMilliseconds(model.p95GenerationMs)}`,
          `- Served from cache: ${model.cacheServed}; concurrent joins: ${model.inFlightServed}`,
          '',
        ])
      : ['- No model samples yet.', '']),
    '## Privacy',
    '',
    `- ${report.privacy}`,
    '',
    '> Acceptance rate is an operator-feedback proxy, not a synthetic benchmark claim. Confidence becomes medium after 10 feedback samples and high after 50.',
    '',
  ].join('\n');
}

function renderMultiFilePrediction(
  prediction: MultiFileEditPredictionResponse,
  documents: MultiFileEditPredictionDocument[],
): string {
  const byFile = new Map(documents.map((document) => [document.file, document.content]));
  return [
    `# Hawk Multi-File Next Edit - ${Math.round(prediction.confidence * 100)}% confidence`,
    `# ${prediction.summary || 'Coordinated workspace edit'}`,
    `# Provider: ${prediction.provider ?? 'configured'} / ${prediction.model ?? 'configured'}`,
    `# Cache: ${prediction.cacheKind}`,
    '',
    ...prediction.edits.flatMap((edit) => {
      const content = byFile.get(edit.file) ?? '';
      const offset = content.indexOf(edit.oldText);
      const line = offset < 0 ? 1 : content.slice(0, offset).split(/\r?\n/).length;
      const oldLines = Math.max(1, edit.oldText.split(/\r?\n/).length);
      const newLines = Math.max(1, edit.newText.split(/\r?\n/).length);
      return [
        `--- a/${edit.file}`,
        `+++ b/${edit.file}`,
        `@@ -${line},${oldLines} +${line},${newLines} @@`,
        ...diffLines(edit.oldText, '-'),
        ...diffLines(edit.newText, '+'),
        '',
      ];
    }),
  ].join('\n');
}

function diffLines(value: string, marker: '-' | '+'): string[] {
  return value.split(/\r?\n/).map((line) => `${marker}${line}`);
}

function safeRelativeFile(value: string): string {
  const file = String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
  if (
    !file ||
    file.startsWith('/') ||
    /^[a-z]:\//i.test(file) ||
    file.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    return '';
  }
  return file;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireWorkspace(): vscode.Uri {
  if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before using Hawk.');
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspace) throw new Error('Open a workspace before using Hawk.');
  return workspace;
}

function firstMeaningfulLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 180) ?? 'Code context'
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatMilliseconds(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${Math.round(value)}ms`;
}

async function cancellableDelay(
  milliseconds: number,
  token: vscode.CancellationToken,
): Promise<boolean> {
  if (token.isCancellationRequested) return false;
  return await new Promise<boolean>((resolveDelay) => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      resolveDelay(true);
    }, milliseconds);
    const disposable = token.onCancellationRequested(() => {
      clearTimeout(timeout);
      disposable.dispose();
      resolveDelay(false);
    });
  });
}
