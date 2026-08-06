import { delimiter, dirname, join, resolve } from 'node:path';

const GIB = 1024 ** 3;
const MIN_INSTALLER_BYTES = 100 * 1024 ** 2;
const MAX_INSTALLER_BYTES = 2_500 * 1024 ** 2;

export interface LocalAiModelOption {
  model: string;
  title: string;
  detail: string;
  approximateDownloadGb: number;
  minimumMemoryGb: number;
}

export interface OllamaReleaseAssetInput {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string | null;
}

export interface VerifiedOllamaReleaseAsset {
  name: 'ollama-windows-amd64.zip';
  size: number;
  downloadUrl: string;
  sha256: string;
}

export type OllamaRuntimeSource = 'embedded' | 'managed' | 'external';

export interface OllamaRuntimeCandidate {
  path: string;
  source: OllamaRuntimeSource;
}

export interface OllamaRuntimeCandidateInput {
  executablePath: string;
  extensionRoot: string;
  globalStorageRoot: string;
  environment?: NodeJS.ProcessEnv;
}

const LOCAL_AI_MODELS: readonly LocalAiModelOption[] = [
  {
    model: 'qwen2.5-coder:3b',
    title: 'Hawk Light',
    detail: 'Fast completion for an 8-12 GB machine; limited for long autonomous tasks.',
    approximateDownloadGb: 2,
    minimumMemoryGb: 8,
  },
  {
    model: 'qwen2.5-coder:7b',
    title: 'Hawk Balanced',
    detail: 'Good editor completion and small coding tasks on a 12-23 GB machine.',
    approximateDownloadGb: 4.7,
    minimumMemoryGb: 12,
  },
  {
    model: 'qwen2.5-coder:14b',
    title: 'Hawk Pro',
    detail: 'Recommended for reliable multi-file agent work on a 24-47 GB machine.',
    approximateDownloadGb: 9,
    minimumMemoryGb: 24,
  },
  {
    model: 'qwen2.5-coder:32b',
    title: 'Hawk Max Local',
    detail: 'Highest local coding quality for a machine with at least 48 GB of memory.',
    approximateDownloadGb: 20,
    minimumMemoryGb: 48,
  },
] as const;

export function localAiModelOptions(): readonly LocalAiModelOption[] {
  return LOCAL_AI_MODELS;
}

export function recommendLocalAiModel(totalMemoryBytes: number): LocalAiModelOption {
  const memoryGb = Math.max(0, totalMemoryBytes / GIB);
  const first = LOCAL_AI_MODELS[0];
  if (!first) throw new Error('Hawk local AI model policy is empty.');
  let selected = first;
  for (const option of LOCAL_AI_MODELS) {
    if (memoryGb >= option.minimumMemoryGb) selected = option;
  }
  return selected;
}

export function validateOllamaReleaseAsset(
  input: OllamaReleaseAssetInput,
): VerifiedOllamaReleaseAsset {
  if (input.name !== 'ollama-windows-amd64.zip') {
    throw new Error('Ollama release does not contain the expected Windows standalone runtime.');
  }
  if (
    !Number.isSafeInteger(input.size) ||
    input.size < MIN_INSTALLER_BYTES ||
    input.size > MAX_INSTALLER_BYTES
  ) {
    throw new Error('Ollama runtime archive size is outside Hawk safety limits.');
  }
  const url = new URL(input.browser_download_url);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    !url.pathname.startsWith('/ollama/ollama/releases/download/')
  ) {
    throw new Error('Ollama runtime URL is not an official GitHub release asset.');
  }
  const digest = input.digest?.trim() ?? '';
  const match = digest.match(/^sha256:([a-f0-9]{64})$/i);
  if (!match?.[1]) {
    throw new Error('Ollama release is missing a SHA-256 digest.');
  }
  return {
    name: 'ollama-windows-amd64.zip',
    size: input.size,
    downloadUrl: url.toString(),
    sha256: match[1].toLowerCase(),
  };
}

export function ollamaRuntimeCandidates(
  input: OllamaRuntimeCandidateInput,
): OllamaRuntimeCandidate[] {
  const env = input.environment ?? process.env;
  const configured = env.HAWK_EMBEDDED_OLLAMA_PATH?.trim();
  const raw: OllamaRuntimeCandidate[] = [
    ...(configured ? [{ path: resolve(configured), source: 'embedded' as const }] : []),
    {
      path: join(
        dirname(input.executablePath),
        'resources',
        'hawk-local-ai',
        'ollama',
        'ollama.exe',
      ),
      source: 'embedded',
    },
    {
      path: join(input.extensionRoot, 'runtime', 'ollama', 'ollama.exe'),
      source: 'embedded',
    },
    {
      path: join(input.globalStorageRoot, 'local-ai', 'runtime', 'ollama.exe'),
      source: 'managed',
    },
    ...(env.LOCALAPPDATA
      ? [
          {
            path: join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
            source: 'external' as const,
          },
          {
            path: join(env.LOCALAPPDATA, 'Ollama', 'ollama.exe'),
            source: 'external' as const,
          },
        ]
      : []),
    ...(env.ProgramFiles
      ? [
          {
            path: join(env.ProgramFiles, 'Ollama', 'ollama.exe'),
            source: 'external' as const,
          },
        ]
      : []),
    ...(env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => ({
        path: join(directory, 'ollama.exe'),
        source: 'external' as const,
      })),
  ];
  const seen = new Set<string>();
  return raw.filter((candidate) => {
    const key = resolve(candidate.path).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function ollamaRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  modelsRoot: string,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    OLLAMA_HOST: '127.0.0.1:11434',
    OLLAMA_MODELS: resolve(modelsRoot),
    OLLAMA_NOHISTORY: '1',
    OLLAMA_DEBUG: '0',
  };
}
