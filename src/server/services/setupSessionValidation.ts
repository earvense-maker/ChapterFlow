import { isSupportedProvider } from './modelInfoService.js';
import type { CreateSetupSessionBody, SetupSession } from '../types/index.js';
import { SetupServiceError } from './setupSessionErrors.js';
import { isRecord } from './setupSessionParsing.js';

// NOTE: setupSessionService から切り出した入力検証・正規化。作成リクエストの形式検証、
// リビジョン整合（楽観ロック）の確認、プロバイダ／出力文字数の正規化をまとめる。
// 依存は setupSessionErrors / setupSessionParsing の葉モジュールのみ（一方向）。

const DEFAULT_MODEL_PROVIDER = 'gemini';
const INITIAL_MESSAGE_MAX_CHARS = 4_000;
const SETUP_TITLE_MAX_CHARS = 100;
const MODEL_NAME_MAX_CHARS = 200;

export function assertRevision(session: SetupSession, revision: number): void {
  if (session.revision !== revision) {
    throw new SetupServiceError(
      '相談メモが更新されています。最新の内容を確認してください。',
      'revision_conflict',
      false,
      409,
      session
    );
  }
}

export function assertValidRevision(revision: unknown): asserts revision is number {
  if (typeof revision !== 'number' || !Number.isInteger(revision)) {
    throw new SetupServiceError('リクエストの形式が不正です。', 'invalid_request', false, 400);
  }
}

export function assertValidCreateSetupSessionBody(
  value: unknown
): asserts value is CreateSetupSessionBody {
  if (!isRecord(value)) {
    throw invalidCreateRequest('リクエスト本文はオブジェクトで指定してください。');
  }

  if (
    value.initialMessage !== undefined &&
    (typeof value.initialMessage !== 'string' ||
      value.initialMessage.length > INITIAL_MESSAGE_MAX_CHARS)
  ) {
    throw invalidCreateRequest(
      `最初のメッセージは${INITIAL_MESSAGE_MAX_CHARS.toLocaleString('ja-JP')}文字以内で指定してください。`
    );
  }

  if (value.model !== undefined) {
    if (!isRecord(value.model)) {
      throw invalidCreateRequest('モデル設定が不正です。');
    }
    const provider = value.model.provider;
    if (provider !== undefined && typeof provider !== 'string') {
      throw invalidCreateRequest('モデルプロバイダーが不正です。');
    }
    if (typeof provider === 'string' && provider.trim() && !isSupportedProvider(provider)) {
      throw new SetupServiceError(
        '未対応のモデルプロバイダーです。',
        'unsupported_provider',
        false,
        400
      );
    }
    if (
      value.model.modelName !== undefined &&
      (typeof value.model.modelName !== 'string' ||
        value.model.modelName.length > MODEL_NAME_MAX_CHARS)
    ) {
      throw invalidCreateRequest(
        `モデル名は${MODEL_NAME_MAX_CHARS.toLocaleString('ja-JP')}文字以内で指定してください。`
      );
    }
  }

  if (value.projectSettings !== undefined) {
    if (!isRecord(value.projectSettings)) {
      throw invalidCreateRequest('作品設定が不正です。');
    }
    const settings = value.projectSettings;
    if (
      settings.title !== undefined &&
      (typeof settings.title !== 'string' || settings.title.length > SETUP_TITLE_MAX_CHARS)
    ) {
      throw invalidCreateRequest(
        `タイトルは${SETUP_TITLE_MAX_CHARS.toLocaleString('ja-JP')}文字以内で指定してください。`
      );
    }
    if (
      settings.outputLength !== undefined &&
      (typeof settings.outputLength !== 'number' || !Number.isFinite(settings.outputLength))
    ) {
      throw invalidCreateRequest('出力文字数が不正です。');
    }
    if (
      settings.streamingEnabled !== undefined &&
      typeof settings.streamingEnabled !== 'boolean'
    ) {
      throw invalidCreateRequest('ストリーミング設定が不正です。');
    }
    if (
      settings.activePresetIds !== undefined &&
      !isRecord(settings.activePresetIds)
    ) {
      throw invalidCreateRequest('プリセット設定が不正です。');
    }
  }
}

function invalidCreateRequest(message: string): SetupServiceError {
  return new SetupServiceError(message, 'invalid_request', false, 400);
}

export function normalizeProvider(value: string | undefined): string {
  return value && isSupportedProvider(value) ? value : DEFAULT_MODEL_PROVIDER;
}

export function normalizeOutputLength(value: number | undefined): number {
  if (!Number.isFinite(value)) return 3000;
  return Math.max(500, Math.min(10000, Math.round(value as number)));
}
