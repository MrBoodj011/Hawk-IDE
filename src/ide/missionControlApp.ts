export const HAWK_MCP_APP_URI = 'ui://hawk/mission-control.html';
export const HAWK_MCP_APP_MIME = 'text/html;profile=mcp-app';

export const HAWK_MCP_APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Hawk Mission Control</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--color-background-primary, #080b12);
      --panel: var(--color-background-secondary, #101621);
      --text: var(--color-text-primary, #f5f7fb);
      --muted: var(--color-text-secondary, #94a0b2);
      --stroke: var(--color-border-primary, #263142);
      --amber: #ffb443;
      --ember: #ff6747;
      --sky: #50d9ff;
      --green: #54e3a1;
      font-family: var(--font-sans, Inter, ui-sans-serif, system-ui, sans-serif);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at 90% 0, #ff67471c, transparent 36%), var(--bg); color: var(--text); }
    .shell { min-height: 340px; padding: 18px; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }
    .brand { display:flex; align-items:center; gap:10px; }
    .mark { width:38px; height:38px; display:grid; place-items:center; border-radius:12px; background:linear-gradient(135deg,var(--amber),var(--ember)); color:#160b08; font-weight:950; letter-spacing:-.08em; box-shadow:0 8px 25px #ff674730; }
    .title { font-weight:850; letter-spacing:.08em; }
    .sub { color:var(--muted); font-size:11px; margin-top:2px; }
    .live { color:var(--green); font-size:11px; font-weight:800; letter-spacing:.1em; }
    .live:before { content:""; display:inline-block; width:7px; height:7px; margin-right:7px; border-radius:50%; background:currentColor; box-shadow:0 0 12px currentColor; }
    .hero { border:1px solid var(--stroke); border-radius:16px; padding:16px; background:linear-gradient(135deg,#ffffff07,transparent),var(--panel); }
    .eyebrow { color:var(--amber); font:700 10px/1 var(--font-mono, monospace); letter-spacing:.12em; text-transform:uppercase; }
    h1 { margin:8px 0 5px; font-size:24px; letter-spacing:-.04em; }
    .hero p { color:var(--muted); margin:0; font-size:12px; line-height:1.5; max-width:700px; }
    .metrics { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-top:12px; }
    .metric { border:1px solid var(--stroke); border-radius:12px; padding:11px; background:#ffffff04; }
    .metric b { display:block; font-size:22px; letter-spacing:-.04em; }
    .metric span { color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.08em; }
    .grid { display:grid; grid-template-columns:1.2fr .8fr; gap:10px; margin-top:10px; }
    .card { border:1px solid var(--stroke); border-radius:14px; background:var(--panel); overflow:hidden; }
    .card-head { display:flex; align-items:center; justify-content:space-between; padding:11px 13px; border-bottom:1px solid var(--stroke); font-size:11px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; }
    .body { padding:12px; }
    .run { padding:10px; border:1px solid var(--stroke); border-radius:10px; margin-bottom:7px; cursor:pointer; background:#ffffff03; }
    .run.selected { border-color:var(--amber); box-shadow:0 0 0 1px #ffb44333; }
    .run-line { display:flex; justify-content:space-between; gap:10px; font-size:12px; }
    .run small { color:var(--muted); display:block; margin-top:5px; }
    .bar { height:4px; border-radius:99px; background:#ffffff10; margin-top:8px; overflow:hidden; }
    .bar i { display:block; height:100%; background:linear-gradient(90deg,var(--amber),var(--ember)); }
    .event { display:grid; grid-template-columns:66px 1fr; gap:8px; padding:6px 0; border-bottom:1px solid #ffffff0a; font:11px/1.35 var(--font-mono,monospace); }
    .event time { color:var(--muted); }
    .empty { color:var(--muted); font-size:12px; padding:12px 0; }
    .actions { display:flex; flex-wrap:wrap; gap:7px; margin-top:12px; }
    button { border:1px solid var(--stroke); border-radius:9px; background:#ffffff07; color:var(--text); padding:7px 10px; font:700 11px/1 inherit; cursor:pointer; }
    button:hover { border-color:var(--amber); }
    button.primary { background:linear-gradient(135deg,var(--amber),var(--ember)); color:#170b08; border:0; }
    button.danger { color:#ff8f7d; }
    .foot { display:flex; justify-content:space-between; color:var(--muted); font:9px/1.3 var(--font-mono,monospace); letter-spacing:.08em; margin-top:11px; }
    @media(max-width:640px) { .metrics{grid-template-columns:repeat(2,1fr)} .grid{grid-template-columns:1fr} .shell{padding:12px} }
  </style>
</head>
<body>
  <main class="shell">
    <div class="top">
      <div class="brand"><div class="mark">H</div><div><div class="title">HAWK</div><div class="sub">SMART MCP MISSION CONTROL</div></div></div>
      <div class="live" id="state">CONNECTING</div>
    </div>
    <section class="hero">
      <div class="eyebrow">Evidence-driven agent fabric</div>
      <h1>Scope. Orchestrate. Prove.</h1>
      <p>Durable security missions with exact-plan approvals, parallel agents, tamper-evident events, ProofGraph evidence and independent verification.</p>
      <div class="metrics">
        <div class="metric"><b id="runs">0</b><span>runs</span></div>
        <div class="metric"><b id="active">0</b><span>active</span></div>
        <div class="metric"><b id="proof">0</b><span>proof nodes</span></div>
        <div class="metric"><b id="caps">0</b><span>capabilities</span></div>
      </div>
    </section>
    <div class="grid">
      <section class="card"><div class="card-head"><span>Agent runs</span><span id="run-count">0 total</span></div><div class="body" id="run-list"><div class="empty">No Smart MCP run yet.</div></div></section>
      <section class="card"><div class="card-head"><span>Live event chain</span><span id="integrity">SHA-256</span></div><div class="body" id="events"><div class="empty">Select a run to inspect its timeline.</div></div></section>
    </div>
    <div class="actions">
      <button class="primary" id="refresh">Refresh fabric</button>
      <button id="pause">Pause</button>
      <button id="resume">Resume</button>
      <button class="danger" id="cancel">Cancel run</button>
      <button id="fullscreen">Fullscreen</button>
    </div>
    <div class="foot"><span>LOCAL-FIRST / AUTHORIZED WORKSPACES ONLY</span><span id="stamp">WAITING FOR MCP HOST</span></div>
  </main>
  <script>
    (() => {
      let nextId = 1;
      let selectedRun = "";
      const pending = new Map();
      const q = (s) => document.querySelector(s);
      const sendRequest = (method, params) => {
        const id = nextId++;
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      };
      const notify = (method, params) => window.parent.postMessage({ jsonrpc:"2.0", method, params }, "*");
      const tool = async (name, args) => {
        const response = await sendRequest("tools/call", { name, arguments: args || {} });
        return response.structuredContent?.data || response.structuredContent || {};
      };
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const msg = event.data;
        if (!msg || msg.jsonrpc !== "2.0") return;
        if (msg.id && pending.has(msg.id)) {
          const waiter = pending.get(msg.id); pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(msg.error.message || "MCP App request failed"));
          else waiter.resolve(msg.result || {});
          return;
        }
        if (msg.method === "ui/notifications/tool-result") render(msg.params?.structuredContent?.data || msg.params?.structuredContent || {});
        if (msg.method === "ui/notifications/host-context-changed") applyContext(msg.params || {});
        if (msg.method === "ui/resource-teardown" && msg.id) window.parent.postMessage({jsonrpc:"2.0",id:msg.id,result:{}}, "*");
      });
      function applyContext(context) {
        const vars = context.styles?.variables || {};
        Object.entries(vars).forEach(([key,value]) => { if (value) document.documentElement.style.setProperty(key,value); });
        if (context.theme) document.documentElement.style.colorScheme = context.theme;
      }
      function render(data) {
        const runs = Array.isArray(data.runs) ? data.runs : [];
        q("#runs").textContent = String(runs.length);
        q("#active").textContent = String(runs.filter(r => r.status === "running" || r.status === "queued").length);
        q("#proof").textContent = String(data.graph?.nodes || 0);
        q("#caps").textContent = String(data.capabilities || 0);
        q("#run-count").textContent = runs.length + " total";
        q("#stamp").textContent = data.generatedAt || new Date().toISOString();
        q("#state").textContent = "FABRIC ONLINE";
        const list = q("#run-list"); list.replaceChildren();
        if (!runs.length) list.innerHTML = '<div class="empty">No Smart MCP run yet. Create a scoped plan, approve its exact hash when required, then start it.</div>';
        runs.forEach((run) => {
          const done = (run.summary?.succeeded || 0) + (run.summary?.failed || 0) + (run.summary?.skipped || 0) + (run.summary?.cancelled || 0);
          const pct = run.summary?.total ? Math.round(done / run.summary.total * 100) : 0;
          const el = document.createElement("div"); el.className = "run" + (selectedRun === run.id ? " selected" : "");
          const line = document.createElement("div"); line.className = "run-line";
          const id = document.createElement("strong"); id.textContent = run.id;
          const status = document.createElement("span"); status.textContent = run.status.toUpperCase();
          line.append(id,status);
          const small = document.createElement("small"); small.textContent = done + " / " + (run.summary?.total || 0) + " nodes complete";
          const bar = document.createElement("div"); bar.className = "bar"; const fill = document.createElement("i"); fill.style.width = pct + "%"; bar.append(fill);
          el.append(line,small,bar); el.onclick = () => { selectedRun = run.id; refresh(); }; list.append(el);
        });
        renderEvents(Array.isArray(data.events) ? data.events : []);
      }
      function renderEvents(events) {
        const box = q("#events"); box.replaceChildren();
        if (!events.length) { box.innerHTML = '<div class="empty">Select a run to inspect its tamper-evident event chain.</div>'; return; }
        events.slice(-12).reverse().forEach((event) => {
          const row = document.createElement("div"); row.className = "event";
          const time = document.createElement("time"); time.textContent = String(event.at || "").slice(11,19);
          const text = document.createElement("span"); text.textContent = "#" + event.sequence + " " + event.type;
          row.append(time,text); box.append(row);
        });
      }
      async function refresh() {
        try { render(await tool("hawk_mission_control", { run_id: selectedRun || undefined })); }
        catch (error) { q("#state").textContent = "FABRIC ERROR"; q("#stamp").textContent = error.message; }
      }
      async function control(action) {
        if (!selectedRun) return;
        if (action === "cancel" && !confirm("Cancel this Hawk run?")) return;
        await tool("hawk_run_control", { run_id: selectedRun, action });
        await refresh();
      }
      q("#refresh").onclick = refresh;
      q("#pause").onclick = () => control("pause");
      q("#resume").onclick = () => control("resume");
      q("#cancel").onclick = () => control("cancel");
      q("#fullscreen").onclick = () => sendRequest("ui/request-display-mode", {mode:"fullscreen"}).catch(() => {});
      const observer = new ResizeObserver(() => notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
      observer.observe(document.body);
      sendRequest("ui/initialize", {
        protocolVersion: "2026-01-26",
        appInfo: { name: "Hawk Mission Control", version: "1.0.0" },
        appCapabilities: { availableDisplayModes: ["inline","fullscreen"] }
      }).then((result) => {
        applyContext(result.hostContext || {});
        notify("ui/notifications/initialized", {});
        refresh();
        window.setInterval(refresh, 5000);
      }).catch(() => {
        notify("ui/notifications/initialized", {});
      });
    })();
  </script>
</body>
</html>`;
