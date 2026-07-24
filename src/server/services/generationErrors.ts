// NOTE: generationService から切り出したエラー整形の純粋ヘルパー群。ここは他の
// モジュールへ依存しない葉ノードなので、生成本体・物語状態・アダプタ呼び出しの
// いずれからも安全に import できる（循環を作らない）。

export class GenerateError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'GenerateError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new GenerateError('生成が中断されました。', 'aborted', false);
  }
}

// NOTE: adapter が空応答時に埋める debugInfo からセーフティ由来かを判定する。
// promptFeedback.blockReason（PROHIBITED_CONTENT / SAFETY 等）か、blocked=true の
// candidateSafety が入っていれば「解除できない安全フィルタ」と見なす。HIGH でも
// blocked=false の評価はあり得るため、確率だけではブロック扱いにしない。
export function classifyEmptyResponse(debugInfo?: string): { code: string; retryable: boolean } {
  if (isSafetyBlockedDiagnostic(debugInfo)) {
    return { code: 'safety_blocked', retryable: false };
  }
  return { code: 'empty_response', retryable: true };
}

export function isSafetyBlockedDiagnostic(debugInfo?: string): boolean {
  return Boolean(
    debugInfo &&
      (/promptBlockReason=/.test(debugInfo) || /candidateSafety=\S*\(blocked\)/.test(debugInfo))
  );
}

export function mapErrorMessage(code?: string, detail?: string): string {
  let base: string;
  switch (code) {
    case 'api_key_missing':
      base = 'APIキーが設定されていません。設定画面からAPIキーを入力してください。';
      break;
    case 'invalid_api_key':
      base = 'APIキーが無効です。設定を確認してください。';
      break;
    case 'payment_required':
      base = 'APIキーのクレジットが不足しています。プロバイダー側の残高や利用上限を確認してください。';
      break;
    case 'permission_denied':
      base = 'APIキーにこのモデルを利用する権限がないか、プロバイダー側で拒否されました。';
      break;
    case 'rate_limit':
      base = 'リクエスト制限に達しました。しばらくしてから再試行してください。';
      break;
    case 'timeout':
      base = '生成がタイムアウトしました。出力文量を下げるか、再試行してください。';
      break;
    case 'aborted':
      base = '生成が中断されました。';
      break;
    case 'network_error':
      base = 'モデルサービスに接続できませんでした。ネットワーク設定を確認して再試行してください。';
      break;
    case 'server_error':
    case 'service_unavailable':
      base = 'モデルサービスで一時的な問題が発生しました。再試行してください。';
      break;
    case 'content_filter':
    case 'safety_blocked':
      base =
        'AIの安全フィルタでブロックされ、本文が生成されませんでした。Geminiは解除できない固定フィルタ（PROHIBITED_CONTENT等）を持つため、創作用途では設定画面からDeepSeekへの切り替えをおすすめします。';
      break;
    case 'empty_response':
      base =
        'モデルからの本文が空でした。出力上限（maxOutputTokens）が不足しているか、モデル名が誤っている可能性があります。';
      break;
    default:
      base = '生成に失敗しました。設定画面のプロバイダー、モデル名、APIキーを確認してください。';
  }

  const safeDetail = sanitizeErrorDetail(detail);
  if (!safeDetail || safeDetail === base) return base;
  return `${base}\n詳細: ${safeDetail}`;
}

export function sanitizeErrorDetail(detail?: string): string {
  if (!detail) return '';
  const collapsed = detail.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > 500 ? `${collapsed.slice(0, 500)}...` : collapsed;
}
