import { OpenAIAdapter } from './openaiAdapter.js';

const PROVIDER_NAME = 'deepseek';
const API_BASE = 'https://api.deepseek.com';
const MAX_COMPLETION_TOKENS = 384_000;

export class DeepSeekAdapter extends OpenAIAdapter {
  constructor() {
    super({
      providerName: PROVIDER_NAME,
      apiLabel: 'DeepSeek',
      apiBase: API_BASE,
      maxCompletionTokens: MAX_COMPLETION_TOKENS,
      // NOTE: DeepSeek も OpenAI 互換で stream_options.include_usage をサポートする
      // ようになったので有効化。streaming 中の usageMetadata を context 残量計算に流す。
      // もし将来 400 が出るモデルが現れたら、その時 false に戻す。
      includeStreamOptions: true,
    });
  }
}
