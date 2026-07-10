import { OpenAIAdapter } from './openaiAdapter.js';
import type {
  AdapterGenerateRequest,
  AdapterGenerateResult,
  AdapterGenerateStreamEvent,
} from '../types/index.js';

const PROVIDER_NAME = 'xai';
const API_BASE = 'https://api.x.ai/v1';
const MAX_COMPLETION_TOKENS = 16_384;
const MIN_TIMEOUT_MS = 360_000;

export class XAIAdapter extends OpenAIAdapter {
  constructor() {
    super({
      providerName: PROVIDER_NAME,
      apiLabel: 'xAI',
      apiBase: API_BASE,
      maxCompletionTokens: MAX_COMPLETION_TOKENS,
      includeStreamOptions: true,
      // NOTE: Grok 4.3/4.5 are reasoning models. xAI rejects presence/frequency
      // penalties for reasoning models, so project sampling penalties are omitted.
      omitPenaltyFields: true,
    });
  }

  override generateText(request: AdapterGenerateRequest): Promise<AdapterGenerateResult> {
    return super.generateText(withXaiTimeout(request));
  }

  override async *generateTextStream(
    request: AdapterGenerateRequest
  ): AsyncGenerator<AdapterGenerateStreamEvent> {
    yield* super.generateTextStream(withXaiTimeout(request));
  }
}

function withXaiTimeout(request: AdapterGenerateRequest): AdapterGenerateRequest {
  // NOTE: xAIのGrok 4.3/4.5は推論モデル。短い補助処理も思考時間を使うため、
  // 各サービスの通常timeoutよりxAI公式例に近い下限を優先する。
  return { ...request, timeoutMs: Math.max(request.timeoutMs, MIN_TIMEOUT_MS) };
}
