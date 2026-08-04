import { OpenAIAdapter } from './openaiAdapter.js';
import type { AdapterGenerateRequest } from '../types/index.js';

const PROVIDER_NAME = 'deepseek';
const API_BASE = 'https://api.deepseek.com';
const MAX_COMPLETION_TOKENS = 384_000;

// NOTE: V4 系は思考モードが既定で有効。JSON 出力と併用すると、モデルが最終回答まで
// reasoning_content 側へ書いてしまい content が空で返る（deepseek-v4-flash で実際に
// 発生: finishReason=stop・本文0字）。JSON を組み立てるだけの用途に長考は要らないので、
// responseMimeType=json のときだけ思考を切る。本文生成ではプロバイダー既定値の
// 変更に影響されないよう、思考有効・reasoning effort high を明示する。
//
// NOTE: 既定の 'high' は小説本文向けのチューニング。相談チャットのような短い応答にも
// そのまま効いてしまい、思考が max_tokens を食い尽くして本文0字になった。呼び出し側が
// 用途に応じて落とせるよう reasoningEffort を優先する。
//
// NOTE: reasoningMode が指定されたときは JSON 指定より明示を優先する。AI 相談は
// JSON 出力を維持したまま thinking を有効にしたいので、呼び出し側が
// reasoningMode: 'enabled' でその意図を表明する（設計書 5.2）。
export function isDeepSeekV4Model(modelName: string): boolean {
  const name = modelName.trim().toLowerCase();
  return name === 'deepseek-v4-flash' || name === 'deepseek-v4-pro';
}

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

  protected override extraBodyFields(
    request: AdapterGenerateRequest
  ): Record<string, unknown> {
    // NOTE: 呼び出し側の明示指定を優先する（設計書 5.2 の優先順位）。
    if (request.reasoningMode === 'disabled') {
      return { thinking: { type: 'disabled' } };
    }
    if (request.reasoningMode === 'enabled') {
      if (isDeepSeekV4Model(request.modelName)) {
        // NOTE: V4 は low / medium を high として扱うため、送信値も high に正規化して
        // リクエストと実効値を一致させる。
        return {
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
        };
      }
      // NOTE: 未知・旧モデルへ未確認パラメータを強制しない。JSON なら従来どおり
      // thinking 無効、非 JSON ならプロバイダー既定に任せる。
      return request.responseMimeType === 'application/json'
        ? { thinking: { type: 'disabled' } }
        : {};
    }
    if (request.responseMimeType === 'application/json') {
      return { thinking: { type: 'disabled' } };
    }
    if (request.modelName.trim().toLowerCase() === 'deepseek-v4-flash') {
      return {
        thinking: { type: 'enabled' },
        reasoning_effort: request.reasoningEffort ?? 'high',
      };
    }
    return {};
  }
}
