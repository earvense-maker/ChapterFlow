// NOTE: 本編生成・setup 相談・roleplay 応答・会話要約が共通で使う、
// 「adapter 解決 + credential 再読込 + 非ストリーミング/ストリーミング呼び出し
// + ModelAdapterError の統一変換」の薄い共通層。設計書 3.3 の「アダプタ分岐を
// 複製しない」方針を実現するためのモジュール。
//
// スコープを絞る:
//  - penalty のリトライ、banned expressions、context assembler など「本編生成
//    固有」の処理は含めない（generationService に残す）。
//  - Setup 側の DRAFT_PATCH_MARKER の抽出も含めない（プロンプト応答の解釈は
//    呼び出し側の責務）。
//
// これにより、roleplaySessionService はこのモジュールだけを使えば
// 「provider の解決 → credential ロード → generate/stream → エラー正規化」まで
// 一式が揃う。

import { OpenAIAdapter } from '../adapters/openaiAdapter.js';
import { GeminiAdapter } from '../adapters/geminiAdapter.js';
import { DeepSeekAdapter } from '../adapters/deepseekAdapter.js';
import { XAIAdapter } from '../adapters/xaiAdapter.js';
import { ModelAdapter, ModelAdapterError } from '../adapters/modelAdapter.js';
import { reloadCredentials } from './credentialService.js';
import type {
  AdapterGenerateRequest,
  AdapterGenerateResult,
  AdapterGenerateStreamEvent,
} from '../types/index.js';

// NOTE: 各サービスが個別に new していた adapter インスタンスをここに集約する。
// ModelAdapter は状態を持たない想定なので、プロセス単一で使い回して問題ない。
const adapterMap: Record<string, ModelAdapter> = {
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
  deepseek: new DeepSeekAdapter(),
  xai: new XAIAdapter(),
};

export class ModelClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'ModelClientError';
  }
}

export function resolveAdapter(provider: string): ModelAdapter {
  const adapter = adapterMap[provider];
  if (!adapter) {
    throw new ModelClientError(
      `Unsupported provider: ${provider}`,
      'unsupported_provider',
      false
    );
  }
  return adapter;
}

export function supportsStreaming(provider: string): boolean {
  const adapter = adapterMap[provider];
  return Boolean(adapter?.generateTextStream);
}

// NOTE: credential の再読込は毎回行う（設定画面での APIキー変更が即反映される
// ため）。generationService / setupSessionService も同じ流儀。
export async function ensureReadyToGenerate(): Promise<void> {
  await reloadCredentials();
}

export async function runNonStreaming(
  provider: string,
  request: AdapterGenerateRequest
): Promise<AdapterGenerateResult> {
  const adapter = resolveAdapter(provider);
  await ensureReadyToGenerate();
  try {
    return await adapter.generateText(request);
  } catch (err) {
    if (err instanceof ModelAdapterError) {
      throw new ModelClientError(err.message, err.code, err.retryable);
    }
    throw err;
  }
}

// NOTE: ストリーミング未実装 adapter でも呼び出し側が同じインターフェイスで
// 使えるように、非ストリーミング結果を1chunkとして流し込むフォールバックを
// 内包する。generationService の従来動作と揃える。
export async function* runStreaming(
  provider: string,
  request: AdapterGenerateRequest
): AsyncGenerator<AdapterGenerateStreamEvent> {
  const adapter = resolveAdapter(provider);
  await ensureReadyToGenerate();

  if (!adapter.generateTextStream) {
    try {
      const result = await adapter.generateText(request);
      if (result.text) yield { type: 'chunk', text: result.text };
      yield {
        type: 'done',
        finishReason: result.finishReason,
        rawUsage: result.rawUsage,
        debugInfo: result.debugInfo,
      };
      return;
    } catch (err) {
      if (err instanceof ModelAdapterError) {
        throw new ModelClientError(err.message, err.code, err.retryable);
      }
      throw err;
    }
  }

  try {
    for await (const event of adapter.generateTextStream(request)) {
      yield event;
    }
  } catch (err) {
    if (err instanceof ModelAdapterError) {
      throw new ModelClientError(err.message, err.code, err.retryable);
    }
    throw err;
  }
}
