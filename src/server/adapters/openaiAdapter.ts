import type {
  AdapterGenerateRequest,
  AdapterGenerateResult,
  AdapterGenerateStreamEvent,
  ConnectionStatus,
  FinishReason,
  ModelConfig,
} from '../types/index.js';
import { ModelAdapter, ModelAdapterError } from './modelAdapter.js';
import { resolveMaxOutputTokens } from '../utils/outputLength.js';
import { readServerSentEvents } from '../utils/sse.js';

const PROVIDER_NAME = 'openai';
const API_BASE = 'https://api.openai.com/v1';
const MAX_COMPLETION_TOKENS = 16_384;

interface OpenAIAdapterOptions {
  providerName?: string;
  apiLabel?: string;
  apiBase?: string;
  maxCompletionTokens?: number;
  includeStreamOptions?: boolean;
  omitPenaltyFields?: boolean;
  extraHeaders?: Record<string, string>;
  // NOTE: OpenAI 互換を名乗るプロバイダーでも出力上限のフィールド名が割れている。
  // 旧 max_tokens しか読まない実装と、新 max_completion_tokens しか読まない実装が
  // あり、無視される側を送ると上限が効かず生成が伸び続ける。既定は互換性が広い
  // max_tokens のまま、ドキュメントが新名を使うプロバイダーだけ切り替える。
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  // NOTE: JSON モード（response_format）は互換 API でも未対応のことがある。false に
  // すると送らず、各サービスのフェンス対応パーサ側の頑健化に任せる。
  supportsJsonResponseFormat?: boolean;
}

export class OpenAIAdapter implements ModelAdapter {
  readonly providerName: string;
  private readonly apiLabel: string;
  private readonly apiBase: string;
  private readonly maxCompletionTokens: number;
  private readonly includeStreamOptions: boolean;
  private readonly omitPenaltyFields: boolean;
  private readonly extraHeaders: Record<string, string>;
  private readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';
  private readonly supportsJsonResponseFormat: boolean;

  constructor(options: OpenAIAdapterOptions = {}) {
    this.providerName = options.providerName ?? PROVIDER_NAME;
    this.apiLabel = options.apiLabel ?? 'OpenAI';
    this.apiBase = options.apiBase ?? API_BASE;
    this.maxCompletionTokens = options.maxCompletionTokens ?? MAX_COMPLETION_TOKENS;
    this.includeStreamOptions = options.includeStreamOptions ?? true;
    this.omitPenaltyFields = options.omitPenaltyFields ?? false;
    this.extraHeaders = options.extraHeaders ?? {};
    this.maxTokensField = options.maxTokensField ?? 'max_tokens';
    this.supportsJsonResponseFormat = options.supportsJsonResponseFormat ?? true;
  }

  async *generateTextStream(request: AdapterGenerateRequest): AsyncGenerator<AdapterGenerateStreamEvent> {
    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      throw new ModelAdapterError('APIキーが設定されていません', 'api_key_missing', false);
    }

    const controller = new AbortController();
    // NOTE: ストリーミングでは timeoutMs を「総時間」ではなく「無通信時間」として使う。
    // 総時間で切ると、長い本文が順調に流れていても終盤で必ず落ちる（固定120秒だと
    // 3000字級の生成が最後の方で切れて全損する事故が実際に起きた）。SSEイベント受信の
    // たびにリセットするので、reasoning系モデルの思考デルタでもタイマーは維持される。
    let timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    };
    const handleAbort = () => controller.abort();
    if (request.abortSignal?.aborted) {
      clearTimeout(timeout);
      throw new ModelAdapterError('生成が中断されました', 'aborted', false);
    }
    request.abortSignal?.addEventListener('abort', handleAbort, { once: true });

    try {
      const res = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers: this.requestHeaders(apiKey),
        body: JSON.stringify({
          model: request.modelName,
          messages: [
            { role: 'system', content: request.systemInstructions },
            { role: 'user', content: request.userPrompt },
          ],
          temperature: request.temperature,
          [this.maxTokensField]: resolveMaxOutputTokens(request, this.maxCompletionTokens),
          stream: true,
          ...(this.includeStreamOptions ? { stream_options: { include_usage: true } } : {}),
          ...(!this.omitPenaltyFields && request.frequencyPenalty !== undefined && request.frequencyPenalty !== 0
            ? { frequency_penalty: request.frequencyPenalty }
            : {}),
          ...(!this.omitPenaltyFields && request.presencePenalty !== undefined && request.presencePenalty !== 0
            ? { presence_penalty: request.presencePenalty }
            : {}),
          // NOTE: 構造化 JSON 出力。OpenAI互換プロバイダーは response_format で
          // JSON モードを指定できる。scan/chat が使う。
          ...(this.supportsJsonResponseFormat && request.responseMimeType === 'application/json'
            ? { response_format: { type: 'json_object' } }
            : {}),
          ...this.extraBodyFields(request),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ModelAdapterError(
          body.error?.message || `${this.apiLabel} API error: ${res.status}`,
          mapHttpStatus(res.status, body),
          isRetryableStatus(res.status)
        );
      }

      let finishReason: FinishReason = 'stop';
      let rawUsage: AdapterGenerateResult['rawUsage'] | undefined;
      let resolvedModelName: string | undefined;
      let sawTerminalMarker = false;

      for await (const eventData of readServerSentEvents(res.body, resetTimeout)) {
        if (eventData === '[DONE]') {
          sawTerminalMarker = true;
          break;
        }

        const data = JSON.parse(eventData) as OpenAIStreamChunk;
        if (data.error) {
          const status = normalizeErrorStatus(data.error.code);
          throw new ModelAdapterError(
            data.error.message || `${this.apiLabel} streaming error`,
            mapProviderError(data.error),
            isRetryableStatus(status)
          );
        }
        if (data.model) resolvedModelName = data.model;
        const choice = data.choices?.[0];
        const text = choice?.delta?.content;
        if (text) yield { type: 'chunk', text };
        if (choice?.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
          sawTerminalMarker = true;
        }
        if (data.usage) {
          rawUsage = {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          };
        }
      }

      if (!sawTerminalMarker) {
        throw new ModelAdapterError(
          `${this.apiLabel} のストリーミング応答が完了前に終了しました`,
          'stream_ended_unexpectedly',
          true
        );
      }

      yield {
        type: 'done',
        finishReason,
        rawUsage,
        ...(resolvedModelName ? { resolvedModelName } : {}),
      };
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
      controller.abort();
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
        headers: this.requestHeaders(apiKey),
        body: JSON.stringify({
          model: request.modelName,
          messages: [
            { role: 'system', content: request.systemInstructions },
            { role: 'user', content: request.userPrompt },
          ],
          temperature: request.temperature,
          [this.maxTokensField]: resolveMaxOutputTokens(request, this.maxCompletionTokens),
          ...(!this.omitPenaltyFields && request.frequencyPenalty !== undefined && request.frequencyPenalty !== 0
            ? { frequency_penalty: request.frequencyPenalty }
            : {}),
          ...(!this.omitPenaltyFields && request.presencePenalty !== undefined && request.presencePenalty !== 0
            ? { presence_penalty: request.presencePenalty }
            : {}),
          // NOTE: 構造化 JSON 出力。OpenAI互換プロバイダーは response_format で
          // JSON モードを指定できる。scan/chat が使う。
          ...(this.supportsJsonResponseFormat && request.responseMimeType === 'application/json'
            ? { response_format: { type: 'json_object' } }
            : {}),
          ...this.extraBodyFields(request),
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = body.error?.message || `${this.apiLabel} API error: ${res.status}`;
        return {
          text: '',
          finishReason: 'error',
          errorCode: mapHttpStatus(res.status, body),
          errorMessage: message,
          retryable: isRetryableStatus(res.status),
        };
      }

      const data = (await res.json()) as {
        model?: string;
        choices: Array<{
          // NOTE: reasoning_content は DeepSeek 等の思考モデルが返す拡張フィールド。
          message?: { content?: string; reasoning_content?: string };
          finish_reason?: string;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
        error?: OpenAIProviderError;
      };

      if (data.error) {
        const status = normalizeErrorStatus(data.error.code);
        return {
          text: '',
          finishReason: 'error',
          errorCode: mapProviderError(data.error),
          errorMessage: data.error.message,
          retryable: isRetryableStatus(status),
        };
      }

      const choice = data.choices?.[0];
      const text = choice?.message?.content?.trim() || '';
      const finishReason = mapFinishReason(choice?.finish_reason);
      // NOTE: 思考モードのモデルは本文を content、思考を reasoning_content に分けて返す。
      // 本文が空で reasoning_content だけが埋まっている状態は「モデルが答えを思考側へ
      // 出してしまった」ことを意味し、空応答の原因として content だけ見ていても分からない。
      const reasoningLength = choice?.message?.reasoning_content?.trim().length ?? 0;
      const debugInfo =
        !text && reasoningLength > 0
          ? `content=empty reasoning_content=${reasoningLength}chars finish=${choice?.finish_reason ?? 'none'}`
          : undefined;

      return {
        text,
        finishReason,
        ...(debugInfo ? { debugInfo } : {}),
        rawUsage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
        retryable: finishReason === 'error',
        ...(data.model ? { resolvedModelName: data.model } : {}),
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
        headers: this.requestHeaders(apiKey),
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

  protected async loadApiKey(): Promise<string | undefined> {
    const { getCredential } = await import('../services/credentialService.js');
    return getCredential(this.providerName);
  }

  protected requestHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...this.extraHeaders,
    };
  }

  // NOTE: OpenAI 互換を名乗っていても、思考モードの制御のようにプロバイダー独自の
  // フィールドが必要な場面がある。共通のボディに条件分岐を足していくと読めなくなるので、
  // 派生アダプタがここで差分だけを返す。共通フィールドより後に展開される。
  protected extraBodyFields(_request: AdapterGenerateRequest): Record<string, unknown> {
    return {};
  }
}

interface OpenAIProviderError {
  code?: string | number;
  message?: string;
  metadata?: { error_type?: string; provider_code?: string };
}

interface OpenAIStreamChunk {
  model?: string;
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
  error?: OpenAIProviderError;
}

export function mapHttpStatus(status: number, body: { error?: OpenAIProviderError }): string {
  if (status === 401) return 'invalid_api_key';
  if (status === 400) return mapProviderError(body.error, 'invalid_request_error');
  if (status === 402) return 'payment_required';
  if (status === 403) return 'permission_denied';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 500) return 'server_error';
  if (status === 502) return 'service_unavailable';
  if (status === 503) return 'service_unavailable';
  if (status === 504) return 'timeout';
  return mapProviderError(body.error, 'api_error');
}

function mapProviderError(error?: OpenAIProviderError, fallback = 'api_error'): string {
  const typed = error?.metadata?.error_type;
  if (typed === 'authentication') return 'invalid_api_key';
  if (typed === 'payment_required') return 'payment_required';
  if (typed === 'permission_denied') return 'permission_denied';
  if (typed === 'rate_limit_exceeded') return 'rate_limit';
  if (typed === 'provider_overloaded' || typed === 'provider_unavailable') {
    return 'service_unavailable';
  }
  if (typed === 'content_policy_violation' || typed === 'refusal') return 'content_filter';
  if (typed === 'timeout') return 'timeout';
  // NOTE: OpenRouterはmetadata.error_typeなしで数値のHTTPステータスをcodeに入れて
  // 返すことがある。retryable判定(normalizeErrorStatus)と同様にステータスとして解釈する。
  if (typeof error?.code === 'number') return mapHttpStatus(error.code, {});
  return typeof error?.code === 'string' && error.code ? error.code : fallback;
}

function normalizeErrorStatus(code?: string | number): number {
  if (typeof code === 'number') return code;
  const parsed = Number(code);
  return Number.isFinite(parsed) ? parsed : 500;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function mapFinishReason(reason?: string): FinishReason {
  if (!reason) return 'stop';
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  if (reason === 'content_filter') return 'content_filter';
  return 'error';
}
