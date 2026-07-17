const api = globalThis.browser ?? globalThis.chrome;
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
