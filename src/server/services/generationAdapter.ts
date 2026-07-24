import { ModelAdapter, ModelAdapterError } from '../adapters/modelAdapter.js';
import type { AdapterGenerateResult, AdapterGenerateStreamEvent } from '../types/index.js';
import { GenerateError, mapErrorMessage } from './generationErrors.js';

// NOTE: generationService から切り出したアダプタ呼び出しラッパ。penalty 非対応
// プロバイダ向けの自動リトライ（frequency/presence penalty を外して再送）をここへ
// 集約する。依存は generationErrors のみで、生成本体からは一方向に import される。

export async function generateWithAdapter(
  adapter: ModelAdapter,
  request: Parameters<ModelAdapter['generateText']>[0]
) {
  try {
    const result = await adapter.generateText(request);
    if (shouldRetryWithoutPenalty(result, request)) {
      console.warn('Retrying generation without penalties after invalid argument error', {
        provider: adapter.providerName,
        code: result.errorCode,
        message: result.errorMessage,
      });
      try {
        return await adapter.generateText({
          ...request,
          frequencyPenalty: undefined,
          presencePenalty: undefined,
        });
      } catch (retryErr) {
        if (retryErr instanceof ModelAdapterError) {
          throw new GenerateError(
            mapErrorMessage(retryErr.code, retryErr.message),
            retryErr.code,
            retryErr.retryable
          );
        }
        throw retryErr;
      }
    }
    return result;
  } catch (err) {
    if (
      err instanceof ModelAdapterError &&
      isPenaltyUnsupportedError(err) &&
      hasPenalty(request)
    ) {
      console.warn('Retrying generation without penalties after invalid argument error', {
        provider: adapter.providerName,
        code: err.code,
        message: err.message,
      });
      try {
        return await adapter.generateText({
          ...request,
          frequencyPenalty: undefined,
          presencePenalty: undefined,
        });
      } catch (retryErr) {
        if (retryErr instanceof ModelAdapterError) {
          throw new GenerateError(
            mapErrorMessage(retryErr.code, retryErr.message),
            retryErr.code,
            retryErr.retryable
          );
        }
        throw retryErr;
      }
    }
    if (err instanceof ModelAdapterError) {
      throw new GenerateError(mapErrorMessage(err.code, err.message), err.code, err.retryable);
    }
    throw err;
  }
}

export async function* generateTextStreamWithPenaltyRetry(
  adapter: ModelAdapter,
  request: Parameters<NonNullable<ModelAdapter['generateTextStream']>>[0]
): AsyncGenerator<AdapterGenerateStreamEvent> {
  let yielded = false;
  try {
    for await (const event of adapter.generateTextStream!(request)) {
      yielded = true;
      yield event;
    }
  } catch (err) {
    if (
      !yielded &&
      err instanceof ModelAdapterError &&
      isPenaltyUnsupportedError(err) &&
      hasPenalty(request)
    ) {
      console.warn('Retrying streaming generation without penalties after invalid argument error', {
        provider: adapter.providerName,
        code: err.code,
        message: err.message,
      });
      for await (const event of adapter.generateTextStream!({
        ...request,
        frequencyPenalty: undefined,
        presencePenalty: undefined,
      })) {
        yield event;
      }
      return;
    }
    throw err;
  }
}

function hasPenalty(
  request: Parameters<ModelAdapter['generateText']>[0]
): boolean {
  return Boolean(request.frequencyPenalty || request.presencePenalty);
}

function isPenaltyUnsupportedError(err: ModelAdapterError): boolean {
  return isPenaltyUnsupportedSignal(err.code, err.message);
}

function shouldRetryWithoutPenalty(
  result: AdapterGenerateResult,
  request: Parameters<ModelAdapter['generateText']>[0]
): boolean {
  return (
    result.finishReason === 'error' &&
    hasPenalty(request) &&
    isPenaltyUnsupportedSignal(result.errorCode, result.errorMessage)
  );
}

function isPenaltyUnsupportedSignal(code?: string, message?: string): boolean {
  // NOTE: 非ストリーミング adapters はHTTP 400を例外ではなく結果として返すため、
  // code/message のどちらにプロバイダ固有情報が載っても拾えるようにしている。
  const text = `${code ?? ''} ${message ?? ''}`;
  if (/INVALID_ARGUMENT|invalid_request|unsupported_?param/i.test(text)) return true;
  return code === 'api_error' && /\b400\b|bad request/i.test(message ?? '');
}
