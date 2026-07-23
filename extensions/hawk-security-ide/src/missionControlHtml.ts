import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { hawkVisualSystemCss } from './hawkVisualSystem';

export type MissionControlMode = 'panel' | 'sidebar';

export function renderMissionControlHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  mode: MissionControlMode,
): string {
  const nonce = randomBytes(16).toString('base64');
  const logoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'resources', 'hawk-mark.svg'),
  );
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource}`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Hawk Mission Control</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, "Segoe UI Variable", "Segoe UI", sans-serif;
      --void: #05090f;
      --ink: #08111d;
      --raised: #0d1826;
      --stroke: rgba(154, 184, 214, .14);
      --text: #edf5fb;
      --muted: #8293a7;
      --faint: #546477;
      --ember: #ff744d;
      --amber: #ffb24c;
      --cyan: #45d9ff;
      --mint: #4cf0b7;
      --danger: #ff5470;
      --warning: #ffc85c;
      --shadow: 0 30px 90px rgba(0, 0, 0, .34);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      overflow-x: hidden;
      color: var(--text);
      background:
        radial-gradient(circle at 18% -8%, rgba(69, 217, 255, .09), transparent 25rem),
        radial-gradient(circle at 86% 2%, rgba(255, 116, 77, .13), transparent 29rem),
        var(--void);
    }
    button, textarea { font: inherit; }
    button { color: inherit; }
    button:focus-visible, textarea:focus-visible {
      outline: 2px solid var(--cyan);
      outline-offset: 2px;
    }
    .ambient-grid {
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      opacity: .22;
      background-image:
        linear-gradient(rgba(104, 145, 181, .08) 1px, transparent 1px),
        linear-gradient(90deg, rgba(104, 145, 181, .08) 1px, transparent 1px);
      background-size: 52px 52px;
      mask-image: linear-gradient(to bottom, black, transparent 82%);
    }
    .app-shell {
      display: grid;
      grid-template-columns: 78px minmax(0, 1fr);
      min-height: 100vh;
    }
    .rail {
      position: sticky;
      top: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 18px 11px;
      border-right: 1px solid var(--stroke);
      background: rgba(4, 9, 15, .78);
      backdrop-filter: blur(22px);
    }
    .rail-logo {
      width: 42px;
      height: 42px;
      margin-bottom: 18px;
      padding: 3px;
      border: 1px solid rgba(255, 178, 76, .34);
      border-radius: 14px;
      background: #091321;
      box-shadow: 0 12px 35px rgba(255, 116, 77, .16);
    }
    .rail-logo img { width: 100%; height: 100%; display: block; }
    .rail-nav { display: flex; flex-direction: column; gap: 7px; width: 100%; }
    .nav-button {
      position: relative;
      display: grid;
      place-items: center;
      width: 100%;
      aspect-ratio: 1;
      border: 1px solid transparent;
      border-radius: 14px;
      color: var(--faint);
      background: transparent;
      cursor: pointer;
      transition: .18s ease;
    }
    .nav-button svg {
      width: 19px;
      height: 19px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.7;
    }
    .nav-button:hover {
      color: var(--text);
      border-color: var(--stroke);
      background: rgba(255,255,255,.035);
    }
    .nav-button.active {
      color: var(--amber);
      border-color: rgba(255, 178, 76, .2);
      background: rgba(255, 178, 76, .08);
      box-shadow: inset 0 0 22px rgba(255, 116, 77, .04);
    }
    .nav-button.active::before {
      content: "";
      position: absolute;
      left: -12px;
      width: 3px;
      height: 20px;
      border-radius: 0 4px 4px 0;
      background: linear-gradient(var(--amber), var(--ember));
      box-shadow: 0 0 18px var(--ember);
    }
    .rail-bottom { margin-top: auto; }
    .workspace { min-width: 0; padding: 0 28px 56px; }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(260px, 520px) auto;
      align-items: center;
      gap: 18px;
      height: 70px;
      margin: 0 -28px;
      padding: 0 30px;
      border-bottom: 1px solid var(--stroke);
      background: rgba(5, 9, 15, .78);
      backdrop-filter: blur(24px);
    }
    .wordmark { display: flex; align-items: center; min-width: 0; gap: 11px; }
    .wordmark img { width: 31px; height: 31px; display: none; }
    .wordmark-title { font-size: 14px; font-weight: 850; letter-spacing: .05em; }
    .product-badge {
      padding: 3px 6px;
      border: 1px solid rgba(245, 193, 91, .2);
      border-radius: 5px;
      color: var(--amber);
      background: rgba(245, 193, 91, .055);
      font: 800 8px/1 var(--vscode-editor-font-family, monospace);
      letter-spacing: .1em;
    }
    .wordmark-slash { color: #33465b; margin: 0 2px; }
    .wordmark-context {
      overflow: hidden;
      color: var(--muted);
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .command-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      height: 38px;
      padding: 0 12px;
      border: 1px solid var(--stroke);
      border-radius: 11px;
      color: var(--muted);
      background: rgba(12, 23, 36, .72);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
      cursor: pointer;
    }
    .command-bar svg { width: 15px; stroke: var(--cyan); }
    .command-copy { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .key {
      margin-left: auto;
      padding: 2px 6px;
      border: 1px solid var(--stroke);
      border-radius: 5px;
      color: var(--faint);
      font-size: 10px;
    }
    .system-state {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
      letter-spacing: .04em;
      white-space: nowrap;
    }
    .system-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--warning);
      box-shadow: 0 0 14px var(--warning);
    }
    .system-state.online .system-dot { background: var(--mint); box-shadow: 0 0 14px var(--mint); }
    .system-state.offline .system-dot { background: var(--danger); box-shadow: 0 0 14px var(--danger); }
    .content { width: min(1480px, 100%); margin: 0 auto; }
    .mission-strip {
      display: flex;
      align-items: center;
      gap: 11px;
      margin-top: 22px;
      padding: 10px 13px;
      border: 1px solid var(--stroke);
      border-radius: 10px;
      color: var(--muted);
      background: rgba(10, 19, 30, .55);
      font-size: 11px;
    }
    .mission-strip .pulse {
      width: 6px;
      height: 6px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: var(--cyan);
      box-shadow: 0 0 16px var(--cyan);
      animation: pulse 2.5s ease-in-out infinite;
    }
    .mission-strip strong { color: var(--text); }
    .hero {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(290px, .65fr);
      gap: 34px;
      align-items: end;
      min-height: 330px;
      padding: 62px 0 42px;
      overflow: hidden;
      border-bottom: 1px solid var(--stroke);
    }
    .hero::after {
      content: "";
      position: absolute;
      right: 0;
      bottom: 0;
      width: 43%;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--ember));
      box-shadow: 0 -20px 70px rgba(255, 116, 77, .18);
    }
    .eyebrow {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 17px;
      color: var(--amber);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .19em;
      text-transform: uppercase;
    }
    .eyebrow::before { content: ""; width: 28px; height: 1px; background: var(--amber); }
    h1 {
      max-width: 870px;
      margin: 0;
      font-size: clamp(44px, 5.3vw, 78px);
      line-height: .94;
      letter-spacing: -.065em;
      font-weight: 760;
    }
    .hero-accent {
      color: transparent;
      -webkit-text-stroke: 1px rgba(237, 245, 251, .4);
    }
    .hero-copy {
      max-width: 700px;
      margin: 22px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.7;
    }
    .hero-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 27px; }
    .hero-proofline {
      display: flex;
      flex-wrap: wrap;
      gap: 7px 14px;
      margin-top: 20px;
      color: var(--faint);
      font: 750 8px/1.4 var(--vscode-editor-font-family, monospace);
      letter-spacing: .1em;
      text-transform: uppercase;
    }
    .hero-proofline span { display: inline-flex; align-items: center; gap: 7px; }
    .hero-proofline span::before {
      content: "";
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--mint);
      box-shadow: 0 0 9px rgba(76,240,183,.45);
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      min-height: 42px;
      padding: 0 15px;
      border: 1px solid transparent;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
      transition: transform .15s ease, filter .15s ease, border-color .15s ease;
    }
    .button:hover { transform: translateY(-1px); filter: brightness(1.08); }
    .button.primary {
      color: #160d08;
      background: linear-gradient(120deg, var(--amber), var(--ember));
      box-shadow: 0 15px 34px rgba(255, 116, 77, .16);
    }
    .button.secondary {
      border-color: var(--stroke);
      color: var(--text);
      background: rgba(16, 29, 44, .72);
    }
    .button.ghost {
      border-color: rgba(69, 217, 255, .19);
      color: var(--cyan);
      background: rgba(69, 217, 255, .055);
    }
    .button.small { min-height: 32px; padding: 0 10px; border-radius: 8px; font-size: 10px; }
    .radar { position: relative; display: grid; place-items: center; min-height: 250px; }
    .radar-ring {
      position: absolute;
      width: 230px;
      height: 230px;
      border: 1px solid rgba(69, 217, 255, .14);
      border-radius: 50%;
    }
    .radar-ring::before, .radar-ring::after {
      content: "";
      position: absolute;
      inset: 25%;
      border: 1px solid rgba(69, 217, 255, .11);
      border-radius: inherit;
    }
    .radar-ring::after { inset: 45%; }
    .radar-sweep {
      position: absolute;
      width: 214px;
      height: 214px;
      border-radius: 50%;
      background: conic-gradient(from 10deg, transparent 0 80%, rgba(69,217,255,.18), transparent);
      animation: sweep 7s linear infinite;
    }
    .radar-cross-x, .radar-cross-y {
      position: absolute;
      background: linear-gradient(90deg, transparent, rgba(69,217,255,.12), transparent);
    }
    .radar-cross-x { width: 250px; height: 1px; }
    .radar-cross-y { width: 1px; height: 250px; }
    .radar-core {
      position: relative;
      z-index: 2;
      display: grid;
      place-items: center;
      width: 92px;
      height: 92px;
      border: 1px solid rgba(255, 178, 76, .42);
      border-radius: 28px;
      background: rgba(8, 17, 29, .9);
      transform: rotate(45deg);
      box-shadow: 0 0 70px rgba(255, 116, 77, .15);
    }
    .radar-core img { width: 63px; height: 63px; transform: rotate(-45deg); }
    .radar-label {
      position: absolute;
      right: 8px;
      bottom: 8px;
      display: flex;
      gap: 8px;
      color: var(--faint);
      font: 10px/1.3 var(--vscode-editor-font-family, monospace);
    }
    .radar-label b { color: var(--mint); }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      border: 1px solid var(--stroke);
      border-radius: 15px;
      overflow: hidden;
      background: rgba(8, 17, 29, .72);
      box-shadow: var(--shadow);
    }
    .metric {
      position: relative;
      min-width: 0;
      padding: 20px 18px 18px;
      border-right: 1px solid var(--stroke);
    }
    .metric:last-child { border-right: 0; }
    .metric-label { color: var(--faint); font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .metric-value { margin-top: 7px; font-size: 26px; font-weight: 720; letter-spacing: -.045em; }
    .metric-meta { margin-top: 5px; overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .metric::after {
      content: "";
      position: absolute;
      left: 18px;
      bottom: 0;
      width: 34px;
      height: 2px;
      background: var(--cyan);
      opacity: .6;
    }
    .metric.risk::after { background: var(--ember); }
    .section { padding: 46px 0 0; scroll-margin-top: 86px; }
    .section-head {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 16px;
    }
    .section-kicker { color: var(--cyan); font-size: 9px; font-weight: 850; letter-spacing: .18em; text-transform: uppercase; }
    h2 { margin: 7px 0 0; font-size: 21px; font-weight: 700; letter-spacing: -.035em; }
    .section-note { max-width: 440px; color: var(--muted); font-size: 11px; line-height: 1.55; text-align: right; }
    .bento { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(310px, .65fr); gap: 14px; }
    .card {
      position: relative;
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--stroke);
      border-radius: 15px;
      background:
        linear-gradient(145deg, rgba(255,255,255,.018), transparent 44%),
        rgba(9, 18, 30, .78);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.018);
    }
    .card::before {
      content: "";
      position: absolute;
      top: -1px;
      left: 24px;
      width: 44px;
      height: 1px;
      background: var(--amber);
      box-shadow: 0 0 20px var(--ember);
    }
    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 15px 17px;
      border-bottom: 1px solid var(--stroke);
    }
    .card-title { font-size: 11px; font-weight: 800; letter-spacing: .025em; }
    .card-title span { margin-left: 7px; color: var(--faint); font-size: 9px; font-weight: 600; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      border: 1px solid rgba(76, 240, 183, .15);
      border-radius: 999px;
      color: var(--mint);
      background: rgba(76, 240, 183, .05);
      font-size: 8px;
      font-weight: 850;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .card-body { padding: 17px; }
    .ai-card { min-height: 360px; }
    .ai-card .card-body { display: flex; min-height: 306px; flex-direction: column; }
    .ai-intro { display: flex; gap: 13px; }
    .ai-orb {
      flex: 0 0 auto;
      width: 38px;
      height: 38px;
      border: 1px solid rgba(69,217,255,.28);
      border-radius: 13px;
      background: radial-gradient(circle at 36% 28%, rgba(69,217,255,.28), rgba(255,116,77,.12) 42%, rgba(8,17,29,.9));
      box-shadow: inset 0 0 22px rgba(69,217,255,.08);
    }
    .ai-message { max-width: 640px; color: #b6c5d3; font-size: 12px; line-height: 1.65; }
    .ai-message strong { color: var(--text); }
    .suggestions { display: flex; flex-wrap: wrap; gap: 7px; margin: 18px 0; }
    .suggestion {
      padding: 7px 9px;
      border: 1px solid var(--stroke);
      border-radius: 8px;
      color: var(--muted);
      background: rgba(255,255,255,.018);
      font-size: 10px;
      cursor: pointer;
    }
    .suggestion:hover { color: var(--text); border-color: rgba(69,217,255,.3); }
    .composer {
      margin-top: auto;
      padding: 10px;
      border: 1px solid rgba(69,217,255,.19);
      border-radius: 12px;
      background: rgba(5, 11, 19, .72);
    }
    .composer textarea {
      display: block;
      width: 100%;
      height: 58px;
      resize: none;
      border: 0;
      outline: 0;
      color: var(--text);
      background: transparent;
      font-size: 12px;
      line-height: 1.5;
    }
    .composer textarea::placeholder { color: #526579; }
    .composer-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .context-chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .context-chip {
      padding: 4px 7px;
      border: 1px solid var(--stroke);
      border-radius: 6px;
      color: var(--faint);
      font-size: 8px;
      font-weight: 700;
    }
    .send-button {
      display: grid;
      place-items: center;
      width: 31px;
      height: 31px;
      flex: 0 0 auto;
      border: 0;
      border-radius: 8px;
      color: #130c07;
      background: linear-gradient(135deg, var(--amber), var(--ember));
      cursor: pointer;
    }
    .surface-graph { min-height: 360px; }
    .graph-canvas {
      position: relative;
      min-height: 306px;
      padding: 18px;
      background-image: radial-gradient(circle, rgba(111,146,177,.16) 1px, transparent 1px);
      background-size: 18px 18px;
    }
    .graph-node {
      position: absolute;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 7px;
      max-width: 42%;
      padding: 8px 10px;
      border: 1px solid var(--stroke);
      border-radius: 9px;
      color: var(--muted);
      background: rgba(8, 17, 29, .94);
      font: 9px/1.2 var(--vscode-editor-font-family, monospace);
      box-shadow: 0 10px 26px rgba(0,0,0,.24);
      cursor: pointer;
    }
    .graph-node:hover { color: var(--text); border-color: rgba(69,217,255,.3); }
    .graph-node.observed {
      color: var(--text);
      border-color: rgba(76,240,183,.32);
      box-shadow: 0 10px 26px rgba(0,0,0,.24), 0 0 24px rgba(76,240,183,.06);
    }
    .graph-node.finding { border-color: rgba(255,84,112,.38); color: #ff8ca0; }
    .graph-node.protocol, .graph-node.trust-boundary { border-color: rgba(69,217,255,.38); color: #8fe8ff; }
    .graph-node.infrastructure { border-color: rgba(255,188,92,.38); color: #ffd28a; }
    .graph-node.evidence { border-color: rgba(76,240,183,.34); color: var(--mint); }
    .graph-node.request { border-color: rgba(255,178,76,.34); color: var(--amber); }
    .graph-node.patch, .graph-node.test { border-color: rgba(187,130,255,.34); color: #caa4ff; }
    .graph-node .kind {
      color: var(--faint);
      font-size: 7px;
      font-weight: 900;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .method { color: var(--cyan); font-weight: 900; }
    .graph-links {
      position: absolute;
      z-index: 1;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
      pointer-events: none;
    }
    .graph-links line {
      stroke: rgba(69,217,255,.29);
      stroke-width: .35;
      vector-effect: non-scaling-stroke;
      filter: drop-shadow(0 0 4px rgba(69,217,255,.22));
    }
    .graph-links line.supports, .graph-links line.documents {
      stroke: rgba(76,240,183,.34);
    }
    .graph-links line.runtime-context-for, .graph-links line.source-context-for {
      stroke: rgba(255,178,76,.38);
    }
    .graph-links line.reproduces-signal {
      stroke: rgba(76,240,183,.58);
      stroke-width: .55;
    }
    .graph-links line.attempted-reproduction {
      stroke: rgba(255,200,92,.42);
      stroke-dasharray: 2 1.5;
    }
    .graph-beam {
      position: absolute;
      top: 49%;
      left: 13%;
      width: 72%;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(69,217,255,.26), rgba(255,116,77,.3), transparent);
      transform: rotate(-9deg);
      transform-origin: center;
    }
    .graph-hub {
      position: absolute;
      top: 46%;
      left: 50%;
      display: grid;
      place-items: center;
      width: 72px;
      height: 72px;
      border: 1px solid rgba(255,178,76,.3);
      border-radius: 50%;
      color: var(--amber);
      background: rgba(12,23,36,.96);
      transform: translate(-50%, -50%);
      box-shadow: 0 0 55px rgba(255,116,77,.14);
      font-size: 9px;
      font-weight: 850;
      letter-spacing: .08em;
      text-align: center;
    }
    .stack { display: grid; gap: 14px; }
    .list { display: grid; }
    .list-row {
      display: grid;
      grid-template-columns: auto minmax(0,1fr) auto;
      align-items: center;
      gap: 11px;
      min-width: 0;
      padding: 12px 16px;
      border-bottom: 1px solid var(--stroke);
      background: transparent;
    }
    .list-row:last-child { border-bottom: 0; }
    button.list-row {
      width: 100%;
      border-top: 0;
      border-left: 0;
      border-right: 0;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }
    button.list-row:hover { background: rgba(69,217,255,.035); }
    .row-icon {
      display: grid;
      place-items: center;
      min-width: 35px;
      height: 28px;
      padding: 0 7px;
      border: 1px solid rgba(69,217,255,.16);
      border-radius: 7px;
      color: var(--cyan);
      background: rgba(69,217,255,.045);
      font: 8px/1 var(--vscode-editor-font-family, monospace);
      font-weight: 900;
    }
    .row-main { min-width: 0; }
    .row-title { overflow: hidden; font-size: 11px; font-weight: 720; text-overflow: ellipsis; white-space: nowrap; }
    .row-sub { margin-top: 4px; overflow: hidden; color: var(--faint); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
    .row-tail { color: var(--muted); font: 9px/1 var(--vscode-editor-font-family, monospace); }
    .severity {
      display: inline-flex;
      align-items: center;
      min-width: 54px;
      justify-content: center;
      padding: 5px 7px;
      border: 1px solid var(--stroke);
      border-radius: 6px;
      font-size: 8px;
      font-weight: 900;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .severity.critical, .severity.high { color: var(--danger); border-color: rgba(255,84,112,.24); background: rgba(255,84,112,.055); }
    .severity.medium { color: var(--warning); border-color: rgba(255,200,92,.22); background: rgba(255,200,92,.05); }
    .severity.low { color: var(--cyan); border-color: rgba(69,217,255,.2); background: rgba(69,217,255,.045); }
    .finding-actions { display: flex; gap: 5px; }
    .finding-actions button {
      padding: 5px 7px;
      border: 1px solid var(--stroke);
      border-radius: 6px;
      color: var(--muted);
      background: rgba(255,255,255,.02);
      font-size: 8px;
      cursor: pointer;
    }
    .finding-actions button:hover { color: var(--text); border-color: rgba(69,217,255,.28); }
    .finding-actions button.reproduce {
      border-color: rgba(245,193,91,.25);
      color: var(--amber);
      background: rgba(245,193,91,.055);
    }
    .finding-actions button.reproduce:hover {
      border-color: rgba(245,193,91,.46);
      background: rgba(245,193,91,.09);
    }
    .reproduction-lab {
      display: grid;
      grid-template-columns: auto minmax(0,1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 13px 16px;
      border-bottom: 1px solid var(--stroke);
      background:
        linear-gradient(90deg, rgba(76,240,183,.045), transparent 52%),
        rgba(255,255,255,.012);
    }
    .reproduction-mark {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border: 1px solid rgba(76,240,183,.22);
      border-radius: 10px;
      color: var(--mint);
      background: rgba(76,240,183,.055);
      font: 900 9px/1 var(--vscode-editor-font-family, monospace);
    }
    .reproduction-copy { min-width: 0; }
    .reproduction-copy b { display: block; font-size: 10px; letter-spacing: .02em; }
    .reproduction-copy span {
      display: block;
      margin-top: 4px;
      color: var(--faint);
      font-size: 9px;
      line-height: 1.45;
    }
    .reproduction-count {
      color: var(--mint);
      font: 800 9px/1 var(--vscode-editor-font-family, monospace);
      white-space: nowrap;
    }
    .empty-state { padding: 30px 18px; color: var(--faint); font-size: 11px; line-height: 1.6; text-align: center; }
    .health-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .health-stat {
      padding: 13px;
      border: 1px solid var(--stroke);
      border-radius: 10px;
      background: rgba(255,255,255,.017);
    }
    .health-stat b { display: block; font-size: 20px; letter-spacing: -.04em; }
    .health-stat span { display: block; margin-top: 4px; color: var(--faint); font-size: 8px; letter-spacing: .08em; text-transform: uppercase; }
    .repo-risk { display: grid; gap: 8px; margin-top: 14px; }
    .repo-card {
      display: grid;
      grid-template-columns: minmax(0,1fr) auto;
      gap: 10px;
      padding: 11px 12px;
      border: 1px solid var(--stroke);
      border-left: 2px solid var(--warning);
      border-radius: 9px;
      color: inherit;
      text-align: left;
      background: rgba(255,255,255,.018);
      cursor: pointer;
    }
    .repo-card.critical, .repo-card.high { border-left-color: var(--danger); }
    .repo-card:hover { border-top-color: rgba(69,217,255,.2); border-right-color: rgba(69,217,255,.2); border-bottom-color: rgba(69,217,255,.2); }
    .repo-card b { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .repo-card small { display: block; margin-top: 4px; color: var(--faint); font-size: 8px; }
    .repo-score { color: var(--amber); font: 11px/1 var(--vscode-editor-font-family, monospace); }
    .tool-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .tool-card {
      min-height: 135px;
      padding: 16px;
      border: 1px solid var(--stroke);
      border-radius: 12px;
      background: rgba(255,255,255,.016);
    }
    .tool-index { color: var(--amber); font: 8px/1 var(--vscode-editor-font-family, monospace); }
    .tool-card h3 { margin: 18px 0 7px; font-size: 12px; }
    .tool-card p { margin: 0; color: var(--faint); font-size: 9px; line-height: 1.55; }
    .tool-state { display: inline-block; margin-top: 13px; color: var(--mint); font-size: 8px; font-weight: 850; letter-spacing: .07em; text-transform: uppercase; }
    .footer {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      margin-top: 52px;
      padding-top: 20px;
      border-top: 1px solid var(--stroke);
      color: var(--faint);
      font-size: 9px;
    }
    .sidebar-mode .rail { display: none; }
    .sidebar-mode.app-shell { display: block; }
    .sidebar-mode .workspace { padding: 0 12px 32px; }
    .sidebar-mode .topbar {
      position: relative;
      grid-template-columns: 1fr auto;
      height: 62px;
      margin: 0 -12px;
      padding: 0 12px;
    }
    .sidebar-mode .wordmark img { display: block; }
    .sidebar-mode .wordmark-slash,
    .sidebar-mode .wordmark-context,
    .sidebar-mode .product-badge,
    .sidebar-mode .command-bar { display: none; }
    .sidebar-mode .mission-strip { margin-top: 12px; }
    .sidebar-mode .hero { grid-template-columns: 1fr; min-height: 0; padding: 32px 0 28px; }
    .sidebar-mode .radar { display: none; }
    .sidebar-mode h1 { font-size: 36px; }
    .sidebar-mode .hero-copy { font-size: 12px; }
    .sidebar-mode .metrics { grid-template-columns: repeat(2, 1fr); }
    .sidebar-mode .metric { border-bottom: 1px solid var(--stroke); }
    .sidebar-mode .metric:nth-child(2n) { border-right: 0; }
    .sidebar-mode .metric:nth-last-child(-n+2) { border-bottom: 0; }
    .sidebar-mode .bento,
    .sidebar-mode .health-grid,
    .sidebar-mode .tool-grid { grid-template-columns: 1fr; }
    .sidebar-mode .section-head { align-items: start; flex-direction: column; }
    .sidebar-mode .section-note { text-align: left; }
    .sidebar-mode .graph-node { max-width: 58%; }
    @media (max-width: 980px) {
      .app-shell { grid-template-columns: 64px minmax(0,1fr); }
      .workspace { padding-right: 18px; padding-left: 18px; }
      .topbar { margin: 0 -18px; padding: 0 20px; grid-template-columns: 1fr auto; }
      .command-bar { display: none; }
      .hero { grid-template-columns: 1fr; }
      .radar { display: none; }
      .metrics { grid-template-columns: repeat(3, 1fr); }
      .metric:nth-child(3n) { border-right: 0; }
      .metric:nth-child(-n+3) { border-bottom: 1px solid var(--stroke); }
      .bento { grid-template-columns: 1fr; }
    }
    @media (max-width: 660px) {
      .rail { display: none; }
      .app-shell { display: block; }
      .topbar { grid-template-columns: 1fr auto; }
      .wordmark img { display: block; }
      .wordmark-slash, .wordmark-context, .product-badge { display: none; }
      .hero { min-height: 0; padding-top: 42px; }
      h1 { font-size: 42px; }
      .metrics { grid-template-columns: repeat(2,1fr); }
      .metric, .metric:nth-child(3) { border-right: 1px solid var(--stroke); border-bottom: 1px solid var(--stroke); }
      .metric:nth-child(2n) { border-right: 0; }
      .metric:nth-last-child(-n+2) { border-bottom: 0; }
      .reproduction-lab { grid-template-columns: auto minmax(0,1fr); }
      .reproduction-count { grid-column: 2; }
      .finding-row { grid-template-columns: auto minmax(0,1fr); }
      .finding-row .row-title,
      .finding-row .row-sub {
        overflow: visible;
        line-height: 1.4;
        text-overflow: clip;
        white-space: normal;
      }
      .finding-row .finding-actions {
        grid-column: 1 / -1;
        flex-wrap: wrap;
        justify-content: flex-start;
        padding-left: 65px;
      }
      .health-grid, .tool-grid { grid-template-columns: 1fr; }
      .section-head { align-items: start; flex-direction: column; }
      .section-note { text-align: left; }
    }
    @keyframes sweep { to { transform: rotate(360deg); } }
    @keyframes pulse { 50% { opacity: .35; transform: scale(.75); } }
    .twin-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border-bottom: 1px solid var(--stroke); }
    .twin-stat { min-width: 0; padding: 16px; border-right: 1px solid var(--stroke); background: rgba(255,255,255,.012); }
    .twin-stat:last-child { border-right: 0; }
    .twin-stat b { display: block; color: var(--bright); font-family: 'JetBrains Mono', monospace; font-size: 22px; }
    .twin-stat span { display: block; margin-top: 5px; color: var(--faint); font-size: 9px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
    .twin-layout { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(240px, .8fr); }
    .twin-paths { min-height: 140px; border-right: 1px solid var(--stroke); }
    .twin-path { display: grid; grid-template-columns: 58px minmax(0,1fr) auto; gap: 12px; align-items: center; width: 100%; padding: 13px 16px; border: 0; border-bottom: 1px solid var(--stroke); color: var(--copy); text-align: left; background: transparent; }
    .twin-score { color: var(--amber); font-family: 'JetBrains Mono', monospace; font-weight: 900; }
    .twin-path-copy { min-width: 0; }
    .twin-path-copy b, .twin-path-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .twin-path-copy b { color: var(--bright); font-size: 11px; }
    .twin-path-copy span { margin-top: 4px; color: var(--faint); font-size: 10px; }
    .twin-status { border: 1px solid var(--stroke); border-radius: 999px; padding: 4px 7px; color: var(--muted); font-size: 8px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
    .protocol-cloud { display: flex; align-content: flex-start; flex-wrap: wrap; gap: 7px; padding: 16px; }
    .protocol-chip { border: 1px solid rgba(69,217,255,.18); border-radius: 999px; padding: 6px 8px; color: #8fe8ff; background: rgba(69,217,255,.04); font: 800 9px 'JetBrains Mono', monospace; text-transform: uppercase; }
    .trust-strip { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 1px; margin-bottom: 16px; border: 1px solid var(--stroke); background: var(--stroke); }
    .trust-cell { padding: 14px; background: var(--panel); }
    .trust-cell b { display: block; color: var(--bright); font: 900 18px 'JetBrains Mono', monospace; }
    .trust-cell span { color: var(--faint); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
    .evidence-bento { grid-template-columns: minmax(0,.85fr) minmax(0,1.15fr); grid-template-areas: 'org brain' 'runtime brain'; align-items: start; }
    .org-posture { grid-area: org; }
    .mcp-brain { grid-area: brain; }
    .runtime-trust { grid-area: runtime; }
    .runtime-trust .row-title, .runtime-trust .row-sub { display: block; }
    @media (max-width: 900px) {
      .twin-grid { grid-template-columns: repeat(3, minmax(0,1fr)); }
      .twin-layout { grid-template-columns: 1fr; }
      .twin-paths { border-right: 0; border-bottom: 1px solid var(--stroke); }
      .trust-strip { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .evidence-bento { grid-template-columns: 1fr; grid-template-areas: 'org' 'runtime' 'brain'; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; scroll-behavior: auto !important; }
    }
    ${hawkVisualSystemCss}
  </style>
</head>
<body class="mission-ui">
  <div class="ambient-grid"></div>
  <div class="app-shell ${mode === 'sidebar' ? 'sidebar-mode' : 'panel-mode'}">
    <aside class="rail" aria-label="Hawk areas">
      <div class="rail-brand">
        <div class="rail-logo"><img src="${logoUri}" alt="Hawk"></div>
        <div class="rail-wordmark"><strong>HAWK</strong><span>SECURITY IDE</span></div>
      </div>
      <nav class="rail-nav">
        ${navButton('overview', 'Overview', 'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z', true)}
        ${navButton('ai', 'Hawk AI', 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M9 9h6v6H9z')}
        ${navButton('surface', 'Attack surface', 'M4 6h16M7 12h10M9 18h6')}
        ${navButton('findings-section', 'Findings', 'M12 3 2.8 20h18.4L12 3zM12 9v4M12 17h.01')}
        ${navButton('traffic-section', 'Traffic', 'M3 12h4l3-7 4 14 3-7h4')}
        ${navButton('evidence', 'Evidence & MCP', 'M8 3h8l4 4v14H4V3h4zM8 3v5h8V3M8 13h8M8 17h5')}
      </nav>
      <button class="nav-button rail-bottom" data-action="refresh" title="Refresh local activity" aria-label="Refresh local activity">
        <svg viewBox="0 0 24 24"><path d="M20 6v5h-5M4 18v-5h5M6.1 8.2A7 7 0 0 1 18.7 7M17.9 15.8A7 7 0 0 1 5.3 17"/></svg>
        <span class="nav-copy">Refresh</span>
      </button>
      <div class="rail-status"><span></span><div><b>LOCAL CORE</b><small>Private / online</small></div></div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="wordmark">
          <img src="${logoUri}" alt="">
          <span class="wordmark-title">HAWK</span>
          <span class="product-badge">SECURITY IDE</span>
          <span class="wordmark-slash">/</span>
          <span class="wordmark-context">Mission Control</span>
        </div>
        <button class="command-bar" data-action="open-agent" aria-label="Open Hawk AI command center">
          <svg viewBox="0 0 24 24" fill="none"><path d="m5 5 4 4-4 4M11 15h8" stroke-width="1.8"/></svg>
          <span class="command-copy">Ask Hawk to investigate this workspace...</span>
          <span class="key">Ctrl K</span>
        </button>
        <div id="system-state" class="system-state">
          <span class="system-dot"></span>
          <span id="system-label">CONNECTING</span>
        </div>
      </header>

      <main class="content" id="overview">
        <div class="mission-strip">
          <span class="pulse"></span>
          <strong>LOCAL WORKSPACE CORE</strong>
          <span id="status-message">Starting Hawk workspace services...</span>
        </div>

        <section class="hero">
          <div>
            <div class="eyebrow">Workspace command / private by default</div>
            <h1>Map the risk.<br><span class="hero-accent">Prove the fix.</span></h1>
            <p class="hero-copy">
              Hawk joins source paths, observed requests, findings and change evidence in one operating view.
              Every decision stays traceable from the first signal to the reviewed patch.
            </p>
            <div class="hero-actions">
              <button class="button primary" data-action="open-agent">Open Hawk AI <span>↗</span></button>
              <button class="button primary" data-action="autopilot">Run Autopilot</button>
              <button class="button secondary" data-action="workspace-scan">Run approved scan</button>
              <button class="button ghost" data-action="index">Refresh surface</button>
            </div>
            <div class="hero-proofline" aria-label="Hawk trust boundaries">
              <span>Local-first intelligence</span>
              <span>Zero-network reproduction</span>
              <span>Hash-bound approvals</span>
            </div>
          </div>
          <aside class="command-focus" aria-label="Current security posture">
            <div class="focus-head">
              <span>LIVE PRIORITY</span>
              <b><i></i> WORKSPACE SYNCED</b>
            </div>
            <div class="focus-posture">
              <div class="posture-ring"><strong id="focus-score">--</strong><small>POSTURE</small></div>
              <div class="focus-copy">
                <span>Highest-confidence signal</span>
                <strong id="focus-title">Waiting for local audit</strong>
                <small id="focus-meta">Run Autopilot to correlate source, traffic and proof.</small>
              </div>
            </div>
            <div class="focus-stats">
              <div><b id="focus-signal-count">0</b><span>signals</span></div>
              <div><b id="focus-proof-count">0</b><span>reproduced</span></div>
              <div><b>0</b><span>silent actions</span></div>
            </div>
            <button class="focus-action" data-action="autopilot"><span>Start evidence run</span><b>CTRL + ENTER</b></button>
          </aside>
        </section>

        <section class="metrics" aria-label="Local security activity">
          ${metric('Source surface', 'metric-files', 'files indexed')}
          ${metric('API exposure', 'metric-routes', 'routes mapped')}
          ${metric('Observed traffic', 'metric-traffic', 'live + imported records')}
          ${metric('Signals', 'metric-findings', 'need validation')}
          ${metric('Sandbox proof', 'metric-reproductions', 'offline reproductions')}
          ${metric('Posture index', 'metric-posture', 'local evidence score', 'risk')}
        </section>

        <section class="section" id="ai">
          <div class="section-head">
            <div><div class="section-kicker">01 / Reason</div><h2>Hawk AI workspace</h2></div>
            <div class="section-note">Tasks stay bound to the trusted workspace. Security actions remain explicit and approval-gated.</div>
          </div>
          <div class="card ai-card">
            <div class="card-head">
              <div class="card-title">Operator session <span>workspace-aware</span></div>
              <div class="status-pill">● agent ready</div>
            </div>
            <div class="card-body">
              <div class="ai-intro">
                <div class="ai-orb"><img src="${logoUri}" alt=""></div>
                <div class="ai-message"><strong>One task, complete workspace context, exact review controls.</strong><br>Give Hawk an objective. It will plan the work, preserve the evidence and stop before any sensitive action.</div>
              </div>
              <div class="suggestions">
                <button class="suggestion" data-prompt="Review the authentication boundary and rank the most credible abuse paths.">Review auth boundary</button>
                <button class="suggestion" data-prompt="Correlate captured requests with the source routes that handle them.">Trace request to source</button>
                <button class="suggestion" data-prompt="Build an evidence-backed remediation plan for the highest-risk findings.">Plan secure fixes</button>
                <button class="suggestion" data-prompt="Explain the workspace attack surface as a concise threat model.">Generate threat model</button>
              </div>
              <div class="composer">
                <textarea id="mission-prompt" aria-label="Hawk AI task" placeholder="Describe the security outcome you want..."></textarea>
                <div class="composer-row">
                  <div class="context-chips">
                    <span class="context-chip"># active file</span>
                    <span class="context-chip"># git diff</span>
                    <span class="context-chip"># diagnostics</span>
                    <span class="context-chip"># traffic</span>
                  </div>
                  <button id="send-mission" class="send-button" aria-label="Open task in Hawk AI">↗</button>
                </div>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head">
              <div class="card-title">Hawk Coding Core <span>local-first / editor-native</span></div>
              <div class="hero-actions">
                <button class="button small primary" data-action="setup-local-ai">Set up local AI</button>
                <button class="button small secondary" data-action="configure-llm">Configure provider</button>
                <button class="button small secondary" data-action="coding-search">Semantic search</button>
                <button class="button small secondary" data-action="coding-index">Rebuild index</button>
                <button class="button small ghost" data-action="coding-benchmark">Run benchmark</button>
                <button class="button small ghost" data-action="check-updates">Check updates</button>
              </div>
            </div>
            <div class="card-body">
              <div class="tool-grid">
                ${toolCard('LOCAL/00', 'Verified local AI', 'Hawk installs the official signed Ollama runtime, recommends a hardware-sized coding model and configures the private loopback route.')}
                ${toolCard('TAB/01', 'Hawk Tab', 'Private inline completions use prefix, suffix and related workspace symbols with cancellable low-latency requests.')}
                ${toolCard('INDEX/02', 'Semantic workspace', 'A bounded local symbol-and-code index ranks implementations without sending the repository to an embedding service.')}
                ${toolCard('EDIT/03', 'Review checkpoints', 'Every multi-file patch stays isolated, hash-bound, checkpointed, testable and reversible before Apply.')}
                ${toolCard('TERM/04', 'Task terminal', 'Open a streaming terminal directly inside the review worktree without touching the operator workspace.')}
                ${toolCard('LANES/05', 'Parallel coding lanes', 'Architecture, implementation and verification agents run in separate worktrees; apply only the strongest candidate.')}
                ${toolCard('ROUTE/06', 'Smart model router', 'Explicit BYOK fast, reasoning and security fallbacks preserve streaming and never invent a paid route.')}
              </div>
            </div>
          </div>
        </section>

        <section class="section" id="surface">
          <div class="section-head">
            <div><div class="section-kicker">02 / Observe</div><h2>Code ↔ request map</h2></div>
            <div class="hero-actions">
              <button class="button small secondary" data-action="import-har">Import HAR</button>
              <button class="button small primary" data-action="pair-capture">Pair live capture</button>
              <button class="button small secondary" data-action="audit">Audit code</button>
              <button class="button small primary" data-action="autopilot">Run Autopilot</button>
              <button class="button small ghost" data-action="refresh">Refresh</button>
            </div>
          </div>
          <div class="bento">
            <article class="card surface-graph">
              <div class="card-head">
                <div class="card-title">Source-to-request graph <span id="graph-caption">waiting for index</span></div>
                <div class="status-pill">local graph</div>
              </div>
              <div id="route-graph" class="graph-canvas">
                <div class="graph-beam"></div>
                <div class="graph-hub">HAWK<br>GRAPH</div>
              </div>
            </article>
            <div class="stack">
              <article class="card" id="traffic-section">
                <div class="card-head"><div class="card-title">Traffic pulse <span id="traffic-mode">waiting</span></div><div class="button-row"><button class="button small secondary" data-action="pair-capture">Pair</button><button class="button small ghost" data-action="identity-replay">Replay</button></div></div>
                <div id="traffic-list" class="list"><div class="empty-state">Pair a Hawk capture companion or import a redacted HAR.</div></div>
              </article>
              <article class="card">
                <div class="card-head"><div class="card-title">Route inventory</div><span id="route-count" class="row-tail">0 mapped</span></div>
                <div id="route-list" class="list"><div class="empty-state">Index the workspace to map API entry points.</div></div>
              </article>
            </div>
          </div>
          <article class="card" style="margin-top:16px">
            <div class="card-head">
              <div class="card-title">Hawk Attack Twin <span id="twin-caption">waiting for workspace model</span></div>
              <div class="status-pill">evidence-aware / no fake verdicts</div>
            </div>
            <div class="twin-grid">
              <div class="twin-stat"><b id="twin-entry">0</b><span>entry points</span></div>
              <div class="twin-stat"><b id="twin-protocols">0</b><span>protocol surfaces</span></div>
              <div class="twin-stat"><b id="twin-boundaries">0</b><span>trust boundaries</span></div>
              <div class="twin-stat"><b id="twin-hypotheses">0</b><span>hypotheses</span></div>
              <div class="twin-stat"><b id="twin-reproduced">0</b><span>reproduced</span></div>
              <div class="twin-stat"><b id="twin-score">0</b><span>highest score</span></div>
            </div>
            <div class="twin-layout">
              <div id="twin-paths" class="twin-paths"><div class="empty-state">Run Autopilot to build the evidence-aware attack model.</div></div>
              <div id="protocol-cloud" class="protocol-cloud"><span class="protocol-chip">HTTP ROUTES</span></div>
            </div>
          </article>
        </section>

        <section class="section" id="findings-section">
          <div class="section-head">
            <div><div class="section-kicker">03 / Decide</div><h2>Prioritized security queue</h2></div>
            <div class="section-note">Hawk labels static detections as signals until a human or authorized validation workflow confirms impact.</div>
          </div>
          <article class="card">
            <div class="card-head">
              <div class="card-title">Investigation queue <span>ranked by severity and evidence</span></div>
              <button class="button small primary" data-action="audit">Run local audit</button>
            </div>
            <div class="reproduction-lab">
              <div class="reproduction-mark">LAB</div>
              <div class="reproduction-copy">
                <b>Automatic sandbox reproduction</b>
                <span>Baseline → safe control → deterministic signal. Read-only filesystems, zero network, bounded Docker runtime.</span>
              </div>
              <div id="reproduction-count" class="reproduction-count">0 attempts</div>
            </div>
            <div id="finding-list" class="list"><div class="empty-state">No local audit signals yet. Run an audit to populate the queue.</div></div>
          </article>
        </section>

        <section class="section" id="evidence">
          <div class="section-head">
            <div><div class="section-kicker">04 / Prove</div><h2>Evidence, policy & agent mesh</h2></div>
            <div class="hero-actions">
              <button class="button small secondary" data-action="sync-hawk">Sync GitHub health</button>
              <button class="button small secondary" data-action="configure-hawk-sync">Configure sync</button>
              <button class="button small secondary" data-action="evidence-pack">Build evidence pack</button>
              <button class="button small primary" data-action="plan-mission">Plan governed mission</button>
              <button class="button small ghost" data-action="copy-mcp">Copy MCP config</button>
            </div>
          </div>
          <div class="bento evidence-bento">
            <article class="card org-posture">
              <div class="card-head"><div class="card-title">Organization posture <span id="health-org">no report imported</span></div><button class="button small secondary" data-action="import-hawk">Import health</button></div>
              <div class="card-body">
                <div id="health-grid" class="health-grid">
                  ${healthStat('—', 'Repositories')}
                  ${healthStat('—', 'Governance')}
                  ${healthStat('—', 'Critical SLA')}
                  ${healthStat('—', 'SBOM coverage')}
                </div>
                <div id="repo-risk" class="repo-risk"></div>
              </div>
            </article>
            <article class="card mcp-brain">
              <div class="card-head"><div class="card-title">Smart MCP Brain <span>governed agent fabric</span></div><div class="status-pill">brain online</div></div>
              <div class="card-body">
                <div class="trust-strip">
                  <div class="trust-cell"><b id="fleet-online">0</b><span>fleet nodes online</span></div>
                  <div class="trust-cell"><b id="fleet-slots">0</b><span>remote slots ready</span></div>
                  <div class="trust-cell"><b id="mcp-pins">0</b><span>signed MCP pins</span></div>
                  <div class="trust-cell"><b id="memory-active">0</b><span>active memories</span></div>
                </div>
                <div class="tool-grid">
                  ${toolCard('BRAIN/01', 'Intent & scope', 'Typed goals bind repositories, hosts, identities, actions, budgets and success criteria.')}
                  ${toolCard('BRAIN/02', 'Agent DAG', 'Immutable plans route specialized agents and models across safe parallel groups.')}
                  ${toolCard('BRAIN/03', 'Durable runtime', 'Leases, heartbeats, pause, resume, cancellation and restart-safe event history.')}
                  ${toolCard('PROOF/04', 'ProofGraph', 'Code, routes, requests, findings, evidence, patches and tests share one graph.')}
                  ${toolCard('PROOF/05', 'Independent verifier', 'Signals stay unverified until reproduction, identity, impact and scope gates pass.')}
                  ${toolCard('TRUST/06', 'MCP Sentinel', 'Tool poisoning, secret output, trust drift and prompt injection are inspected locally.')}
                  ${toolCard('MESH/07', 'Distributed agent mesh', 'Capability-aware scheduling scores critical path, health, CPU, RAM and load; leases recover or rebalance Docker agents after failure.')}
                  ${toolCard('LAB/08', 'A2A & Eval Lab', 'Task envelopes interoperate locally; same-model baselines prove whether Hawk adds value.')}
                </div>
              </div>
            </article>
            <article class="card runtime-trust">
              <div class="card-head"><div class="card-title">Runtime trust posture <span>live local control plane</span></div><div class="status-pill">fail closed</div></div>
              <div class="card-body">
                <div class="list">
                  <div class="list-row"><span class="row-icon">AUTO</span><span><b class="row-title">Autopilot missions</b><small class="row-sub">Passive stages stop at reproduction gates</small></span><span id="autopilot-runs" class="row-tail">0 runs</span></div>
                  <div class="list-row"><span class="row-icon">MCP</span><span><b class="row-title">Artifact trust verdicts</b><small class="row-sub">SHA-256, Ed25519 and publisher pinning</small></span><span id="mcp-verdicts" class="row-tail">0 checked</span></div>
                  <div class="list-row"><span class="row-icon">MEM</span><span><b class="row-title">Provenance refresh</b><small class="row-sub">Changed citations leave retrieval immediately</small></span><span id="memory-stale" class="row-tail">0 stale</span></div>
                </div>
              </div>
            </article>
          </div>
        </section>

        <footer class="footer">
          <span>HAWK SECURITY IDE / LOCAL-FIRST / EVIDENCE-DRIVEN</span>
          <span>AUTHORIZED WORKSPACES ONLY</span>
        </footer>
      </main>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const q = (selector) => document.querySelector(selector);
    const all = (selector) => Array.from(document.querySelectorAll(selector));

    all('[data-action]').forEach((element) => {
      element.addEventListener('click', () => vscode.postMessage({ action: element.dataset.action }));
    });
    all('.nav-button[data-target]').forEach((button) => {
      button.addEventListener('click', () => {
        all('.nav-button').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        q('#' + button.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    all('[data-prompt]').forEach((button) => {
      button.addEventListener('click', () => {
        q('#mission-prompt').value = button.dataset.prompt || '';
        q('#mission-prompt').focus();
      });
    });
    q('#send-mission').addEventListener('click', () => {
      const prompt = q('#mission-prompt').value.trim();
      vscode.postMessage({ action: 'open-agent', prompt });
    });
    q('#mission-prompt').addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        q('#send-mission').click();
      }
    });
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'state') return;
      renderState(event.data.state);
    });
    vscode.postMessage({ action: 'ready' });

    function renderState(state) {
      const connected = Boolean(state.connected);
      q('#system-state').className = 'system-state ' + (connected ? 'online' : 'offline');
      q('#system-label').textContent = connected ? 'LOCAL CORE ONLINE' : 'LOCAL CORE OFFLINE';
      q('#status-message').textContent = state.message || 'No local activity yet.';
      const inventory = state.inventory;
      const traffic = state.traffic;
      const findings = Array.isArray(state.findings) ? state.findings : [];
      const reproductions = Array.isArray(state.reproductions) ? state.reproductions : [];
      setText('#metric-files', inventory?.sourceFiles ?? 0);
      setText('#metric-routes', inventory?.routes?.length ?? 0);
      setText('#metric-traffic', traffic?.requests?.length ?? 0);
      setText(
        '#traffic-mode',
        traffic?.live
          ? (traffic.source === 'mixed' ? 'live + HAR' : 'live')
          : (traffic?.source === 'har' ? 'HAR import' : 'waiting'),
      );
      setText('#metric-findings', findings.length);
      setText('#focus-signal-count', findings.length);
      setText(
        '#metric-reproductions',
        reproductions.filter((result) => result.status === 'reproduced').length,
      );
      setText(
        '#focus-proof-count',
        reproductions.filter((result) => result.status === 'reproduced').length,
      );
      setText(
        '#reproduction-count',
        reproductions.length + (reproductions.length === 1 ? ' attempt' : ' attempts'),
      );
      const currentPosture = postureScore(inventory, traffic, findings, state.hawkHealth);
      setText('#metric-posture', currentPosture);
      setText('#focus-score', currentPosture);
      renderRoutes(inventory?.routes || [], traffic, state.securityGraph);
      renderAttackTwin(state.attackTwin, state.protocols);
      renderTraffic(traffic);
      renderFindings(findings, reproductions);
      renderHealth(state.hawkHealth);
      setText('#fleet-online', state.fleet?.summary?.online ?? 0);
      setText('#fleet-slots', state.fleet?.summary?.availableSlots ?? 0);
      setText('#mcp-pins', state.mcpTrust?.pins ?? 0);
      setText('#memory-active', state.memory?.active ?? 0);
      setText(
        '#autopilot-runs',
        (state.autopilotRuns?.length ?? 0) + ((state.autopilotRuns?.length ?? 0) === 1 ? ' run' : ' runs'),
      );
      setText('#mcp-verdicts', (state.mcpTrust?.verdicts ?? 0) + ' checked');
      setText('#memory-stale', (state.memory?.stale ?? 0) + ' stale');
    }

    function renderAttackTwin(twin, protocols) {
      const summary = twin?.summary || {};
      setText('#twin-entry', summary.entryPoints ?? 0);
      setText('#twin-protocols', summary.protocolSurfaces ?? 0);
      setText('#twin-boundaries', summary.trustBoundaries ?? 0);
      setText('#twin-hypotheses', summary.hypotheses ?? 0);
      setText('#twin-reproduced', summary.reproducedPaths ?? 0);
      setText('#twin-score', summary.highestScore ?? 0);
      setText(
        '#twin-caption',
        twin
          ? ((twin.paths?.length || 0) + ' prioritized paths / ' + (summary.verifiedPaths || 0) + ' independently verified')
          : 'waiting for workspace model',
      );
      const pathRoot = q('#twin-paths');
      pathRoot.replaceChildren();
      const paths = Array.isArray(twin?.paths) ? twin.paths.slice(0, 6) : [];
      if (!paths.length) {
        pathRoot.append(empty('No modeled path yet. Run Autopilot or refresh the surface.'));
      } else {
        paths.forEach((path) => {
          const row = document.createElement('button');
          row.className = 'twin-path';
          const copy = document.createElement('span');
          copy.className = 'twin-path-copy';
          copy.append(
            textElement('b', path.title),
            textElement('span', path.protocol + ' / ' + (path.sourceFiles?.[0] || 'workspace')),
          );
          row.append(
            textElement('span', String(path.score).padStart(2, '0') + '/100', 'twin-score'),
            copy,
            textElement('span', path.status, 'twin-status'),
          );
          const file = path.sourceFiles?.[0];
          if (file) {
            row.addEventListener('click', () =>
              vscode.postMessage({ action: 'open-graph-node', file, line: 1 }),
            );
          }
          pathRoot.append(row);
        });
      }
      const cloud = q('#protocol-cloud');
      cloud.replaceChildren();
      const entries = Object.entries(protocols?.summary?.byKind || {}).sort(
        (left, right) => Number(right[1]) - Number(left[1]),
      );
      if (!entries.length) cloud.append(textElement('span', 'HTTP ROUTES ONLY', 'protocol-chip'));
      entries.forEach(([kind, count]) =>
        cloud.append(textElement('span', kind + ' ' + count, 'protocol-chip')),
      );
    }

    function renderRoutes(routes, traffic, securityGraph) {
      setText('#route-count', routes.length + ' mapped');
      const summary = securityGraph?.summary;
      setText(
        '#graph-caption',
        summary
          ? summary.nodes + ' nodes / ' + summary.edges + ' links / ' + (summary.reproductions || 0) + ' reproduced'
          : (routes.length ? routes.length + ' routes in local graph' : 'waiting for index'),
      );
      const graph = q('#route-graph');
      graph.querySelectorAll('.graph-node').forEach((node) => node.remove());
      graph.querySelector('.graph-links')?.remove();
      const graphNodes = Array.isArray(securityGraph?.nodes)
        ? securityGraph.nodes.slice(0, 5)
        : routes.slice(0, 5).map((route) => ({
            kind: 'route',
            label: route.method + ' ' + route.path,
            attributes: { file: route.file, line: route.line, path: route.path },
          }));
      const positions = [
        { x: 18, y: 20, style: { top: '16%', left: '7%' } },
        { x: 42, y: 46, style: { top: '41%', left: '29%' } },
        { x: 82, y: 20, style: { top: '16%', right: '6%' } },
        { x: 23, y: 81, style: { bottom: '14%', left: '12%' } },
        { x: 79, y: 82, style: { right: '13%', bottom: '12%' } },
      ];
      const visiblePositions = new Map(
        graphNodes.map((graphNode, index) => [graphNode.id, positions[index]]),
      );
      const graphLinks = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      graphLinks.setAttribute('class', 'graph-links');
      graphLinks.setAttribute('viewBox', '0 0 100 100');
      graphLinks.setAttribute('preserveAspectRatio', 'none');
      (securityGraph?.edges || []).forEach((edge) => {
        const from = visiblePositions.get(edge.from);
        const to = visiblePositions.get(edge.to);
        if (!from || !to) return;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(from.x));
        line.setAttribute('y1', String(from.y));
        line.setAttribute('x2', String(to.x));
        line.setAttribute('y2', String(to.y));
        line.setAttribute('class', edge.relation);
        graphLinks.append(line);
      });
      graph.append(graphLinks);
      graphNodes.forEach((graphNode, index) => {
        const node = document.createElement('button');
        const position = positions[index];
        if (position) Object.assign(node.style, position.style);
        const path = String(graphNode.attributes?.path || '');
        const observed =
          graphNode.kind === 'request' ||
          (graphNode.kind === 'route' && isRouteObserved(path, traffic?.requests || []));
        node.className = 'graph-node ' + graphNode.kind + (observed ? ' observed' : '');
        node.title = graphNode.kind + ' / ' + graphNode.label;
        node.append(
          textElement('span', graphNode.kind, 'kind'),
          textElement('span', graphNode.label),
        );
        const file = graphNode.attributes?.file;
        if (typeof file === 'string' && file) {
          node.addEventListener('click', () =>
            vscode.postMessage({
              action: 'open-graph-node',
              file,
              line:
                typeof graphNode.attributes?.line === 'number'
                  ? graphNode.attributes.line
                  : 1,
            }),
          );
        } else {
          node.disabled = true;
        }
        graph.append(node);
      });
      const list = q('#route-list');
      list.replaceChildren();
      if (!routes.length) {
        list.append(empty('Index the workspace to map API entry points.'));
        return;
      }
      routes.slice(0, 8).forEach((route) => {
        const observed = isRouteObserved(route.path, traffic?.requests || []);
        const row = document.createElement('button');
        row.className = 'list-row';
        row.append(
          textElement('span', route.method, 'row-icon'),
          rowCopy(
            route.path,
            route.file + ':' + route.line + (observed ? ' · observed in traffic' : ''),
          ),
          textElement('span', observed ? 'LIVE' : route.framework || 'route', 'row-tail'),
        );
        row.addEventListener('click', () => vscode.postMessage({ action: 'open-route', route }));
        list.append(row);
      });
    }

    function renderTraffic(traffic) {
      const list = q('#traffic-list');
      list.replaceChildren();
      const requests = traffic?.requests || [];
      if (!requests.length) {
        list.append(empty('Pair a Hawk capture companion or import a redacted HAR.'));
        return;
      }
      requests.slice(0, 6).forEach((request) => {
        const row = document.createElement('div');
        row.className = 'list-row';
        row.append(
          textElement('span', request.method, 'row-icon'),
          rowCopy(
            safeUrl(request.url),
            (request.source || 'captured') +
              (typeof request.elapsedMs === 'number'
                ? ' · ' + Math.round(request.elapsedMs) + ' ms'
                : ''),
          ),
          textElement('span', String(request.status || '—'), 'row-tail'),
        );
        list.append(row);
      });
    }

    function renderFindings(findings, reproductions) {
      const list = q('#finding-list');
      list.replaceChildren();
      if (!findings.length) {
        setText('#focus-title', 'No local signals yet');
        setText('#focus-meta', 'Run Autopilot to correlate source, traffic and proof.');
        list.append(empty('No local audit signals yet. Run an audit to populate the queue.'));
        return;
      }
      const lead = findings[0];
      setText('#focus-title', lead.title || 'Security signal ready for review');
      setText(
        '#focus-meta',
        (lead.severity || 'unranked').toUpperCase() +
          ' / ' +
          (lead.source ? lead.source.file + ':' + lead.source.line : 'manual validation required'),
      );
      findings.forEach((finding) => {
        const row = document.createElement('div');
        row.className = 'list-row finding-row';
        const severity = textElement('span', finding.severity, 'severity ' + finding.severity);
        const latestReproduction = reproductions.find((result) => result.findingId === finding.id);
        const source =
          (finding.source ? finding.source.file + ':' + finding.source.line : 'manual validation required') +
          (latestReproduction
            ? ' / sandbox ' + latestReproduction.status + ' / still unverified'
            : ' / reproduction not run');
        const actions = document.createElement('div');
        actions.className = 'finding-actions';
        if (finding.source) {
          actions.append(actionButton('Open source', () => vscode.postMessage({ action: 'open-finding', finding })));
          const reproduce = actionButton('Reproduce', () => vscode.postMessage({ action: 'reproduce', finding }));
          reproduce.className = 'reproduce';
          actions.append(reproduce);
        }
        actions.append(actionButton('Retest', () => vscode.postMessage({ action: 'retest', finding })));
        row.append(severity, rowCopy(finding.title, source), actions);
        list.append(row);
      });
    }

    function renderHealth(report) {
      const grid = q('#health-grid');
      const repoRisk = q('#repo-risk');
      repoRisk.replaceChildren();
      if (!report) {
        setText('#health-org', 'no report imported');
        grid.replaceChildren(
          healthNode('—', 'Repositories'),
          healthNode('—', 'Governance'),
          healthNode('—', 'Critical SLA'),
          healthNode('—', 'SBOM coverage'),
        );
        return;
      }
      const summary = report.summary || {};
      setText('#health-org', (report.organization || 'organization') + ' / imported locally');
      grid.replaceChildren(
        healthNode(summary.repositories ?? 0, 'Repositories'),
        healthNode(score(summary.governanceScore), 'Governance'),
        healthNode(summary.overdueSecurityAlerts ?? 0, 'Critical SLA'),
        healthNode(summary.sbomRepositories ?? 0, 'SBOM repos'),
      );
      (report.priorityQueue || []).slice(0, 4).forEach((repository) => {
        const card = document.createElement('button');
        card.className = 'repo-card ' + repository.level;
        const copy = document.createElement('div');
        copy.append(
          textElement('b', repository.name),
          textElement('small', (repository.reasons || []).slice(0, 2).join(' · ') || 'Risk evidence available'),
        );
        card.append(copy, textElement('span', String(repository.score), 'repo-score'));
        if (repository.url) {
          card.addEventListener('click', () => vscode.postMessage({ action: 'open-hawk-repo', url: repository.url }));
        }
        repoRisk.append(card);
      });
    }

    function postureScore(inventory, traffic, findings, report) {
      if (!inventory && !traffic && !report) return '—';
      const base = report?.summary?.governanceScore ?? 82;
      const penalty = findings.reduce((total, finding) => {
        if (finding.severity === 'critical') return total + 12;
        if (finding.severity === 'high') return total + 7;
        if (finding.severity === 'medium') return total + 3;
        return total + 1;
      }, 0);
      return Math.max(0, Math.min(100, base - penalty)) + '/100';
    }
    function safeUrl(value) {
      try {
        const url = new URL(value);
        return url.pathname + url.search;
      } catch {
        return String(value || 'request');
      }
    }
    function isRouteObserved(routePath, requests) {
      const routeParts = String(routePath).split('/').filter(Boolean);
      return requests.some((request) => {
        let pathname;
        try {
          pathname = new URL(request.url).pathname;
        } catch {
          pathname = String(request.url || '').split('?')[0];
        }
        const requestParts = pathname.split('/').filter(Boolean);
        return routeParts.length === requestParts.length && routeParts.every((part, index) => {
          return part.startsWith(':') || part === '*' || part === requestParts[index];
        });
      });
    }
    function score(value) { return typeof value === 'number' ? value + '/100' : '—'; }
    function setText(selector, value) {
      const node = q(selector);
      if (node) node.textContent = String(value);
    }
    function empty(copy) { return textElement('div', copy, 'empty-state'); }
    function textElement(tag, copy, className) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = String(copy ?? '');
      return node;
    }
    function rowCopy(title, subtitle) {
      const wrap = document.createElement('div');
      wrap.className = 'row-main';
      wrap.append(textElement('div', title, 'row-title'), textElement('div', subtitle, 'row-sub'));
      return wrap;
    }
    function actionButton(label, listener) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', listener);
      return button;
    }
    function healthNode(value, label) {
      const node = document.createElement('div');
      node.className = 'health-stat';
      node.append(textElement('b', value), textElement('span', label));
      return node;
    }
  </script>
</body>
</html>`;
}

function navButton(target: string, label: string, path: string, active = false): string {
  return `<button class="nav-button${active ? ' active' : ''}" data-target="${target}" title="${label}" aria-label="${label}">
    <svg viewBox="0 0 24 24"><path d="${path}"/></svg>
    <span class="nav-copy">${label}</span>
  </button>`;
}

function metric(label: string, id: string, meta: string, className = ''): string {
  return `<div class="metric ${className}">
    <div class="metric-label">${label}</div>
    <div id="${id}" class="metric-value">0</div>
    <div class="metric-meta">${meta}</div>
  </div>`;
}

function healthStat(value: string, label: string): string {
  return `<div class="health-stat"><b>${value}</b><span>${label}</span></div>`;
}

function toolCard(index: string, title: string, copy: string): string {
  return `<div class="tool-card">
    <div class="tool-index">${index}</div>
    <h3>${title}</h3>
    <p>${copy}</p>
    <span class="tool-state">● available</span>
  </div>`;
}
