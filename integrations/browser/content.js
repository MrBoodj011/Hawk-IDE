const api = globalThis.browser ?? globalThis.chrome;
let interactionCaptureEnabled = false;

api.storage.local.get(
  { enabled: false, captureInteractions: false },
  (settings) => {
    interactionCaptureEnabled =
      settings.enabled === true && settings.captureInteractions === true;
  },
);

api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || (!changes.enabled && !changes.captureInteractions)) return;
  api.storage.local.get(
    { enabled: false, captureInteractions: false },
    (settings) => {
      interactionCaptureEnabled =
        settings.enabled === true && settings.captureInteractions === true;
    },
  );
});

const script = document.createElement("script");
script.src = api.runtime.getURL("page-hook.js");
script.async = false;
(document.head || document.documentElement).appendChild(script);
script.remove();

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "hawk-live-capture") return;
  api.runtime.sendMessage({
    type: "hawk-page-event",
    payload: event.data.payload,
  });
});

document.addEventListener(
  "click",
  (event) => {
    if (!interactionCaptureEnabled || !event.isTrusted) return;
    const target = interactiveTarget(event.target);
    if (!target) return;
    sendInteraction("click", target, event.detail);
  },
  true,
);

document.addEventListener(
  "submit",
  (event) => {
    if (
      !interactionCaptureEnabled ||
      !event.isTrusted ||
      !(event.target instanceof Element)
    ) {
      return;
    }
    sendInteraction("submit", event.target, 1);
  },
  true,
);

api.storage.local.get({ captureSessionStorage: false }, (settings) => {
  if (settings.captureSessionStorage !== true) return;
  const sendSnapshot = () => {
    api.runtime.sendMessage({
      type: "hawk-session-snapshot",
      payload: {
        url: location.href,
        title: document.title,
        userAgent: navigator.userAgent,
        documentCookie: document.cookie,
        localStorage: storageSnapshot(localStorage),
        sessionStorage: storageSnapshot(sessionStorage),
      },
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sendSnapshot, { once: true });
  } else {
    sendSnapshot();
  }
});

function storageSnapshot(storage) {
  const result = {};
  for (let index = 0; index < Math.min(storage.length, 256); index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    result[key] = String(storage.getItem(key) ?? "").slice(0, 8_192);
  }
  return result;
}

function interactiveTarget(value) {
  if (!(value instanceof Element)) return undefined;
  return value.closest(
    'button, a[href], input[type="button"], input[type="submit"], input[type="image"], [role="button"], [role="link"]',
  );
}

function sendInteraction(kind, element, detail) {
  if (!interactionCaptureEnabled) return;
  api.runtime.sendMessage({
    type: "hawk-interaction-event",
    payload: {
      kind,
      url: `${location.origin}${location.pathname}`,
      occurredAt: Date.now(),
      trusted: true,
      detail: Number.isFinite(detail) ? detail : 0,
      target: {
        fingerprint: structuralFingerprint(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || undefined,
        inputType:
          element instanceof HTMLInputElement ? element.type.toLowerCase() : undefined,
        disabled:
          ("disabled" in element && element.disabled === true) ||
          element.getAttribute("aria-disabled") === "true",
      },
    },
  });
}

function structuralFingerprint(element) {
  const parts = [];
  let current = element;
  while (current && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    const role = current.getAttribute("role");
    const type =
      current instanceof HTMLInputElement ? current.type.toLowerCase() : undefined;
    if (role) part += `[role="${safeToken(role)}"]`;
    if (type) part += `[type="${safeToken(type)}"]`;
    const parent = current.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter(
        (candidate) => candidate.tagName === current.tagName,
      );
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(" > ").slice(0, 240);
}

function safeToken(value) {
  return String(value).replace(/[^a-z0-9._-]/gi, "").slice(0, 32);
}
