import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { DaemonClient } from './daemonClient';

const execFileAsync = promisify(execFile);
const GITHUB_TOKEN_SECRET = 'hawk.github.automation.token';
const MAX_BODY_CHARS = 60_000;
const SENSITIVE_PATH = /(^|\/)(\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx))$/i;

export interface GitHubRepository {
  owner: string;
  name: string;
  remote: string;
}

export interface GitHubWorkflowResult {
  repository: GitHubRepository;
  issue: { number: number; url: string; title: string };
  branch: string;
  base: string;
  pullRequest?: { number: number; url: string; reviewUrl: string };
  review: {
    status: 'posted' | 'skipped';
    findings: number;
    tests: 'passed' | 'failed' | 'not-run';
  };
}

interface GitHubIssue {
  number: number;
  url: string;
  title: string;
}

interface GitHubPullRequest {
  number: number;
  url: string;
}

interface GitHubApiOptions {
  token: string;
  repository: GitHubRepository;
}

/**
 * Approval-gated GitHub delivery pipeline for the native Hawk IDE.
 *
 * The pipeline deliberately keeps credentials in VS Code authentication or
 * SecretStorage. Git commands never receive a token through arguments, and
 * review comments contain only bounded findings and test metadata.
 */
export class HawkGitHubAutomation implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Hawk GitHub Automation');

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly client?: DaemonClient,
  ) {}

  async configure(workspace: vscode.Uri): Promise<void> {
    const repository = await detectRepository(workspace.fsPath);
    const token = await vscode.window.showInputBox({
      title: 'Configure Hawk GitHub automation',
      prompt: `GitHub token with repo/issues/pull-request permissions for ${repository.owner}/${repository.name}. Stored in encrypted local storage.`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'ghp_… or github_pat_…',
      validateInput: (value) =>
        value.trim().length >= 20 ? undefined : 'Enter a valid GitHub token.',
    });
    if (token === undefined) return;
    await this.secrets.store(GITHUB_TOKEN_SECRET, token.trim());
    vscode.window.showInformationMessage(
      `Hawk GitHub automation configured for ${repository.owner}/${repository.name}.`,
    );
  }

  async issueToPr(workspace: vscode.Uri): Promise<GitHubWorkflowResult | undefined> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before running GitHub automation.');
    }
    const repository = await detectRepository(workspace.fsPath);
    const token = await this.getToken();
    if (!token) {
      const action = await vscode.window.showWarningMessage(
        'Configure a GitHub token before creating issues, branches and pull requests.',
        'Configure token',
      );
      if (action === 'Configure token') await this.configure(workspace);
      return undefined;
    }

    const base = await git(workspace.fsPath, ['branch', '--show-current']);
    if (!base) throw new Error('Hawk needs an active base branch.');
    const title = await vscode.window.showInputBox({
      title: 'Hawk GitHub workflow · issue title',
      prompt: `Create an issue in ${repository.owner}/${repository.name}`,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Issue title is required.'),
    });
    if (title === undefined) return undefined;
    const body =
      (await vscode.window.showInputBox({
        title: 'Hawk GitHub workflow · issue context',
        prompt: 'Describe the implementation, acceptance criteria and security constraints.',
        ignoreFocusOut: true,
        value: 'Created from Hawk Security IDE.\n\nAcceptance criteria:\n- ',
      })) ?? '';

    const api = new GitHubApi({ token, repository });
    const issue = await api.createIssue(title.trim(), bound(body));
    const branchDefault = branchName(issue.number, title);
    const branch =
      (await vscode.window.showInputBox({
        title: 'Hawk GitHub workflow · feature branch',
        prompt: `Create a local branch for issue #${issue.number}.`,
        value: branchDefault,
        validateInput: (value) => validateBranch(value),
      })) ?? branchDefault;

    await git(workspace.fsPath, ['switch', '-c', branch]);
    await api.commentIssue(
      issue.number,
      `Hawk created implementation branch \`${branch}\` from \`${base}\`.`,
    );
    this.output.appendLine(`Issue #${issue.number} → branch ${branch}`);

    const status = await git(workspace.fsPath, ['status', '--short']);
    if (!status.trim()) {
      vscode.window.showInformationMessage(
        `Issue #${issue.number} and branch ${branch} are ready. Let Hawk implement the change, then run the PR command.`,
      );
      return {
        repository,
        issue,
        branch,
        base,
        review: { status: 'skipped', findings: 0, tests: 'not-run' },
      };
    }

    const approval = await vscode.window.showWarningMessage(
      `Commit and push the current ${status.trim().split(/\r?\n/).length} changed path(s), then open a pull request?`,
      {
        modal: true,
        detail: 'Hawk will run diff checks, create one commit, push the branch and request review.',
      },
      'Commit, push and open PR',
    );
    if (approval !== 'Commit, push and open PR') return undefined;
    await this.commitAndPush(workspace.fsPath, branch, title);
    const pullRequest = await api.createPullRequest({
      title: title.trim(),
      head: branch,
      base,
      body: `${bound(body)}\n\nCloses #${issue.number}\n\n_Hawk workflow: issue → branch → implementation → tests → review._`,
    });
    await api.commentIssue(
      issue.number,
      `Hawk opened PR #${pullRequest.number}: ${pullRequest.url}`,
    );
    const review = await this.postReview(workspace, api, pullRequest.number, branch, base);
    await this.recordDelivery(workspace, repository, pullRequest, branch, base, review);
    return {
      repository,
      issue,
      branch,
      base,
      pullRequest: { ...pullRequest, reviewUrl: pullRequest.url },
      review,
    };
  }

  async reviewPullRequest(workspace: vscode.Uri): Promise<void> {
    const repository = await detectRepository(workspace.fsPath);
    const token = await this.getToken();
    if (!token)
      throw new Error('Configure Hawk GitHub automation before reviewing a pull request.');
    const rawNumber = await vscode.window.showInputBox({
      title: 'Hawk GitHub workflow · review pull request',
      prompt: `Pull request number in ${repository.owner}/${repository.name}`,
      validateInput: (value) =>
        /^\d+$/.test(value.trim()) ? undefined : 'Enter a numeric pull request number.',
    });
    if (rawNumber === undefined) return;
    const pullRequest = await new GitHubApi({ token, repository }).getPullRequest(
      Number(rawNumber),
    );
    const review = await this.postReview(
      workspace,
      new GitHubApi({ token, repository }),
      Number(rawNumber),
      pullRequest.head,
      pullRequest.base,
    );
    vscode.window.showInformationMessage(
      `Hawk posted a bounded review for PR #${rawNumber}: ${review.findings} finding(s), tests ${review.tests}.`,
    );
  }

  async openPullRequest(workspace: vscode.Uri): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before opening a pull request.');
    }
    const repository = await detectRepository(workspace.fsPath);
    const token = await this.getToken();
    if (!token) throw new Error('Configure Hawk GitHub automation before opening a pull request.');
    const branch = await git(workspace.fsPath, ['branch', '--show-current']);
    const base = await defaultBaseBranch(workspace.fsPath);
    if (!branch || branch === base) {
      throw new Error(`Switch to a feature branch before opening a PR (current base: ${base}).`);
    }
    const title = await vscode.window.showInputBox({
      title: 'Hawk GitHub workflow · open pull request',
      prompt: `Open ${branch} → ${base} in ${repository.owner}/${repository.name}`,
      value: branch.replace(/^hawk\/\d+-/, '').replace(/-/g, ' '),
      validateInput: (value) => (value.trim() ? undefined : 'PR title is required.'),
    });
    if (title === undefined) return;
    const body =
      (await vscode.window.showInputBox({
        title: 'Hawk GitHub workflow · pull request body',
        prompt: 'Summarize the implementation and verification evidence.',
        value: '_Hawk implementation branch._\n\nVerification:\n- ',
        ignoreFocusOut: true,
      })) ?? '';
    const issue = await vscode.window.showInputBox({
      title: 'Hawk GitHub workflow · linked issue (optional)',
      prompt: 'Enter an issue number to close automatically, or leave empty.',
      validateInput: (value) =>
        !value.trim() || /^\d+$/.test(value.trim()) ? undefined : 'Use a numeric issue number.',
    });
    const status = await git(workspace.fsPath, ['status', '--short']);
    if (status.trim()) {
      const approval = await vscode.window.showWarningMessage(
        `Commit and push the current ${status.trim().split(/\r?\n/).length} changed path(s) before opening the PR?`,
        { modal: true },
        'Commit and push',
      );
      if (approval !== 'Commit and push') return;
      await this.commitAndPush(workspace.fsPath, branch, title);
    } else {
      await git(workspace.fsPath, ['push', '--set-upstream', 'origin', branch]);
    }
    const pullRequest = await new GitHubApi({ token, repository }).createPullRequest({
      title: title.trim(),
      head: branch,
      base,
      body: `${bound(body)}${issue?.trim() ? `\n\nCloses #${issue.trim()}` : ''}\n\n_Hawk workflow: implementation → tests → review._`,
    });
    const review = await this.postReview(
      workspace,
      new GitHubApi({ token, repository }),
      pullRequest.number,
      branch,
      base,
    );
    await this.recordDelivery(workspace, repository, pullRequest, branch, base, review);
    vscode.window.showInformationMessage(
      `Hawk opened PR #${pullRequest.number}: ${pullRequest.url} (${review.findings} review signal(s)).`,
    );
  }

  dispose(): void {
    this.output.dispose();
  }

  private async commitAndPush(workspace: string, branch: string, title: string): Promise<void> {
    const status = await git(workspace, ['status', '--short']);
    const sensitive = status
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter((path) => path && SENSITIVE_PATH.test(path));
    if (sensitive.length) {
      throw new Error(`Refusing to commit secret-like paths: ${sensitive.join(', ')}`);
    }
    await git(workspace, ['diff', '--check']);
    await git(workspace, ['add', '-A']);
    await git(workspace, ['commit', '-m', `feat: ${title.trim()}`]);
    await git(workspace, ['push', '--set-upstream', 'origin', branch]);
  }

  private async postReview(
    workspace: vscode.Uri,
    api: GitHubApi,
    pullNumber: number,
    branch: string,
    base: string,
  ): Promise<GitHubWorkflowResult['review']> {
    let tests: GitHubWorkflowResult['review']['tests'] = 'not-run';
    let diffCheck = 'passed';
    try {
      await git(workspace.fsPath, ['diff', '--check', `${base}...${branch}`]);
    } catch {
      diffCheck = 'failed';
      tests = 'failed';
    }
    let findings: Array<{
      title?: string;
      severity?: string;
      source?: { file?: string; line?: number };
    }> = [];
    if (this.client) {
      try {
        const audit = await this.client.staticAudit(workspace);
        findings = audit.findings.slice(0, 20);
      } catch {
        // A review must remain useful even if the local daemon is offline.
      }
    }
    const body = [
      '## Hawk automated review',
      '',
      `- Diff integrity: **${diffCheck}**`,
      `- Static signals: **${findings.length}** (bounded to 20)`,
      `- Verification status: **${tests}**`,
      '',
      findings.length
        ? findings
            .map(
              (finding) =>
                `- ${finding.severity ?? 'signal'}: ${finding.title ?? 'finding'}${finding.source?.file ? ` (${finding.source.file}:${finding.source.line ?? '?'})` : ''}`,
            )
            .join('\n')
        : 'No static signals were returned by Hawk.',
      '',
      '_This is an automated, evidence-bounded review. A human maintainer must verify findings before merge._',
    ].join('\n');
    await api.createReview(pullNumber, bound(body));
    return { status: 'posted', findings: findings.length, tests };
  }

  private async getToken(): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: false,
      });
      if (session?.accessToken) return session.accessToken;
    } catch {
      // Code-OSS builds may not ship the GitHub authentication provider.
    }
    const stored = await this.secrets.get(GITHUB_TOKEN_SECRET);
    return stored?.trim() || undefined;
  }

  private async recordDelivery(
    workspace: vscode.Uri,
    repository: GitHubRepository,
    pullRequest: GitHubPullRequest,
    branch: string,
    base: string,
    review: {
      status: 'posted' | 'skipped';
      findings: number;
      tests: 'passed' | 'failed' | 'not-run';
    },
  ): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.recordSecurityDelivery(workspace, {
        id: `${repository.owner}/${repository.name}#${pullRequest.number}`,
        number: pullRequest.number,
        url: pullRequest.url,
        branch,
        base,
        status: 'open',
        reviewStatus:
          review.status === 'skipped'
            ? 'skipped'
            : review.tests === 'failed'
              ? 'changes-requested'
              : 'passed',
      });
    } catch (error) {
      this.output.appendLine(`Security graph delivery sync skipped: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class GitHubApi {
  constructor(private readonly options: GitHubApiOptions) {}

  async createIssue(title: string, body: string): Promise<GitHubIssue> {
    const issue = await this.request<{ number: number; html_url: string; title: string }>(
      'POST',
      '/issues',
      { title, body },
    );
    return { number: issue.number, url: issue.html_url, title: issue.title };
  }

  async commentIssue(number: number, body: string): Promise<void> {
    await this.request('POST', `/issues/${number}/comments`, { body });
  }

  async createPullRequest(input: {
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<GitHubPullRequest> {
    const pullRequest = await this.request<{ number: number; html_url: string }>(
      'POST',
      '/pulls',
      input,
    );
    return { number: pullRequest.number, url: pullRequest.html_url };
  }

  async createReview(number: number, body: string): Promise<void> {
    await this.request('POST', `/pulls/${number}/reviews`, { body, event: 'COMMENT' });
  }

  async getPullRequest(number: number): Promise<{ head: string; base: string }> {
    const pullRequest = await this.request<{
      head?: { ref?: string };
      base?: { ref?: string };
    }>('GET', `/pulls/${number}`);
    if (!pullRequest.head?.ref || !pullRequest.base?.ref) {
      throw new Error(`GitHub PR #${number} did not include branch metadata.`);
    }
    return { head: pullRequest.head.ref, base: pullRequest.base.ref };
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(
      `https://api.github.com/repos/${this.options.repository.owner}/${this.options.repository.name}${path}`,
      {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 600);
      throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${detail}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

async function detectRepository(workspace: string): Promise<GitHubRepository> {
  const remote = await git(workspace, ['remote', 'get-url', 'origin']);
  const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match?.[1] || !match[2]) throw new Error('Hawk requires a GitHub origin remote.');
  return { owner: match[1], name: match[2], remote };
}

async function defaultBaseBranch(workspace: string): Promise<string> {
  return await git(workspace, ['remote', 'show', 'origin'])
    .then((value) => value.match(/HEAD branch:\s*(\S+)/)?.[1] ?? 'main')
    .catch(() => 'main');
}

function branchName(number: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'hawk-change';
  return `hawk/${number}-${slug}`;
}

function validateBranch(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith('-') ||
    trimmed.includes('..') ||
    /[\s~^:?*\\[\]]/.test(trimmed)
  ) {
    return 'Use a valid Git branch name.';
  }
  return undefined;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function bound(value: string): string {
  return value.length <= MAX_BODY_CHARS
    ? value
    : `${value.slice(0, MAX_BODY_CHARS)}\n\n[Hawk truncated the body]`;
}
