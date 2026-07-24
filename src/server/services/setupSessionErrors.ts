import { ModelAdapterError } from '../adapters/modelAdapter.js';
import type { SetupSession } from '../types/index.js';

// NOTE: setupSessionService から切り出したエラー型とメッセージ整形。相談セッションの
// 各操作が共通で投げる SetupServiceError と、アダプタ結果／例外をそれへ正規化する
// ヘルパーをまとめる。他モジュールへ依存しない葉ノード。

export class SetupServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number,
    public readonly session?: SetupSession
  ) {
    super(message);
    this.name = 'SetupServiceError';
  }
}

export function mapErrorMessage(code: string, detail?: string): string {
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
      base = '生成がタイムアウトしました。少し待って再試行してください。';
      break;
    case 'service_unavailable':
      base = 'モデルサービスを現在利用できません。少し待って再試行してください。';
      break;
    default:
      base = '相談処理に失敗しました。設定を確認して再試行してください。';
  }
  return detail && detail !== base ? `${base}\n詳細: ${detail}` : base;
}

export function adapterResultToError(result: {
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
}): SetupServiceError {
  const code = result.errorCode || 'setup_generation_failed';
  return new SetupServiceError(
    mapErrorMessage(code, result.errorMessage),
    code,
    result.retryable,
    503
  );
}

export function toSetupServiceError(err: unknown, session?: SetupSession): SetupServiceError {
  if (err instanceof SetupServiceError) {
    return session && !err.session
      ? new SetupServiceError(err.message, err.code, err.retryable, err.status, session)
      : err;
  }
  if (err instanceof ModelAdapterError) {
    return new SetupServiceError(err.message, err.code, err.retryable, 503, session);
  }
  return new SetupServiceError(
    err instanceof Error ? err.message : '相談処理に失敗しました。',
    'setup_failed',
    true,
    503,
    session
  );
}
