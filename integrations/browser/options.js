const api = globalThis.browser ?? globalThis.chrome;
const fields = {
  bridgeUrl: document.querySelector("#bridge-url"),
  token: document.querySelector("#token"),
  scope: document.querySelector("#scope"),
  requestsPerSecond: document.querySelector("#rate"),
  enabled: document.querySelector("#enabled"),
  captureRequestBodies: document.querySelector("#bodies"),
  captureSessionStorage: document.querySelector("#session"),
};
const defaults = {
  bridgeUrl: "http://127.0.0.1:9999",
  token: "",
  scope: "^https?://",
  requestsPerSecond: 50,
  enabled: false,
  captureRequestBodies: false,
  captureSessionStorage: false,
};

api.storage.local.get(defaults, (config) => {
  for (const [name, field] of Object.entries(fields)) {
    field[field.type === "checkbox" ? "checked" : "value"] = config[name];
  }
});

document.querySelector("#pairing").addEventListener("input", (event) => {
  try {
    const pairing = JSON.parse(event.target.value);
    if (typeof pairing.url === "string") fields.bridgeUrl.value = pairing.url;
    if (typeof pairing.token === "string") fields.token.value = pairing.token;
    setResult("Pairing parsed. Save to verify it.", "");
  } catch {
    setResult("Paste the complete Hawk pairing JSON.", "offline");
  }
});

document.querySelector("#save").addEventListener("click", () => {
  api.runtime.sendMessage({ type: "hawk-save-config", config: readConfig() }, showResult);
});
document.querySelector("#test").addEventListener("click", () => {
  api.runtime.sendMessage({ type: "hawk-status" }, showResult);
});

function readConfig() {
  const config = {};
  for (const [name, field] of Object.entries(fields)) {
    config[name] = field.type === "checkbox" ? field.checked : field.value;
  }
  config.requestsPerSecond = Number(config.requestsPerSecond);
  return config;
}

function showResult(result) {
  if (result?.ok) {
    setResult(
      `Connected to Hawk · ${result.bridge.requestCount || 0} requests · ${result.bridge.endpointCount || 0} endpoints`,
      "online",
    );
    return;
  }
  setResult(result?.error || "The local Hawk bridge is unavailable.", "offline");
}

function setResult(text, state) {
  const result = document.querySelector("#result");
  result.textContent = text;
  result.className = `status ${state}`;
}
