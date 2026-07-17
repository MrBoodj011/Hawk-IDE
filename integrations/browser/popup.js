const api = globalThis.browser ?? globalThis.chrome;
const enabled = document.querySelector("#enabled");
const status = document.querySelector("#status");
const dot = document.querySelector("#dot");

api.storage.local.get({ enabled: false }, (config) => {
  enabled.checked = config.enabled === true;
});

enabled.addEventListener("change", () => {
  api.storage.local.set({ enabled: enabled.checked }, refresh);
});
document.querySelector("#open-options").addEventListener("click", () => api.runtime.openOptionsPage());
document.querySelector("#test").addEventListener("click", refresh);

refresh();
function refresh() {
  api.runtime.sendMessage({ type: "hawk-status" }, (result) => {
    const runtime = result?.runtime || {};
    document.querySelector("#forwarded").textContent = String(runtime.forwarded || 0);
    document.querySelector("#dropped").textContent = String(runtime.dropped || 0);
    if (result?.ok) {
      status.textContent = `Connected · ${result.bridge.requestCount || 0} requests in Hawk`;
      status.className = "status online";
      dot.className = "online";
      return;
    }
    status.textContent = result?.error || "Pair Hawk to start live capture.";
    status.className = "status offline";
    dot.className = "offline";
  });
}
