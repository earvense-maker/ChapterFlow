import type {
  AdapterGenerateRequest,
  AdapterGenerateResult,
  ConnectionStatus,
  FinishReason,
  ModelConfig,
} from '../types/index.js';
import { ModelAdapter, ModelAdapterError } from './modelAdapter.js';

const PROVIDER_NAME = 'openai';
const API_BASE = 'https://api.openai.com/v1';

export class OpenAIAdapter implements ModelAdapter {
  readonly providerName = PROVIDER_NAME;

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
      const res = await fetch(`${API_BASE}/chat/completions`, {
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
          max_tokens: Math.max(256, Math.round(request.outputLength / 2)),
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
      const res = await fetch(`${API_BASE}/models`, {
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
    return getCredential(PROVIDER_NAME);
  }
}

function mapHttpStatus(status: number, body: { error?: { code?: string } }): string {
  if (status === 401) return 'invalid_api_key';
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
