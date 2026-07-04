import { loadCredentials } from './credentialService.js';
import type {
  ModelProviderInfo,
  TokenCountSource,
  TokenLimitSource,
} from '../types/index.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_LIMIT_CACHE_MS = 10 * 60 * 1000;

export interface ModelTokenLimits {
  contextWindowTokens: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  source: TokenLimitSource;
}

export interface PromptTokenCount {
  tokens: number;
  source: TokenCountSource;
}

const PROVIDERS: ModelProviderInfo[] = [
  {
    name: 'gemini',
    label: 'Gemini',
    defaultModel: 'gemini-3.5-flash',
    apiKeyPlaceholder: 'AIzaSy...',
    apiKeyHelp: 'Gemini APIキーを保存します。保存後は文脈上限と入力トークン数をAPIから取得できます。',
  },
  {
    name: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHelp: 'DeepSeek APIキーを保存します。OpenAI互換APIとして利用します。',
  },
  {
    name: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHelp: 'OpenAI APIキーを保存します。文脈上限はアプリ内のモデル表を使います。',
  },
];

const CATALOG_LIMITS: Record<string, Record<string, Omit<ModelTokenLimits, 'source'>>> = {
  deepseek: {
    'deepseek-v4-flash': {
      contextWindowTokens: 1_000_000,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 384_000,
    },
    'deepseek-v4-pro': {
      contextWindowTokens: 1_000_000,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 384_000,
    },
    'deepseek-chat': {
      contextWindowTokens: 1_000_000,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 384_000,
    },
    'deepseek-reasoner': {
      contextWindowTokens: 1_000_000,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 384_000,
    },
  },
  openai: {
    'gpt-4o-mini': {
      contextWindowTokens: 128_000,
      inputTokenLimit: 128_000,
      outputTokenLimit: 16_384,
    },
    'gpt-4o': {
      contextWindowTokens: 128_000,
      inputTokenLimit: 128_000,
      outputTokenLimit: 16_384,
    },
    'gpt-5.5': {
      contextWindowTokens: 1_000_000,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 128_000,
    },
    'gpt-5.4': {
      contextWindowTokens: 1_000_000,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 128_000,
    },
    'gpt-5.4-mini': {
      contextWindowTokens: 400_000,
      inputTokenLimit: 400_000,
      outputTokenLimit: 128_000,
    },
  },
};

const providerLimitCache = new Map<string, { expiresAt: number; limits: ModelTokenLimits }>();

export function listModelProviders(): ModelProviderInfo[] {
  return PROVIDERS.map((provider) => ({ ...provider }));
}

export function isSupportedProvider(provider: string): boolean {
  return PROVIDERS.some((entry) => entry.name === provider);
}

export function defaultModelForProvider(provider: string): string {
  return PROVIDERS.find((entry) => entry.name === provider)?.defaultModel ?? PROVIDERS[0].defaultModel;
}

export async function resolveModelTokenLimits(
  provider: string,
  modelName: string
): Promise<ModelTokenLimits> {
  if (provider === 'gemini') {
    const fromProvider = await fetchGeminiModelLimits(modelName);
    if (fromProvider) return fromProvider;
  }

  const fromCatalog = getCatalogLimits(provider, modelName);
  if (fromCatalog) return fromCatalog;

  return inferModelTokenLimits(provider, modelName);
}

export async function countPromptTokens(
  provider: string,
  modelName: string,
  systemInstructions: string,
  userPrompt: string
): Promise<PromptTokenCount | null> {
  if (provider !== 'gemini') return null;

  const credentials = await loadCredentials();
  const apiKey = credentials.gemini;
  if (!apiKey) return null;

  try {
    const normalizedModel = normalizeGeminiModelName(modelName);
    const body: {
      generateContentRequest: {
        model: string;
        contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
        systemInstruction?: { parts: Array<{ text: string }> };
      };
    } = {
      generateContentRequest: {
        model: `models/${normalizedModel}`,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      },
    };

    if (systemInstructions.trim()) {
      body.generateContentRequest.systemInstruction = {
        parts: [{ text: systemInstructions }],
      };
    }

    const res = await fetch(
      `${GEMINI_API_BASE}/models/${normalizedModel}:countTokens`,
      {
        method: 'POST',
        headers: geminiHeaders(apiKey),
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as { totalTokens?: number | string };
    const tokens = toNumber(data.totalTokens);
    return tokens ? { tokens, source: 'provider' } : null;
  } catch {
    return null;
  }
}

async function fetchGeminiModelLimits(modelName: string): Promise<ModelTokenLimits | null> {
  const credentials = await loadCredentials();
  const apiKey = credentials.gemini;
  if (!apiKey) return null;

  const normalizedModel = normalizeGeminiModelName(modelName);
  const cacheKey = `gemini:${normalizedModel}`;
  const cached = providerLimitCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.limits;

  try {
    const res = await fetch(`${GEMINI_API_BASE}/models/${normalizedModel}`, {
      headers: geminiHeaders(apiKey),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      inputTokenLimit?: number | string;
      outputTokenLimit?: number | string;
    };
    const inputTokenLimit = toNumber(data.inputTokenLimit);
    const outputTokenLimit = toNumber(data.outputTokenLimit);
    if (!inputTokenLimit) return null;

    const limits: ModelTokenLimits = {
      contextWindowTokens: inputTokenLimit,
      inputTokenLimit,
      outputTokenLimit,
      source: 'provider',
    };
    providerLimitCache.set(cacheKey, {
      expiresAt: Date.now() + MODEL_LIMIT_CACHE_MS,
      limits,
    });
    return limits;
  } catch {
    return null;
  }
}

function getCatalogLimits(provider: string, modelName: string): ModelTokenLimits | null {
  const providerCatalog = CATALOG_LIMITS[provider];
  if (!providerCatalog) return null;

  const normalizedModel = normalizeCatalogModelName(modelName);
  const direct = providerCatalog[normalizedModel];
  if (direct) return { ...direct, source: 'catalog' };

  const prefix = Object.entries(providerCatalog)
    .sort(([a], [b]) => b.length - a.length)
    .find(([key]) => normalizedModel.startsWith(key));
  return prefix ? { ...prefix[1], source: 'catalog' } : null;
}

function inferModelTokenLimits(provider: string, modelName: string): ModelTokenLimits {
  const model = normalizeCatalogModelName(modelName);

  if (provider === 'gemini' || model.includes('gemini')) {
    return {
      contextWindowTokens: 1_000_000,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 65_536,
      source: 'inferred',
    };
  }

  if (provider === 'deepseek' || model.includes('deepseek')) {
    return {
      contextWindowTokens: 1_000_000,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 384_000,
      source: 'inferred',
    };
  }

  if (model.includes('gpt-5') || model.includes('gpt-4.1')) {
    return {
      contextWindowTokens: 1_000_000,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 32_768,
      source: 'inferred',
    };
  }

  return {
    contextWindowTokens: 128_000,
    inputTokenLimit: 128_000,
    outputTokenLimit: 16_384,
    source: 'inferred',
  };
}

function normalizeGeminiModelName(modelName: string): string {
  return modelName.trim().replace(/^models\//, '');
}

function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

function normalizeCatalogModelName(modelName: string): string {
  return modelName.trim().toLowerCase().replace(/^models\//, '');
}

function toNumber(value: number | string | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
