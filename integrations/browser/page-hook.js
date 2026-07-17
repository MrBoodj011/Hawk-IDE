(() => {
  if (window.__hawkLiveCaptureInstalled) return;
  window.__hawkLiveCaptureInstalled = true;

  const emit = (payload) => {
    window.postMessage({ source: "hawk-live-capture", payload }, location.origin);
  };

  const originalFetch = window.fetch;
  window.fetch = async function hawkFetch(input, init) {
    const started = performance.timeOrigin + performance.now();
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    const url = String(input?.url || input);
    try {
      const response = await originalFetch.apply(this, arguments);
      emit({
        kind: "fetch",
        method,
        url,
        status: response.status,
        timeStart: started,
        timeEnd: performance.timeOrigin + performance.now(),
        elapsedMs: performance.timeOrigin + performance.now() - started,
      });
      return response;
    } catch (error) {
      emit({
        kind: "fetch",
        method,
        url,
        error: String(error).slice(0, 200),
        timeStart: started,
        timeEnd: performance.timeOrigin + performance.now(),
      });
      throw error;
    }
  };

  const OriginalXHR = window.XMLHttpRequest;
  const open = OriginalXHR.prototype.open;
  const send = OriginalXHR.prototype.send;
  OriginalXHR.prototype.open = function hawkOpen(method, url) {
    this.__hawkMethod = String(method || "GET").toUpperCase();
    this.__hawkUrl = String(url);
    return open.apply(this, arguments);
  };
  OriginalXHR.prototype.send = function hawkSend() {
    const started = performance.timeOrigin + performance.now();
    this.addEventListener(
      "loadend",
      () => {
        const ended = performance.timeOrigin + performance.now();
        emit({
          kind: "xhr",
          method: this.__hawkMethod || "GET",
          url: this.responseURL || this.__hawkUrl || location.href,
          status: this.status,
          timeStart: started,
          timeEnd: ended,
          elapsedMs: ended - started,
        });
      },
      { once: true },
    );
    return send.apply(this, arguments);
  };

  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = class HawkWebSocket extends OriginalWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      emit({ kind: "ws-open", method: "WS", url: String(url), timeStart: Date.now() });
      this.addEventListener("close", () =>
        emit({ kind: "ws", method: "WS", url: String(url), timeEnd: Date.now() }),
      );
    }
  };
})();
