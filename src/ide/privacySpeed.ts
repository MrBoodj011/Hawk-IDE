export interface HawkPrivacySpeedPosture {
  protocolVersion: 1;
  mode: 'local-first';
  localModel: {
    provider: 'ollama';
    enabled: boolean;
    endpoint: string;
    remoteFallback: 'disabled' | 'explicit-opt-in';
  };
  cache: {
    enabled: boolean;
    ttlMs: number;
    maxEntries: number;
    scope: 'process-local';
  };
  index: {
    persistent: true;
    incremental: true;
    warmStart: true;
    embeddings: 'disabled' | 'local-optional';
    memoryBudgetBytes: number;
  };
  startup: {
    lazyIndex: true;
    daemonReadyMs?: number;
    indexReadyMs?: number;
  };
  redaction: {
    prompts: true;
    terminal: true;
    findings: true;
    learningSignals: true;
  };
}

export function privacySpeedPosture(
  input: {
    cache?: { enabled: boolean; ttlMs: number; maxEntries: number };
    index?: { embeddingsEnabled: boolean; memoryBudgetBytes: number };
    startup?: { daemonReadyMs?: number; indexReadyMs?: number };
  } = {},
): HawkPrivacySpeedPosture {
  const endpoint =
    process.env.HAWK_IDE_OLLAMA_BASE_URL?.trim() ||
    process.env.HAWK_IDE_BASE_URL?.trim() ||
    'http://127.0.0.1:11434';
  const localOnly = process.env.HAWK_IDE_LOCAL_ONLY !== '0';
  const cache = input.cache ?? {
    enabled: process.env.HAWK_IDE_EDIT_CACHE_ENABLED !== '0',
    ttlMs: 30_000,
    maxEntries: 256,
  };
  const index = input.index ?? {
    embeddingsEnabled: process.env.HAWK_IDE_EMBEDDINGS === '1',
    memoryBudgetBytes: 320 * 1024 * 1024,
  };
  return {
    protocolVersion: 1,
    mode: 'local-first',
    localModel: {
      provider: 'ollama',
      enabled: localOnly || process.env.HAWK_IDE_OLLAMA_ENABLED !== '0',
      endpoint: safeEndpoint(endpoint),
      remoteFallback: localOnly ? 'disabled' : 'explicit-opt-in',
    },
    cache: { ...cache, scope: 'process-local' },
    index: {
      persistent: true,
      incremental: true,
      warmStart: true,
      embeddings: index.embeddingsEnabled ? 'local-optional' : 'disabled',
      memoryBudgetBytes: index.memoryBudgetBytes,
    },
    startup: { lazyIndex: true, ...input.startup },
    redaction: { prompts: true, terminal: true, findings: true, learningSignals: true },
  };
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return `${url.protocol}//${url.hostname === 'localhost' ? '127.0.0.1' : url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return 'http://127.0.0.1:11434';
  }
}
