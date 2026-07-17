const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = Object.freeze({
  bridgeUrl: "http://127.0.0.1:9999",
  token: "",
  enabled: false,
  scope: "^https?://",
  requestsPerSecond: 50,
  captureRequestBodies: false,
  captureSessionStorage: false,
});

const pending = new Map();
let config = { ...DEFAULTS };
let rateWindowStartedAt = Date.now();
let rateWindowCount = 0;
let forwarded = 0;
let dropped = 0;
let lastError = "";
let lastForwardedAt = 0;

loadConfig();

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, change] of Object.entries(changes)) {
    if (key in DEFAULTS) config[key] = change.newValue ?? DEFAULTS[key];
  }
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if (message.type === "hawk-page-event") {
    const payload = {
      ...message.payload,
      tabId: sender.tab?.id,
      initiator: sender.url,
    };
    forward("/ingest", payload);
    return false;
  }
  if (message.type === "hawk-session-snapshot") {
    if (config.captureSessionStorage === true) forward("/snapshot", message.payload);
    return false;
  }
  if (message.type === "hawk-status") {
    testBridge().then(sendResponse);
    return true;
  }
  if (message.type === "hawk-runtime") {
    sendResponse(runtimeStatus());
    return false;
  }
  if (message.type === "hawk-save-config") {
    saveConfig(message.config)
      .then(() => testBridge())
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }
  return false;
});

api.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!shouldCapture(details.url)) return;
    const entry = {
      id: details.requestId,
      method: details.method,
      url: details.url,
      tabId: details.tabId,
      type: details.type,
      initiator: details.initiator,
      timeStart: details.timeStamp,
    };
    if (config.captureRequestBodies === true && details.requestBody) {
      entry.requestBody = safeRequestBody(details.requestBody);
    }
    pending.set(details.requestId, entry);
    prunePending();
  },
  { urls: ["<all_urls>"] },
  ["requestBody"],
);

api.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const entry = pending.get(details.requestId);
    if (!entry) return;
    entry.requestHeaders = redactHeaders(details.requestHeaders);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"],
);

api.webRequest.onHeadersReceived.addListener(
  (details) => {
    const entry = pending.get(details.requestId);
    if (!entry) return;
    entry.status = details.statusCode;
    entry.fromCache = details.fromCache;
    entry.responseHeaders = redactHeaders(details.responseHeaders);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

api.webRequest.onCompleted.addListener(
  (details) => finish(details.requestId, details.timeStamp, details.statusCode, details.fromCache),
  { urls: ["<all_urls>"] },
);

api.webRequest.onErrorOccurred.addListener(
  (details) => finish(details.requestId, details.timeStamp, undefined, false, details.error),
  { urls: ["<all_urls>"] },
);

async function loadConfig() {
  const saved = await storageGet(DEFAULTS);
  config = normalizeConfig(saved);
}

async function saveConfig(input) {
  const next = normalizeConfig({ ...config, ...(input || {}) });
  validateConfig(next);
  await storageSet(next);
  config = next;
}

function normalizeConfig(input) {
  return {
    bridgeUrl: String(input.bridgeUrl ?? DEFAULTS.bridgeUrl).replace(/\/+$/, ""),
    token: String(input.token ?? ""),
    enabled: input.enabled === true,
    scope: String(input.scope ?? DEFAULTS.scope),
    requestsPerSecond: clampNumber(input.requestsPerSecond, 1, 500, 50),
    captureRequestBodies: input.captureRequestBodies === true,
    captureSessionStorage: input.captureSessionStorage === true,
  };
}

function validateConfig(value) {
  const url = new URL(value.bridgeUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Hawk capture only accepts a loopback HTTP bridge URL.");
  }
  if (!value.token || value.token.length < 16) throw new Error("Paste a valid Hawk pairing token.");
  new RegExp(value.scope);
}

function shouldCapture(url) {
  if (!config.enabled || !config.token) return false;
  if (url.startsWith(`${config.bridgeUrl}/`)) return false;
  try {
    return new RegExp(config.scope).test(url);
  } catch {
    lastError = "Invalid scope expression";
    return false;
  }
}

function finish(requestId, timeEnd, status, fromCache, error) {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  entry.timeEnd = timeEnd;
  entry.elapsedMs = Math.max(0, timeEnd - entry.timeStart);
  if (typeof status === "number") entry.status = status;
  if (typeof fromCache === "boolean") entry.fromCache = fromCache;
  if (error) entry.error = String(error).slice(0, 200);
  forward("/ingest", entry);
}

async function forward(path, payload) {
  if (!shouldCapture(String(payload?.url ?? payload?.initiator ?? ""))) return;
  if (!consumeRateSlot()) {
    dropped += 1;
    return;
  }
  try {
    const response = await fetch(`${config.bridgeUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hawk-Source": "browser-extension",
        "X-Hawk-Token": config.token,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
    forwarded += 1;
    lastForwardedAt = Date.now();
    lastError = "";
  } catch (error) {
    lastError = safeError(error);
  }
}

async function testBridge() {
  try {
    validateConfig(config);
    const response = await fetch(`${config.bridgeUrl}/status`, {
      headers: { "X-Hawk-Token": config.token },
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Bridge returned ${response.status}`);
    lastError = "";
    return { ok: true, bridge: body, runtime: runtimeStatus() };
  } catch (error) {
    lastError = safeError(error);
    return { ok: false, error: lastError, runtime: runtimeStatus() };
  }
}

function runtimeStatus() {
  return {
    enabled: config.enabled,
    forwarded,
    dropped,
    pending: pending.size,
    lastError,
    lastForwardedAt,
  };
}

function consumeRateSlot() {
  const now = Date.now();
  if (now - rateWindowStartedAt >= 1000) {
    rateWindowStartedAt = now;
    rateWindowCount = 0;
  }
  if (rateWindowCount >= config.requestsPerSecond) return false;
  rateWindowCount += 1;
  return true;
}

function prunePending() {
  if (pending.size <= 2_000) return;
  const oldest = [...pending.entries()]
    .sort((left, right) => left[1].timeStart - right[1].timeStart)
    .slice(0, pending.size - 2_000);
  for (const [id] of oldest) pending.delete(id);
  dropped += oldest.length;
}

function redactHeaders(headers = []) {
  const sensitive = /^(?:authorization|cookie|proxy-authorization|set-cookie|x-api-key)$/i;
  return headers.slice(0, 256).map((header) => ({
    name: String(header.name || "").slice(0, 256),
    value: sensitive.test(header.name || "")
      ? "REDACTED"
      : String(header.value || "").slice(0, 8_192),
  }));
}

function safeRequestBody(body) {
  if (body.formData && typeof body.formData === "object") {
    return { formData: redactObject(body.formData) };
  }
  if (Array.isArray(body.raw)) {
    return {
      raw: body.raw.slice(0, 8).map((part) => ({
        bytes: part.bytes ? bytesToBase64(part.bytes).slice(0, 87_384) : undefined,
        file: part.file ? String(part.file).slice(0, 512) : undefined,
      })),
    };
  }
  return undefined;
}

function redactObject(value) {
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 256)) {
    result[key] = /token|secret|pass|auth|cookie|session|key/i.test(key)
      ? ["REDACTED"]
      : Array.isArray(item)
        ? item.slice(0, 32).map((entry) => String(entry).slice(0, 4_096))
        : String(item).slice(0, 4_096);
  }
  return result;
}

function bytesToBase64(value) {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function storageGet(defaults) {
  return new Promise((resolve) => api.storage.local.get(defaults, resolve));
}

function storageSet(value) {
  return new Promise((resolve) => api.storage.local.set(value, resolve));
}
