import { OpenAIAdapter } from './openaiAdapter.js';

const PROVIDER_NAME = 'mimo';
// NOTE: 従量課金（sk-）向けのエンドポイント。Token Plan（tp-）は
// token-plan-cn.xiaomimimo.com と接続先自体が別なので、このアダプタでは扱わない。
const API_BASE = 'https://api.xiaomimimo.com/v1';
// NOTE: 公式ドキュメントの mimo-v2.5 / mimo-v2.5-pro の上限（context 1M / output 128K）。
const MAX_COMPLETION_TOKENS = 128_000;

export class MimoAdapter extends OpenAIAdapter {
  constructor() {
    super({
      providerName: PROVIDER_NAME,
      apiLabel: 'Xiaomi MiMo',
      apiBase: API_BASE,
      maxCompletionTokens: MAX_COMPLETION_TOKENS,
      // NOTE: 公式ドキュメントのリクエスト例は max_completion_tokens を使う。
      // 旧名 max_tokens が読まれる保証がないため、記載どおりの名前で送る。
      maxTokensField: 'max_completion_tokens',
      // NOTE: 下記2つは公式ドキュメントに記載が無い。送って 400 になると生成自体が
      // 止まるので、確認できるまで送らない側に倒す。JSON 応答はサービス側の
      // フェンス対応パーサ（parseJsonObject の戦略2/3）で拾える。
      includeStreamOptions: false,
      supportsJsonResponseFormat: false,
    });
  }

  // NOTE: 公式例は api-key ヘッダ、案内文では Authorization: Bearer も使えるとされる。
  // どちらが正かを実機で確定できないため両方載せる（無視される側は害がない）。
  protected override requestHeaders(apiKey: string): Record<string, string> {
    return {
      ...super.requestHeaders(apiKey),
      'api-key': apiKey,
    };
  }
}
