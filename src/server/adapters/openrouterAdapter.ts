import { mapHttpStatus, OpenAIAdapter } from './openaiAdapter.js';
import type { ConnectionStatus, ModelConfig } from '../types/index.js';

const PROVIDER_NAME = 'openrouter';
const API_BASE = 'https://openrouter.ai/api/v1';
const MAX_COMPLETION_TOKENS = 16_384;
const ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://github.com/earvense-maker/ChapterFlow',
  'X-Title': 'ChapterFlow',
};

export class OpenRouterAdapter extends OpenAIAdapter {
  constructor() {
    super({
      providerName: PROVIDER_NAME,
      apiLabel: 'OpenRouter',
      apiBase: API_BASE,
      maxCompletionTokens: MAX_COMPLETION_TOKENS,
      includeStreamOptions: true,
      // NOTE: openrouter/freeは呼び出しごとに異なる無料モデルを選び得る。
      // モデル互換性を広く保つため、PenaltyはOpenRouterには送らない。
      omitPenaltyFields: true,
      extraHeaders: ATTRIBUTION_HEADERS,
    });
  }

  override async validateConnection(config: ModelConfig): Promise<ConnectionStatus> {
    const apiKey = config.apiKey || (await this.loadApiKey());
    if (!apiKey) {
      return { ok: false, message: 'APIキーが設定されていません', errorCode: 'api_key_missing' };
    }

    try {
      // NOTE: /modelsは公開情報として返る場合があるため、認証確認には/keyを使う。
      const res = await fetch(`${API_BASE}/key`, {
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
}
