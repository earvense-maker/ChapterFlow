import { OpenAIAdapter } from './openaiAdapter.js';
import type { AdapterGenerateRequest } from '../types/index.js';

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

  // NOTE: v4 系は思考モードが既定で有効。JSON 出力と併用すると、モデルが最終回答まで
  // reasoning_content 側へ書いてしまい content が空で返る（deepseek-v4-flash で実際に
  // 発生: finishReason=stop・本文0字）。JSON を組み立てるだけの用途に長考は要らないので、
  // responseMimeType=json のときだけ思考を切る。本文生成ではプロバイダー既定値の
  // 変更に影響されないよう、思考有効・reasoning effort high を明示する。
  protected override extraBodyFields(
    request: AdapterGenerateRequest
  ): Record<string, unknown> {
    if (request.responseMimeType === 'application/json') {
      return { thinking: { type: 'disabled' } };
    }
    if (request.modelName.trim().toLowerCase() === 'deepseek-v4-flash') {
      return { thinking: { type: 'enabled' }, reasoning_effort: 'high' };
    }
    return {};
  }
}
