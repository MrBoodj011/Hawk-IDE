import type { Backend, Config, ModelPurpose } from '../config/config.js';
import type { Client, StreamingClient } from './client.js';
import { isStreaming } from './client.js';
import { newFromConfig } from './factory.js';
import type { ChatRequest, ChatResponse } from './types.js';

/**
 * Creates a primary client plus explicit BYOK fallbacks. Hawk never invents a
 * paid route: every fallback must be configured with a local endpoint or an
 * environment-variable credential reference.
 */
export function createRoutedClient(cfg: Config, purpose: ModelPurpose = 'general'): Client {
  const primaryConfig = hydrateConfig(applyIdeOverrides(cfg));
  const primary = newFromConfig(primaryConfig);
  const orderedRoutes = [...cfg.fallback_models].sort((left, right) => {
    const leftRank = left.purpose === purpose ? 0 : left.purpose === 'general' ? 1 : 2;
    const rightRank = right.purpose === purpose ? 0 : right.purpose === 'general' ? 1 : 2;
    return leftRank - rightRank;
  });
  const fallbacks: Client[] = [];
  for (const route of orderedRoutes) {
    try {
      fallbacks.push(
        newFromConfig(
          hydrateConfig({
            ...cfg,
            backend: route.backend,
            model: route.model,
            base_url: route.base_url,
            api_key: '',
            api_key_env: route.api_key_env,
            fallback_models: [],
          }),
        ),
      );
    } catch {
      // A route with a missing credential remains dormant instead of breaking
      // the operator's configured primary model.
    }
  }
  return fallbacks.length ? new RoutedClient(primary, fallbacks) : primary;
}

export function purposeForTask(prompt: string): ModelPurpose {
  if (
    /\b(?:vulnerab|security|auth|permission|exploit|threat|injection|secret|cve|owasp)\b/i.test(
      prompt,
    )
  ) {
    return 'security';
  }
  if (/\b(?:architect|debug|diagnos|refactor|root cause|migration|design)\b/i.test(prompt)) {
    return 'reasoning';
  }
  return 'general';
}

class RoutedClient implements StreamingClient {
  private readonly clients: Client[];

  constructor(primary: Client, fallbacks: Client[]) {
    this.clients = [primary, ...fallbacks];
  }

  name(): string {
    return `hawk-router(${this.clients.map((client) => client.name()).join('→')})`;
  }

  model(): string {
    return this.clients[0]?.model() ?? '';
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const errors: string[] = [];
    for (const client of this.clients) {
      try {
        return withRoute(await client.chat({ ...request, model: client.model() }, signal), client);
      } catch (error) {
        if (signal?.aborted) throw error;
        errors.push(`${client.name()}: ${errorMessage(error)}`);
      }
    }
    throw new Error(`All configured Hawk model routes failed: ${errors.join(' | ')}`);
  }

  async chatStream(
    request: ChatRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const errors: string[] = [];
    for (const client of this.clients) {
      let emitted = false;
      try {
        if (!isStreaming(client)) {
          const response = await client.chat({ ...request, model: client.model() }, signal);
          if (response.message.content) onDelta(response.message.content);
          return withRoute(response, client);
        }
        return withRoute(
          await client.chatStream(
            { ...request, model: client.model() },
            (delta) => {
              emitted = true;
              onDelta(delta);
            },
            signal,
          ),
          client,
        );
      } catch (error) {
        if (signal?.aborted || emitted) throw error;
        errors.push(`${client.name()}: ${errorMessage(error)}`);
      }
    }
    throw new Error(`All configured Hawk model routes failed: ${errors.join(' | ')}`);
  }
}

function applyIdeOverrides(cfg: Config): Config {
  const requestedBackend = process.env.HAWK_IDE_BACKEND;
  const backend =
    requestedBackend && BACKENDS.has(requestedBackend) ? (requestedBackend as Backend) : undefined;
  return {
    ...cfg,
    ...(backend ? { backend } : {}),
    ...(process.env.HAWK_IDE_MODEL ? { model: process.env.HAWK_IDE_MODEL } : {}),
    ...(process.env.HAWK_IDE_BASE_URL ? { base_url: process.env.HAWK_IDE_BASE_URL } : {}),
    // The desktop extension injects this value from VS Code SecretStorage
    // only into the local daemon process. It is never written to config.json,
    // workspace settings, logs, prompts, or session state.
    ...(process.env.HAWK_IDE_API_KEY ? { api_key: process.env.HAWK_IDE_API_KEY } : {}),
  };
}

const BACKENDS = new Set([
  '',
  'ollama',
  'lmstudio',
  'openai',
  'openai-compat',
  'kimi',
  'groq',
  'openrouter',
  'deepseek',
  'gemini',
  'anthropic',
]);

function hydrateConfig(cfg: Config): Config {
  if (cfg.api_key) return cfg;
  const environmentKey: Partial<Record<Backend, string>> = {
    openai: process.env.OPENAI_API_KEY || '',
    kimi: process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || '',
    groq: process.env.GROQ_API_KEY || '',
    openrouter: process.env.OPENROUTER_API_KEY || '',
    deepseek: process.env.DEEPSEEK_API_KEY || '',
    gemini: process.env.GEMINI_API_KEY || '',
    anthropic: process.env.ANTHROPIC_API_KEY || '',
  };
  return {
    ...cfg,
    api_key:
      (cfg.api_key_env ? process.env[cfg.api_key_env] : '') || environmentKey[cfg.backend] || '',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withRoute(response: ChatResponse, client: Client): ChatResponse {
  return {
    ...response,
    route: {
      provider: client.name(),
      model: client.model(),
    },
  };
}
