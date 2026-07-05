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

const PROVIDER_NAME = 'openai';
const API_BASE = 'https://api.openai.com/v1';
const MAX_COMPLETION_TOKENS = 16_384;

interface OpenAIAdapterOptions {
  providerName?: string;
  apiBase?: string;
  maxCompletionTokens?: number;
  includeStreamOptions?: boolean;
}

export class OpenAIAdapter implements ModelAdapter {
  readonly providerName: string;
  private readonly apiBase: string;
  private readonly maxCompletionTokens: number;
  private readonly includeStreamOptions: boolean;

  constructor(options: OpenAIAdapterOptions = {}) {
    this.providerName = options.providerName ?? PROVIDER_NAME;
    this.apiBase = options.apiBase ?? API_BASE;
    this.maxCompletionTokens = options.maxCompletionTokens ?? MAX_COMPLETION_TOKENS;
    this.includeStreamOptions = options.includeStreamOptions ?? true;
  }

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
      const res = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: request.modelName,
          messages: [
            { role: 'system', content: request.systemInstructions },
            { role: 'user', content: request.userPrompt },
          ],
          temperature: request.temperature,
          max_tokens: estimateMaxOutputTokens(request.outputLength, this.maxCompletionTokens),
          stream: true,
          ...(this.includeStreamOptions ? { stream_options: { include_usage: true } } : {}),
          ...(request.frequencyPenalty !== undefined && request.frequencyPenalty !== 0
            ? { frequency_penalty: request.frequencyPenalty }
            : {}),
          ...(request.presencePenalty !== undefined && request.presencePenalty !== 0
            ? { presence_penalty: request.presencePenalty }
            : {}),
          // NOTE: 構造化 JSON 出力。OpenAI/DeepSeek は response_format で
          // JSON モードを指定できる。scan/chat が使う。
          ...(request.responseMimeType === 'application/json'
            ? { response_format: { type: 'json_object' } }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ModelAdapterError(
          body.error?.message || `OpenAI API error: ${res.status}`,
          mapHttpStatus(res.status, body),
          res.status >= 500 || res.status === 429
        );
      }

      let finishReason: FinishReason = 'stop';
      let rawUsage: AdapterGenerateResult['rawUsage'] | undefined;

      for await (const eventData of readServerSentEvents(res.body)) {
        if (eventData === '[DONE]') break;

        const data = JSON.parse(eventData) as OpenAIStreamChunk;
        const choice = data.choices?.[0];
        const text = choice?.delta?.content;
        if (text) yield { type: 'chunk', text };
        if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
        if (data.usage) {
          rawUsage = {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
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
      const res = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: request.modelName,
          messages: [
            { role: 'system', content: request.systemInstructions },
            { role: 'user', content: request.userPrompt },
          ],
          temperature: request.temperature,
          max_tokens: estimateMaxOutputTokens(request.outputLength, this.maxCompletionTokens),
          ...(request.frequencyPenalty !== undefined && request.frequencyPenalty !== 0
            ? { frequency_penalty: request.frequencyPenalty }
            : {}),
          ...(request.presencePenalty !== undefined && request.presencePenalty !== 0
            ? { presence_penalty: request.presencePenalty }
            : {}),
          // NOTE: 構造化 JSON 出力。OpenAI/DeepSeek は response_format で
          // JSON モードを指定できる。scan/chat が使う。
          ...(request.responseMimeType === 'application/json'
            ? { response_format: { type: 'json_object' } }
            : {}),
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = body.error?.message || `OpenAI API error: ${res.status}`;
        return {
          text: '',
          finishReason: 'error',
          errorCode: mapHttpStatus(res.status, body),
          errorMessage: message,
          retryable: res.status >= 500 || res.status === 429,
        };
      }

      const data = (await res.json()) as {
        choices: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
      };

      const choice = data.choices?.[0];
      const text = choice?.message?.content?.trim() || '';
      const finishReason = mapFinishReason(choice?.finish_reason);

      return {
        text,
        finishReason,
        rawUsage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
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
      const res = await fetch(`${this.apiBase}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
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
    return getCredential(this.providerName);
  }
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

function mapHttpStatus(status: number, body: { error?: { code?: string } }): string {
  if (status === 401) return 'invalid_api_key';
  if (status === 400) return body.error?.code || 'invalid_request_error';
  if (status === 429) return 'rate_limit';
  if (status === 500) return 'server_error';
  if (status === 503) return 'service_unavailable';
  return body.error?.code || 'api_error';
}

function mapFinishReason(reason?: string): FinishReason {
  if (!reason) return 'stop';
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  if (reason === 'content_filter') return 'content_filter';
  return 'error';
}
