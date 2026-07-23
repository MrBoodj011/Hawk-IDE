import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { hawkVisualSystemCss } from './hawkVisualSystem';

export function renderAgentPanelHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  initialPrompt = '',
): string {
  const nonce = randomBytes(16).toString('base64');
  const logoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'resources', 'hawk-mark.svg'),
  );
  const promptJson = JSON.stringify(initialPrompt).replaceAll('<', '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
  <title>Hawk AI</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, "Segoe UI Variable", "Segoe UI", sans-serif;
      --void: #04080e;
      --night: #07111d;
      --surface: #0a1624;
      --surface-2: #0d1c2d;
      --surface-3: #11243a;
      --stroke: rgba(151,185,218,.14);
      --stroke-hot: rgba(69,217,255,.3);
      --text: #eef6fc;
      --muted: #91a5b8;
      --faint: #586f84;
      --amber: #ffb54e;
      --ember: #ff6f4c;
      --cyan: #45d9ff;
      --mint: #4cf0b7;
      --danger: #ff5b76;
      --violet: #a78bfa;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; overflow: hidden; }
    body {
      color: var(--text);
      background:
        radial-gradient(circle at 0 -15%, rgba(69,217,255,.12), transparent 28rem),
        radial-gradient(circle at 100% 0, rgba(255,111,76,.105), transparent 30rem),
        var(--void);
    }
    button, textarea { font: inherit; }
    button:focus-visible, textarea:focus-visible, input:focus-visible {
      outline: 2px solid var(--cyan);
      outline-offset: 2px;
    }
    button { color: inherit; }
    .shell { display: grid; grid-template-rows: 62px minmax(0,1fr); height: 100vh; }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 18px;
      border-bottom: 1px solid var(--stroke);
      background: rgba(4,8,14,.86);
      backdrop-filter: blur(24px);
      position: relative;
      z-index: 5;
    }
    .topbar::after {
      content: "";
      position: absolute;
      left: 18px;
      right: 18px;
      bottom: -1px;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(69,217,255,.35), rgba(255,181,78,.25), transparent);
    }
    .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .brand img {
      width: 34px;
      height: 34px;
      padding: 2px;
      border: 1px solid rgba(255,181,78,.32);
      border-radius: 11px;
      background: linear-gradient(145deg, #0e1b2b, #07101a);
      box-shadow: 0 0 22px rgba(255,111,76,.09);
    }
    .brand-copy { min-width: 0; }
    .brand h1 { margin: 0; font-size: 13px; letter-spacing: -.025em; }
    .brand p { margin: 3px 0 0; color: var(--faint); font-size: 8px; font-weight: 800; letter-spacing: .15em; text-transform: uppercase; }
    .top-status { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .model-badge, .state-badge {
      overflow: hidden;
      max-width: 190px;
      padding: 6px 8px;
      border: 1px solid var(--stroke);
      border-radius: 7px;
      color: var(--muted);
      background: rgba(255,255,255,.018);
      font-size: 8px;
      font-weight: 800;
      letter-spacing: .05em;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .state-badge { display: flex; align-items: center; gap: 6px; text-transform: uppercase; }
    .state-badge::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--mint);
      box-shadow: 0 0 12px rgba(76,240,183,.75);
    }
    .state-badge.busy::before { background: var(--amber); box-shadow: 0 0 12px rgba(255,181,78,.75); animation: pulse 1.15s infinite; }
    .state-badge.offline::before { background: var(--amber); box-shadow: 0 0 12px rgba(255,181,78,.55); }
    .state-badge.failed::before { background: var(--danger); box-shadow: 0 0 12px rgba(255,91,118,.75); }
    @keyframes pulse { 50% { opacity: .35; transform: scale(.72); } }
    .body { display: grid; grid-template-columns: minmax(0,1fr) 300px; min-height: 0; }
    .conversation { display: grid; grid-template-rows: minmax(0,1fr) auto; min-width: 0; min-height: 0; }
    .timeline { overflow-y: auto; padding: 28px max(20px, 4vw) 36px; scroll-behavior: smooth; }
    .welcome { max-width: 810px; margin: 0 auto 28px; }
    .kicker { color: var(--amber); font-size: 8px; font-weight: 900; letter-spacing: .2em; text-transform: uppercase; }
    h2 { max-width: 680px; margin: 11px 0 14px; font-size: clamp(30px, 4vw, 50px); line-height: .98; letter-spacing: -.057em; }
    .gradient-word { background: linear-gradient(110deg, var(--text), var(--cyan) 55%, var(--amber)); -webkit-background-clip: text; color: transparent; }
    .intro { max-width: 650px; margin: 0; color: var(--muted); font-size: 11px; line-height: 1.72; }
    .trust-row { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 16px; }
    .trust-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 7px;
      border: 1px solid var(--stroke);
      border-radius: 6px;
      color: var(--faint);
      font-size: 8px;
      font-weight: 700;
    }
    .trust-pill::before { content: "✓"; color: var(--mint); }
    .starter-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; margin-top: 22px; }
    .starter {
      position: relative;
      overflow: hidden;
      padding: 13px;
      border: 1px solid var(--stroke);
      border-radius: 11px;
      color: var(--muted);
      text-align: left;
      background: linear-gradient(145deg, rgba(255,255,255,.023), rgba(255,255,255,.008));
      cursor: pointer;
      transition: .16s ease;
    }
    .starter::after {
      content: "↗";
      position: absolute;
      top: 11px;
      right: 12px;
      color: var(--faint);
      font-size: 10px;
    }
    .starter:hover { border-color: var(--stroke-hot); transform: translateY(-1px); background: rgba(69,217,255,.025); }
    .starter b { display: block; color: var(--text); font-size: 10px; }
    .starter span { display: block; max-width: 82%; margin-top: 5px; color: var(--faint); font-size: 8px; line-height: 1.5; }
    .messages { display: grid; gap: 14px; max-width: 810px; margin: 0 auto; }
    .message { display: grid; grid-template-columns: 30px minmax(0,1fr); gap: 10px; }
    .avatar {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border: 1px solid rgba(69,217,255,.24);
      border-radius: 10px;
      color: var(--cyan);
      background: rgba(69,217,255,.06);
      font-size: 8px;
      font-weight: 900;
    }
    .message.user .avatar { color: var(--amber); border-color: rgba(255,181,78,.24); background: rgba(255,181,78,.06); }
    .bubble {
      overflow-wrap: anywhere;
      padding: 12px 14px;
      border: 1px solid var(--stroke);
      border-radius: 4px 12px 12px;
      color: #c0cfdb;
      background: rgba(10,22,36,.79);
      font-family: var(--vscode-font-family, inherit);
      font-size: 11px;
      line-height: 1.67;
      white-space: pre-wrap;
      box-shadow: 0 12px 30px rgba(0,0,0,.09);
    }
    .message.user .bubble { color: var(--text); background: rgba(255,181,78,.045); }
    .bubble.error { color: #ffadbb; border-color: rgba(255,91,118,.3); background: rgba(255,91,118,.04); }
    .streaming::after { content: "▋"; margin-left: 2px; color: var(--cyan); animation: blink .8s infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .activity {
      display: grid;
      grid-template-columns: 7px minmax(0,1fr) auto;
      gap: 9px;
      align-items: start;
      padding: 9px 11px;
      border: 1px solid var(--stroke);
      border-radius: 9px;
      color: var(--muted);
      background: rgba(255,255,255,.013);
      font-size: 9px;
      line-height: 1.5;
    }
    .activity .dot { width: 6px; height: 6px; margin-top: 4px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 9px rgba(69,217,255,.55); }
    .activity.plan .dot { background: var(--violet); box-shadow: 0 0 9px rgba(167,139,250,.55); }
    .activity.test .dot { background: var(--amber); box-shadow: 0 0 9px rgba(255,181,78,.55); }
    .activity.error .dot { background: var(--danger); }
    .activity b { display: block; margin-bottom: 2px; color: var(--text); font-size: 8px; letter-spacing: .06em; text-transform: uppercase; }
    .activity small { color: var(--faint); font-size: 8px; white-space: nowrap; }
    .review-card {
      padding: 14px;
      border: 1px solid rgba(76,240,183,.24);
      border-radius: 12px;
      background: linear-gradient(145deg, rgba(76,240,183,.05), rgba(69,217,255,.025));
    }
    .review-card h3 { margin: 0; font-size: 11px; }
    .review-card p { margin: 5px 0 11px; color: var(--muted); font-size: 9px; line-height: 1.5; }
    .review-stats { display: flex; flex-wrap: wrap; gap: 6px; }
    .review-stats span { padding: 5px 7px; border: 1px solid var(--stroke); border-radius: 6px; color: var(--muted); font-size: 8px; }
    .composer-wrap {
      padding: 14px max(20px, 4vw) 18px;
      border-top: 1px solid var(--stroke);
      background: linear-gradient(transparent, rgba(4,8,14,.96) 25%);
    }
    .composer {
      max-width: 810px;
      margin: 0 auto;
      padding: 10px;
      border: 1px solid rgba(69,217,255,.23);
      border-radius: 14px;
      background: rgba(7,17,29,.97);
      box-shadow: 0 22px 65px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.025);
      transition: border-color .15s ease;
    }
    .composer:focus-within { border-color: rgba(69,217,255,.46); }
    textarea {
      display: block;
      width: 100%;
      height: 68px;
      resize: none;
      border: 0;
      outline: 0;
      color: var(--text);
      background: transparent;
      font-size: 11px;
      line-height: 1.55;
    }
    textarea::placeholder { color: var(--faint); }
    .composer-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .send-group { display: flex; align-items: center; gap: 6px; }
    .selected-context { display: flex; flex-wrap: wrap; gap: 5px; }
    .context-pill { padding: 4px 7px; border: 1px solid var(--stroke); border-radius: 6px; color: var(--faint); font-size: 8px; font-weight: 700; }
    .send {
      display: flex;
      align-items: center;
      gap: 7px;
      min-height: 32px;
      padding: 0 11px;
      border: 0;
      border-radius: 8px;
      color: #180d07;
      background: linear-gradient(125deg, var(--amber), var(--ember));
      box-shadow: 0 8px 20px rgba(255,111,76,.13);
      font-size: 9px;
      font-weight: 900;
      cursor: pointer;
    }
    .send:disabled { opacity: .45; cursor: wait; }
    .parallel-send {
      min-height: 32px;
      padding: 0 10px;
      border: 1px solid var(--stroke);
      border-radius: 8px;
      color: var(--muted);
      background: rgba(255,255,255,.018);
      font-size: 8px;
      font-weight: 800;
      cursor: pointer;
    }
    .parallel-send:hover { color: var(--text); border-color: rgba(69,217,255,.3); }
    .parallel-send:disabled { opacity: .45; cursor: wait; }
    .autonomous-send {
      min-height: 32px;
      padding: 0 10px;
      border: 1px solid rgba(76,240,183,.24);
      border-radius: 8px;
      color: var(--mint);
      background: rgba(76,240,183,.045);
      font-size: 8px;
      font-weight: 850;
      cursor: pointer;
    }
    .autonomous-send:hover { color: var(--text); border-color: rgba(76,240,183,.42); }
    .autonomous-send:disabled { opacity: .45; cursor: wait; }
    .hint { max-width: 810px; margin: 7px auto 0; color: var(--faint); font-size: 8px; text-align: center; }
    .context-panel {
      overflow-y: auto;
      padding: 16px 14px 24px;
      border-left: 1px solid var(--stroke);
      background: rgba(5,12,20,.73);
    }
    .panel-label { margin: 0 0 9px; color: var(--faint); font-size: 8px; font-weight: 900; letter-spacing: .15em; text-transform: uppercase; }
    .session-card {
      margin-bottom: 17px;
      padding: 12px;
      border: 1px solid rgba(69,217,255,.17);
      border-radius: 11px;
      background: linear-gradient(145deg, rgba(69,217,255,.035), rgba(255,255,255,.012));
    }
    .session-card b { display: block; overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .session-meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 7px; color: var(--faint); font-size: 8px; }
    .context-options { display: grid; gap: 6px; margin-bottom: 17px; }
    .option {
      display: grid;
      grid-template-columns: 15px minmax(0,1fr) auto;
      align-items: center;
      gap: 7px;
      padding: 8px;
      border: 1px solid var(--stroke);
      border-radius: 8px;
      color: var(--muted);
      background: rgba(255,255,255,.012);
      font-size: 9px;
    }
    .option input { accent-color: var(--amber); }
    .option small { color: var(--faint); font-size: 7px; }
    .actions { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 6px; margin-bottom: 17px; }
    .action {
      min-height: 31px;
      padding: 6px;
      border: 1px solid var(--stroke);
      border-radius: 7px;
      color: var(--muted);
      background: rgba(255,255,255,.015);
      font-size: 8px;
      font-weight: 800;
      cursor: pointer;
    }
    .action:hover { color: var(--text); border-color: rgba(69,217,255,.27); }
    .action.primary { color: #07120e; border-color: transparent; background: linear-gradient(125deg, var(--mint), #66dfff); }
    .action.danger { color: #ffabb9; border-color: rgba(255,91,118,.24); }
    .action.full { grid-column: 1 / -1; }
    .action[hidden] { display: none; }
    .gate-results { display: grid; gap: 5px; margin-bottom: 17px; }
    .gate-result { display: flex; justify-content: space-between; gap: 7px; padding: 7px 8px; border: 1px solid var(--stroke); border-radius: 7px; color: var(--muted); font-size: 8px; }
    .gate-result .passed { color: var(--mint); }
    .gate-result .failed { color: var(--danger); }
    .verification-summary {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin: 2px 0;
      color: var(--faint);
      font: 750 8px/1.4 var(--vscode-editor-font-family, monospace);
    }
    .verification-summary b { color: var(--muted); }
    .verification-summary .passed { color: var(--mint); }
    .verification-summary .failed,
    .verification-summary .cancelled { color: var(--danger); }
    .history { display: grid; gap: 6px; }
    .history-item {
      width: 100%;
      padding: 8px 9px;
      border: 1px solid transparent;
      border-left: 2px solid var(--cyan);
      color: var(--muted);
      text-align: left;
      background: rgba(69,217,255,.028);
      font-size: 8px;
      line-height: 1.45;
      cursor: pointer;
    }
    .history-item:hover, .history-item.active { color: var(--text); border-color: rgba(69,217,255,.16); border-left-color: var(--amber); }
    .history-item small { display: block; margin-top: 3px; color: var(--faint); text-transform: uppercase; }
    .history-empty { color: var(--faint); font-size: 9px; line-height: 1.55; }
    .settings {
      width: 100%;
      margin-top: 16px;
      padding: 8px;
      border: 1px solid var(--stroke);
      border-radius: 8px;
      color: var(--muted);
      background: rgba(255,255,255,.012);
      font-size: 8px;
      cursor: pointer;
    }
    .settings:hover { color: var(--text); border-color: rgba(69,217,255,.25); }
    .diff-drawer {
      position: absolute;
      inset: 62px 300px 0 0;
      z-index: 12;
      display: grid;
      grid-template-rows: 52px minmax(0,1fr);
      background: rgba(4,8,14,.985);
      backdrop-filter: blur(20px);
    }
    .diff-drawer[hidden] { display: none; }
    .diff-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 17px; border-bottom: 1px solid var(--stroke); }
    .diff-title b { display: block; font-size: 10px; }
    .diff-title span { color: var(--faint); font-size: 8px; }
    .diff-close { border: 1px solid var(--stroke); border-radius: 7px; padding: 6px 9px; color: var(--muted); background: transparent; font-size: 8px; cursor: pointer; }
    pre {
      margin: 0;
      overflow: auto;
      padding: 18px;
      color: #bfd0dd;
      background: #050b12;
      font: 10px/1.58 var(--vscode-editor-font-family, "Cascadia Code", monospace);
      tab-size: 2;
      white-space: pre;
    }
    @media (max-width: 850px) {
      .body { grid-template-columns: 1fr; }
      .context-panel { display: none; }
      .diff-drawer { right: 0; }
    }
    @media (max-width: 560px) {
      .starter-grid { grid-template-columns: 1fr; }
      .model-badge { display: none; }
      .timeline { padding: 22px 14px; }
      .composer-wrap { padding-right: 12px; padding-left: 12px; }
    }
    ${hawkVisualSystemCss}
  </style>
</head>
<body class="agent-ui">
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <img src="${logoUri}" alt="Hawk">
        <div class="brand-copy"><h1>Hawk AI</h1><p>Local operator workspace</p></div>
      </div>
      <div class="top-status">
        <div id="model-badge" class="model-badge">Local control plane</div>
        <div id="state-badge" class="state-badge">Ready</div>
      </div>
    </header>
    <div class="body">
      <main class="conversation">
        <div id="timeline" class="timeline">
          <section id="welcome" class="welcome">
            <div class="kicker">Workspace intelligence / review controlled</div>
            <h2>Understand the system.<br><span class="gradient-word">Control every change.</span></h2>
            <p class="intro">Hawk reads the active files, open tabs, diagnostics and git state, then works inside an isolated snapshot. Every patch stays visible, testable and reversible before it reaches your workspace.</p>
            <div class="trust-row">
              <span class="trust-pill">Isolated execution</span>
              <span class="trust-pill">Exact diff review</span>
              <span class="trust-pill">Safe revert</span>
              <span class="trust-pill">Approval gates</span>
            </div>
            <div class="starter-grid">
              <button class="starter" data-prompt="Review the authentication and authorization flow, identify realistic abuse paths, then implement the smallest safe fixes."><b>Harden the auth path</b><span>Trace trust boundaries, validate evidence, and patch safely.</span></button>
              <button class="starter" data-prompt="Review the current git diff for correctness and security regressions. Fix the confirmed issues and keep the patch minimal."><b>Review my changes</b><span>Inspect local work and return a focused reviewable diff.</span></button>
              <button class="starter" data-prompt="Diagnose the active errors and diagnostics, find the root cause, implement the fix, and prepare the relevant test gates."><b>Fix the active failure</b><span>Use editor errors and file context to close the loop.</span></button>
              <button class="starter" data-prompt="Trace the selected route from entry point to sensitive sink, explain every authorization decision, and fix any confirmed gap."><b>Trace source to request</b><span>Connect request behavior to the exact code path.</span></button>
            </div>
          </section>
          <section id="messages" class="messages" aria-live="polite"></section>
        </div>
        <div class="composer-wrap">
          <div class="composer">
            <textarea id="prompt" placeholder="Ask Hawk to investigate, explain, implement, test, or secure..." aria-label="Hawk task"></textarea>
            <div class="composer-foot">
              <div id="selected-context" class="selected-context"></div>
              <div class="send-group">
                <button id="autonomous-send" class="autonomous-send">Auto verify</button>
                <button id="parallel-send" class="parallel-send">Run 3 lanes</button>
                <button id="send" class="send">Run with Hawk <span>↗</span></button>
              </div>
            </div>
          </div>
          <div class="hint">Ctrl + Enter to run · Apply, test, target access, and revert stay operator-controlled</div>
        </div>
      </main>
      <aside class="context-panel">
        <div class="panel-label">Active session</div>
        <button id="new-session" class="settings">+ New Hawk chat tab</button>
        <div class="session-card">
          <b id="session-title">New Hawk task</b>
          <div class="session-meta"><span id="session-state">ready</span><span id="session-time">local</span></div>
        </div>
        <div class="panel-label">Review controls</div>
        <div class="actions">
          <button id="show-diff" class="action full" hidden>Preview exact diff</button>
          <button id="run-tests" class="action" hidden>Run gates</button>
          <button id="run-reproduction" class="action" hidden>Run reproduction</button>
          <button id="semantic-review" class="action" hidden>Semantic review</button>
          <button id="apply" class="action primary" hidden>Apply</button>
          <button id="reject" class="action danger" hidden>Reject</button>
          <button id="revert" class="action danger full" hidden>Revert applied patch</button>
          <button id="checkpoint" class="action" hidden>Save checkpoint</button>
          <button id="restore-checkpoint" class="action" hidden>Restore checkpoint</button>
          <button id="open-terminal" class="action full" hidden>Open isolated terminal</button>
          <button id="smart-merge" class="action primary full" hidden>Smart Synthesis · best of lanes</button>
          <button id="pause" class="action full" hidden>Pause and preserve task</button>
          <button id="resume" class="action primary full" hidden>Resume recovered task</button>
          <button id="cancel" class="action danger full" hidden>Stop running task</button>
        </div>
        <div id="gate-results" class="gate-results"></div>
        <div class="panel-label">Task context</div>
        <div class="context-options">
          ${contextOption('activeFile', 'Active file', 'source', true)}
          ${contextOption('selection', 'Selection', 'exact', true)}
          ${contextOption('openTabs', 'Open tabs', 'paths', true)}
          ${contextOption('gitDiff', 'Git diff', 'local', true)}
          ${contextOption('diagnostics', 'Diagnostics', 'errors', true)}
          ${contextOption('terminal', 'Terminal output', 'auto + redacted', true)}
          ${contextOption('semantic', 'Semantic index', 'related code', true)}
        </div>
        <div class="panel-label">Session history</div>
        <div id="history" class="history"><div class="history-empty">No native Hawk sessions yet.</div></div>
        <button id="settings" class="settings">Hawk model and daemon settings</button>
      </aside>
    </div>
  </div>
  <section id="diff-drawer" class="diff-drawer" hidden>
    <div class="diff-head">
      <div class="diff-title"><b>Hawk change review</b><span id="diff-meta">Exact isolated patch</span></div>
      <button id="diff-close" class="diff-close">Close preview</button>
    </div>
    <pre id="diff-content"></pre>
  </section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const prompt = document.getElementById('prompt');
    const send = document.getElementById('send');
    const autonomousSend = document.getElementById('autonomous-send');
    const parallelSend = document.getElementById('parallel-send');
    const welcome = document.getElementById('welcome');
    const messages = document.getElementById('messages');
    const timeline = document.getElementById('timeline');
    const stateBadge = document.getElementById('state-badge');
    const modelBadge = document.getElementById('model-badge');
    const initialPrompt = ${promptJson};
    let currentSession = null;
    let streamingBubble = null;
    if (initialPrompt) prompt.value = initialPrompt;

    const contextInputs = Array.from(document.querySelectorAll('[data-context]'));
    updateContextChips();
    contextInputs.forEach((input) => input.addEventListener('change', updateContextChips));
    document.querySelectorAll('[data-prompt]').forEach((button) => {
      button.addEventListener('click', () => {
        prompt.value = button.dataset.prompt || '';
        prompt.focus();
      });
    });
    send.addEventListener('click', submit);
    autonomousSend.addEventListener('click', submitAutonomous);
    parallelSend.addEventListener('click', submitParallel);
    prompt.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    bindAction('settings', 'settings');
    bindAction('new-session', 'new-session');
    bindAction('show-diff', 'show-diff');
    bindAction('run-tests', 'run-tests');
    bindAction('run-reproduction', 'run-reproduction');
    bindAction('semantic-review', 'semantic-review');
    bindAction('apply', 'apply');
    bindAction('reject', 'reject');
    bindAction('revert', 'revert');
    bindAction('checkpoint', 'checkpoint');
    bindAction('restore-checkpoint', 'restore-checkpoint');
    bindAction('open-terminal', 'open-terminal');
    bindAction('smart-merge', 'smart-merge');
    bindAction('pause', 'pause');
    bindAction('resume', 'resume');
    bindAction('cancel', 'cancel');
    document.getElementById('diff-close').addEventListener('click', () => {
      document.getElementById('diff-drawer').hidden = true;
    });

    vscode.postMessage({ action: 'ready' });
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || !data.type) return;
      if (data.type === 'prefill') {
        prompt.value = data.prompt || '';
        prompt.focus();
        return;
      }
      if (data.type === 'history') {
        renderHistory(data.items || []);
        return;
      }
      if (data.type === 'parallel-batch') {
        document.getElementById('smart-merge').hidden = !(data.sessionIds && data.sessionIds.length > 1);
        const scheduler = data.scheduler || {};
        addActivity(
          'plan',
          'Docker AI scheduler',
          (data.sessionIds || []).length + ' durable container lanes are active' +
            (scheduler.strategy ? ' with ' + scheduler.strategy + ' placement' : '') +
            (scheduler.dockerVersion ? ' on Docker ' + scheduler.dockerVersion : '') +
            (data.batchId ? ' · batch ' + String(data.batchId).slice(0, 8) : '') +
            '. Smart Synthesis becomes available when at least two diffs are ready.',
        );
        return;
      }
      if (data.type === 'parallel-batch-status') {
        const batch = data.batch || {};
        const counts = Object.entries(batch.counts || {})
          .map(([status, count]) => status + ': ' + count)
          .join(' · ');
        addActivity(
          'status',
          'Docker batch ' + (batch.lifecycle || 'running'),
          (counts || 'Lanes are progressing') + (batch.scheduler && batch.scheduler.dockerVersion
            ? ' · Docker ' + batch.scheduler.dockerVersion
            : ''),
        );
        return;
      }
      if (data.type === 'parallel-lane-event') {
        const event = data.event || {};
        addActivity(
          event.type === 'error' ? 'error' : 'status',
          'Parallel lane ' + (event.laneId || event.sessionId || 'worker'),
          event.text || event.type || 'Lane updated',
        );
        return;
      }
      if (data.type === 'merge-score') {
        const summary = (data.candidates || [])
          .map((item, index) => '#' + (index + 1) + ' score ' + item.score + ' · ' + (item.reasons || []).join(', '))
          .join('\\n');
        addActivity('plan', 'Candidate intelligence', summary || 'Candidates scored.');
        return;
      }
      if (data.type === 'semantic-merge-plan') {
        const plan = data.plan || {};
        const conflicts = (plan.conflicts || [])
          .slice(0, 8)
          .map((item) => item.path + ' :: ' + item.unit + ' - ' + item.reason)
          .join('\\n');
        const summary =
          (plan.automaticallyMergedUnits || []).length + ' compatible AST/file changes seeded before the model. ' +
          (plan.conflicts || []).length + ' semantic conflicts need explicit resolution.' +
          (conflicts ? '\\n\\n' + conflicts : '');
        addActivity('plan', 'AST semantic merge', summary);
        return;
      }
      if (data.type === 'session-clear') {
        currentSession = null;
        streamingBubble = null;
        messages.replaceChildren();
        welcome.style.display = '';
        document.getElementById('session-title').textContent = 'New Hawk task';
        document.getElementById('session-state').textContent = 'ready';
        document.getElementById('session-time').textContent = 'local';
        stateBadge.className = 'state-badge';
        stateBadge.textContent = 'Ready';
        modelBadge.textContent = 'Local control plane';
        send.disabled = false;
        autonomousSend.disabled = false;
        parallelSend.disabled = false;
        ['show-diff', 'run-tests', 'run-reproduction', 'semantic-review', 'apply', 'reject', 'revert', 'checkpoint', 'restore-checkpoint', 'open-terminal', 'smart-merge', 'pause', 'resume', 'cancel']
          .forEach((id) => { document.getElementById(id).hidden = true; });
        renderHistory([]);
        prompt.focus();
        return;
      }
      if (data.type === 'session-reset') {
        currentSession = data.session;
        streamingBubble = null;
        welcome.style.display = 'none';
        messages.replaceChildren();
        (data.events || []).forEach(renderEvent);
        renderSession(currentSession);
        return;
      }
      if (data.type === 'session') {
        currentSession = data.session;
        renderSession(currentSession);
        return;
      }
      if (data.type === 'event') {
        renderEvent(data.event);
        return;
      }
      if (data.type === 'diff') {
        renderDiff(data.diff);
        return;
      }
      if (data.type === 'busy') {
        setBusy(true, data.text || 'Hawk is working...');
        addActivity('status', 'Control plane', data.text || 'Hawk is working...');
        return;
      }
      if (data.type === 'error') {
        const copy = data.text || 'The Hawk task failed.';
        const offline = isLocalModelOffline(copy);
        setBusy(false, offline ? 'Model offline' : 'Needs attention', !offline, offline);
        addMessage('hawk', friendlyError(copy), true);
      }
    });

    function submit() {
      const value = prompt.value.trim();
      if (!value || send.disabled) return;
      const contexts = contextInputs.filter((input) => input.checked).map((input) => input.dataset.context);
      welcome.style.display = 'none';
      finalizeStream();
      addMessage('user', value);
      prompt.value = '';
      setBusy(true, 'Preparing');
      vscode.postMessage({ action: 'ask', prompt: value, contexts });
    }

    function submitParallel() {
      const value = prompt.value.trim();
      if (!value || send.disabled) return;
      const contexts = contextInputs.filter((input) => input.checked).map((input) => input.dataset.context);
      welcome.style.display = 'none';
      finalizeStream();
      addMessage('user', value + '  /  3 parallel lanes');
      prompt.value = '';
      setBusy(true, 'Launching lanes');
      vscode.postMessage({ action: 'parallel', prompt: value, contexts });
    }

    function submitAutonomous() {
      const value = prompt.value.trim();
      if (!value || send.disabled) return;
      const contexts = contextInputs.filter((input) => input.checked).map((input) => input.dataset.context);
      welcome.style.display = 'none';
      finalizeStream();
      addMessage('user', value + '  /  autonomous verification');
      prompt.value = '';
      setBusy(true, 'Launching verified task');
      vscode.postMessage({ action: 'autonomous', prompt: value, contexts });
    }

    function renderEvent(event) {
      if (!event) return;
      if (event.type === 'assistant-delta') {
        if (!streamingBubble) streamingBubble = addMessage('hawk', '', false, true);
        streamingBubble.textContent += event.text || '';
        scrollBottom();
        return;
      }
      if (event.type === 'assistant-text') {
        finalizeStream();
        addMessage('hawk', event.text || '');
        return;
      }
      if (event.type === 'plan') {
        addActivity('plan', 'Hawk plan', event.text || '');
        return;
      }
      if (event.type === 'tool-call') {
        addActivity('tool', 'Workspace tool · ' + (event.tool || 'tool'), event.text || '');
        return;
      }
      if (event.type === 'tool-result') {
        addActivity('tool', 'Tool completed · ' + (event.tool || 'tool'), compact(event.text || '', 360), event.durationMs);
        return;
      }
      if (event.type === 'test-output') {
        addActivity('test', 'Approved test gate', compact(event.text || '', 900));
        return;
      }
      if (event.type === 'diff-ready') {
        finalizeStream();
        addActivity('status', 'Review ready', event.text || 'The exact diff is ready.');
        return;
      }
      if (event.type === 'error') {
        finalizeStream();
        addMessage('hawk', friendlyError(event.text || 'Hawk task failed.'), true);
        return;
      }
      if (event.type === 'done') {
        finalizeStream();
        return;
      }
      if (event.text) addActivity('status', 'Hawk runtime', event.text);
    }

    function renderSession(session) {
      if (!session) return;
      document.getElementById('session-title').textContent = session.title || 'Hawk AI task';
      const offline = session.status === 'failed' && isLocalModelOffline(session.error || '');
      const statusLabel = offline ? 'model offline' : labelStatus(session.status);
      document.getElementById('session-state').textContent = statusLabel;
      document.getElementById('session-time').textContent = relativeTime(session.updatedAt);
      const modelIdentity = [session.provider, session.model].filter(Boolean).join(' · ');
      const dockerIdentity = session.execution
        ? 'Docker · ' + session.execution.instanceId
        : '';
      modelBadge.textContent = [modelIdentity, dockerIdentity].filter(Boolean).join(' / ') || 'Local control plane';
      const busy = ['preparing', 'running', 'testing'].includes(session.status);
      const failed = session.status === 'failed';
      stateBadge.className = 'state-badge' + (busy ? ' busy' : offline ? ' offline' : failed ? ' failed' : '');
      stateBadge.textContent = statusLabel;
      send.disabled = busy;
      autonomousSend.disabled = busy;
      parallelSend.disabled = busy;
      prompt.placeholder = session.status === 'awaiting-review'
        ? 'Ask Hawk to refine this patch, explain a change, or add a focused fix...'
        : 'Ask Hawk to investigate, explain, implement, test, or secure...';
      document.getElementById('show-diff').hidden = !session.diff;
      document.getElementById('run-tests').hidden = !(session.diff && session.testGates && session.testGates.length);
      document.getElementById('run-reproduction').hidden = !session.diff;
      document.getElementById('semantic-review').hidden = !session.diff;
      document.getElementById('apply').hidden = !session.canApply;
      document.getElementById('reject').hidden = !session.canReject;
      document.getElementById('revert').hidden = !session.canRevert;
      document.getElementById('checkpoint').hidden = !session.canCheckpoint;
      document.getElementById('restore-checkpoint').hidden = !(session.checkpoints && session.checkpoints.length);
      document.getElementById('open-terminal').hidden = !session.canOpenTerminal;
      document.getElementById('pause').hidden = !session.canPause;
      document.getElementById('resume').hidden = !session.canResume;
      document.getElementById('cancel').hidden = !busy;
      renderGateResults(session);
      if (session.diff) ensureReviewCard(session.diff);
      if (!busy) finalizeStream();
    }

    function ensureReviewCard(diff) {
      let card = document.getElementById('review-card');
      if (!card) {
        card = document.createElement('div');
        card.id = 'review-card';
        card.className = 'review-card';
        messages.append(card);
      }
      card.replaceChildren();
      const title = document.createElement('h3');
      title.textContent = 'Exact patch ready for your review';
      const copy = document.createElement('p');
      copy.textContent = 'Nothing has touched your real workspace. Preview the diff, run the approved gates, then Apply or Reject.';
      const stats = document.createElement('div');
      stats.className = 'review-stats';
      [diff.files + ' files', '+' + diff.insertions, '-' + diff.deletions, formatBytes(diff.bytes)].forEach((value) => {
        const item = document.createElement('span');
        item.textContent = value;
        stats.append(item);
      });
      card.append(title, copy, stats);
      scrollBottom();
    }

    function renderGateResults(session) {
      const root = document.getElementById('gate-results');
      root.replaceChildren();
      const quality = session.quality || { reproduction: 'pending', tests: 'pending', semanticReview: 'pending' };
      [['Reproduction', quality.reproduction], ['Tests', quality.tests], ['Semantic review', quality.semanticReview]].forEach(([label, status]) => {
        const row = document.createElement('div');
        row.className = 'gate-result';
        const name = document.createElement('span');
        name.textContent = label;
        const value = document.createElement('span');
        value.className = String(status);
        value.textContent = String(status);
        row.append(name, value);
        root.append(row);
      });
      (session.verificationHistory || []).slice(-4).forEach((attempt) => {
        const summary = document.createElement('div');
        summary.className = 'verification-summary';
        const label = document.createElement('b');
        label.textContent = 'Auto verify #' + attempt.attempt;
        const outcome = document.createElement('span');
        outcome.className = attempt.outcome;
        outcome.textContent = attempt.outcome;
        summary.append(label, outcome);
        root.append(summary);
      });
      (session.testResults || []).forEach((result) => {
        const row = document.createElement('div');
        row.className = 'gate-result';
        const label = document.createElement('span');
        label.textContent = result.label;
        const status = document.createElement('span');
        status.className = result.status;
        status.textContent = result.status;
        row.append(label, status);
        root.append(row);
      });
    }

    function renderDiff(diff) {
      const drawer = document.getElementById('diff-drawer');
      const summary = diff.summary || {};
      document.getElementById('diff-meta').textContent =
        (summary.files || 0) + ' files · +' + (summary.insertions || 0) + ' -' + (summary.deletions || 0) + ' · SHA-256 locked';
      document.getElementById('diff-content').textContent = diff.patch || '';
      drawer.hidden = false;
    }

    function addMessage(role, copy, isError = false, streaming = false) {
      const previous = messages.lastElementChild;
      const previousBubble = previous?.querySelector?.('.bubble');
      if (!streaming && previous?.classList?.contains(role) && previousBubble?.textContent === copy) {
        return previousBubble;
      }
      const message = document.createElement('div');
      message.className = 'message ' + role;
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = role === 'user' ? 'YOU' : 'H';
      const bubble = document.createElement('div');
      bubble.className = 'bubble' + (isError ? ' error' : '') + (streaming ? ' streaming' : '');
      bubble.textContent = copy;
      message.append(avatar, bubble);
      messages.append(message);
      scrollBottom();
      return bubble;
    }

    function addActivity(kind, label, copy, duration) {
      const row = document.createElement('div');
      row.className = 'activity ' + kind;
      const dot = document.createElement('span');
      dot.className = 'dot';
      const body = document.createElement('div');
      const title = document.createElement('b');
      title.textContent = label;
      const text = document.createElement('span');
      text.textContent = copy;
      body.append(title, text);
      const time = document.createElement('small');
      time.textContent = typeof duration === 'number' ? Math.max(1, Math.round(duration / 1000)) + 's' : '';
      row.append(dot, body, time);
      messages.append(row);
      scrollBottom();
    }

    function finalizeStream() {
      if (!streamingBubble) return;
      streamingBubble.classList.remove('streaming');
      if (!streamingBubble.textContent.trim()) {
        streamingBubble.closest('.message')?.remove();
      }
      streamingBubble = null;
    }

    function setBusy(busy, label, failed = false, offline = false) {
      send.disabled = busy;
      autonomousSend.disabled = busy;
      parallelSend.disabled = busy;
      stateBadge.className = 'state-badge' + (busy ? ' busy' : offline ? ' offline' : failed ? ' failed' : '');
      stateBadge.textContent = label;
    }

    function updateContextChips() {
      const wrap = document.getElementById('selected-context');
      wrap.replaceChildren();
      contextInputs.filter((input) => input.checked).slice(0, 3).forEach((input) => {
        const chip = document.createElement('span');
        chip.className = 'context-pill';
        chip.textContent = '# ' + input.dataset.context;
        wrap.append(chip);
      });
    }

    function renderHistory(items) {
      const history = document.getElementById('history');
      history.replaceChildren();
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = 'No native Hawk sessions yet.';
        history.append(empty);
        return;
      }
      items.slice(0, 8).forEach((item) => {
        const row = document.createElement('button');
        row.className = 'history-item' + (currentSession && currentSession.id === item.id ? ' active' : '');
        row.textContent = item.title || item.prompt || 'Hawk AI task';
        const meta = document.createElement('small');
        meta.textContent = labelStatus(item.status) + ' · ' + relativeTime(item.updatedAt);
        row.append(meta);
        row.addEventListener('click', () => vscode.postMessage({ action: 'select-session', sessionId: item.id }));
        history.append(row);
      });
    }

    function bindAction(id, action) {
      document.getElementById(id).addEventListener('click', () => vscode.postMessage({ action }));
    }

    function labelStatus(status) {
      const labels = {
        preparing: 'preparing',
        running: 'reasoning',
        paused: 'paused · recoverable',
        testing: 'testing',
        'awaiting-review': 'review ready',
        applied: 'applied',
        rejected: 'rejected',
        reverted: 'reverted',
        cancelled: 'cancelled',
        failed: 'failed'
      };
      return labels[status] || 'ready';
    }

    function isLocalModelOffline(copy) {
      const value = String(copy || '').toLowerCase();
      return (
        value.includes('ollama') &&
        (value.includes('fetch failed') ||
          value.includes('econnrefused') ||
          value.includes('connection refused') ||
          value.includes('11434'))
      );
    }

    function friendlyError(copy) {
      if (isLocalModelOffline(copy)) {
        return 'Local model is offline. Start Ollama or choose another configured model in Hawk Settings.';
      }
      return copy;
    }

    function relativeTime(value) {
      const ms = Date.now() - Date.parse(value || '');
      if (!Number.isFinite(ms) || ms < 0) return 'now';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 1) return 'now';
      if (minutes < 60) return minutes + 'm';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h';
      return Math.floor(hours / 24) + 'd';
    }

    function formatBytes(bytes) {
      if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
      return (bytes / 1024).toFixed(1) + ' KB';
    }

    function compact(value, limit) {
      return value.length > limit ? value.slice(0, limit) + '...' : value;
    }

    function scrollBottom() {
      timeline.scrollTop = timeline.scrollHeight;
    }
  </script>
</body>
</html>`;
}

function contextOption(id: string, label: string, hint: string, checked: boolean): string {
  return `<label class="option">
    <input type="checkbox" data-context="${id}" ${checked ? 'checked' : ''}>
    <span>${label}</span>
    <small>${hint}</small>
  </label>`;
}
