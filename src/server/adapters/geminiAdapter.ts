import type {
  AdapterGenerateRequest,
  AdapterGenerateResult,
  AdapterGenerateStreamEvent,
  ConnectionStatus,
  FinishReason,
  ModelConfig,
} from '../types/index.js';
import { ModelAdapter, ModelAdapterError } from './modelAdapter.js';
import { estimateMaxOutputTokens } from '../utils/outputLength.js';
import { readServerSentEvents } from '../utils/sse.js';

const PROVIDER_NAME = 'gemini';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.5-flash';
const MAX_OUTPUT_TOKENS = 65_536;

export class GeminiAdapter implements ModelAdapter {
  readonly providerName = PROVIDER_NAME;

  async *generateTextStream(request: AdapterGenerateRequest): AsyncGenerator<AdapterGenerateStreamEvent> {
    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      throw new ModelAdapterError('APIキーが設定されていません', 'api_key_missing', false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const handleAbort = () => controller.abort();
    if (request.abortSignal?.aborted) {
      throw new ModelAdapterError('生成が中断されました', 'aborted', false);
    }
    request.abortSignal?.addEventListener('abort', handleAbort, { once: true });

    try {
      const modelName = normalizeModelName(request.modelName || DEFAULT_MODEL);
      const res = await fetch(
        `${API_BASE}/models/${modelName}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: geminiHeaders(apiKey),
          body: JSON.stringify(buildRequestBody(request)),
          signal: controller.signal,
        }
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ModelAdapterError(
          body.error?.message || `Gemini API error: ${res.status}`,
          mapHttpStatus(res.status, body),
          res.status >= 500 || res.status === 429
        );
      }

      let finishReason: FinishReason = 'stop';
      let rawUsage: AdapterGenerateResult['rawUsage'] | undefined;

      for await (const eventData of readServerSentEvents(res.body)) {
        const data = JSON.parse(eventData) as GeminiGenerateContentResponse;
        const candidate = data.candidates?.[0];
        const text =
          candidate?.content?.parts
            ?.map((part) => part.text)
            .join('') || '';

        if (text) yield { type: 'chunk', text };
        if (candidate?.finishReason) finishReason = mapFinishReason(candidate.finishReason);
        if (data.usageMetadata) {
          rawUsage = {
            promptTokens: data.usageMetadata.promptTokenCount ?? 0,
            completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: data.usageMetadata.totalTokenCount ?? 0,
          };
        }
      }

      yield { type: 'done', finishReason, rawUsage };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (request.abortSignal?.aborted) {
          throw new ModelAdapterError('生成が中断されました', 'aborted', false);
        }
        throw new ModelAdapterError('生成がタイムアウトしました', 'timeout', true);
      }
      if (err instanceof ModelAdapterError) throw err;
      throw new ModelAdapterError(
        err instanceof Error ? err.message : 'Unknown error',
        'network_error',
        true
      );
    } finally {
      clearTimeout(timeout);
      request.abortSignal?.removeEventListener('abort', handleAbort);
    }
  }

  async generateText(request: AdapterGenerateRequest): Promise<AdapterGenerateResult> {
    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      return {
        text: '',
        finishReason: 'error',
        errorCode: 'api_key_missing',
        retryable: false,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const modelName = normalizeModelName(request.modelName || DEFAULT_MODEL);
      const res = await fetch(
        `${API_BASE}/models/${modelName}:generateContent`,
        {
          method: 'POST',
          headers: geminiHeaders(apiKey),
          body: JSON.stringify(buildRequestBody(request)),
          signal: controller.signal,
        }
      );

      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = body.error?.message || `Gemini API error: ${res.status}`;
        return {
          text: '',
          finishReason: 'error',
          errorCode: mapHttpStatus(res.status, body),
          errorMessage: message,
          retryable: res.status >= 500 || res.status === 429,
        };
      }

      const data = (await res.json()) as GeminiGenerateContentResponse;
      const candidate = data.candidates?.[0];
      const text =
        candidate?.content?.parts
          ?.map((part) => part.text)
          .join('')
          .trim() || '';
      const finishReason = mapFinishReason(candidate?.finishReason);

      return {
        text,
        finishReason,
        rawUsage: data.usageMetadata
          ? {
              promptTokens: data.usageMetadata.promptTokenCount ?? 0,
              completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
              totalTokens: data.usageMetadata.totalTokenCount ?? 0,
            }
          : undefined,
        retryable: finishReason === 'error',
      };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          text: '',
          finishReason: 'timeout',
          errorCode: 'timeout',
          retryable: true,
        };
      }
      throw new ModelAdapterError(
        err instanceof Error ? err.message : 'Unknown error',
        'network_error',
        true
      );
    }
  }

  async validateConnection(config: ModelConfig): Promise<ConnectionStatus> {
    const apiKey = config.apiKey || (await this.loadApiKey());
    if (!apiKey) {
      return { ok: false, message: 'APIキーが設定されていません', errorCode: 'api_key_missing' };
    }

    try {
      const res = await fetch(`${API_BASE}/models`, {
        headers: geminiHeaders(apiKey),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return {
          ok: false,
          message: body.error?.message || `HTTP ${res.status}`,
          errorCode: mapHttpStatus(res.status, body),
        };
      }
      return { ok: true, message: '接続できました' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : '接続に失敗しました',
        errorCode: 'network_error',
      };
    }
  }

  private async loadApiKey(): Promise<string | undefined> {
    const { getCredential } = await import('../services/credentialService.js');
    return getCredential(PROVIDER_NAME);
  }
}

function buildRequestBody(request: AdapterGenerateRequest): unknown {
  const body: {
    contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
    systemInstruction?: { parts: Array<{ text: string }> };
    generationConfig: {
      temperature: number;
      maxOutputTokens: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
    };
  } = {
    contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: estimateMaxOutputTokens(request.outputLength, MAX_OUTPUT_TOKENS),
    },
  };

  if (request.systemInstructions.trim()) {
    body.systemInstruction = { parts: [{ text: request.systemInstructions }] };
  }

  if (request.frequencyPenalty !== undefined && request.frequencyPenalty !== 0) {
    body.generationConfig.frequencyPenalty = request.frequencyPenalty;
  }
  if (request.presencePenalty !== undefined && request.presencePenalty !== 0) {
    body.generationConfig.presencePenalty = request.presencePenalty;
  }

  return body;
}

function normalizeModelName(modelName: string): string {
  return modelName.replace(/^models\//, '');
}

function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function mapHttpStatus(
  status: number,
  body: { error?: { code?: number; status?: string; message?: string } }
): string {
  const statusCode = body.error?.code ?? status;
  const reason = body.error?.status;

  if (status === 401 || status === 403) return 'invalid_api_key';
  if (status === 429) return 'rate_limit';
  if (status === 500) return 'server_error';
  if (status === 503) return 'service_unavailable';
  if (reason === 'UNAUTHENTICATED' || reason === 'PERMISSION_DENIED') return 'invalid_api_key';
  if (reason === 'INVALID_ARGUMENT' || status === 400 || statusCode === 400) {
    return 'invalid_request_error';
  }
  if (reason === 'RESOURCE_EXHAUSTED') return 'rate_limit';
  if (statusCode === 401 || statusCode === 403) return 'invalid_api_key';
  if (statusCode === 429) return 'rate_limit';
  return body.error?.message?.toLowerCase().includes('api key')
    ? 'invalid_api_key'
    : 'api_error';
}

function mapFinishReason(reason?: string): FinishReason {
  if (!reason) return 'stop';
  const r = reason.toUpperCase();
  if (r === 'STOP') return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  if (r === 'SAFETY' || r === 'RECITATION') return 'content_filter';
  return 'error';
}
