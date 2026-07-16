import type {
  AdapterGenerateRequest,
  AdapterGenerateResult,
  AdapterGenerateStreamEvent,
  ConnectionStatus,
  FinishReason,
  ModelConfig,
} from '../types/index.js';
import { ModelAdapter, ModelAdapterError } from './modelAdapter.js';
import { estimateMaxOutputTokens } from '../utils/outputLength.js';
import { readServerSentEvents } from '../utils/sse.js';

const PROVIDER_NAME = 'gemini';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.5-flash';
const MAX_OUTPUT_TOKENS = 65_536;

export class GeminiAdapter implements ModelAdapter {
  readonly providerName = PROVIDER_NAME;

  async *generateTextStream(request: AdapterGenerateRequest): AsyncGenerator<AdapterGenerateStreamEvent> {
    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      throw new ModelAdapterError('APIキーが設定されていません', 'api_key_missing', false);
    }

    const controller = new AbortController();
    // NOTE: ストリーミングでは timeoutMs を「総時間」ではなく「無通信時間」として使う
    // （openaiAdapter と同じ方針。総時間だと長い生成が終盤で必ず切れる）。
    let timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    };
    const handleAbort = () => controller.abort();
    if (request.abortSignal?.aborted) {
      throw new ModelAdapterError('生成が中断されました', 'aborted', false);
    }
    request.abortSignal?.addEventListener('abort', handleAbort, { once: true });

    try {
      const modelName = normalizeModelName(request.modelName || DEFAULT_MODEL);
      const res = await fetch(
        `${API_BASE}/models/${modelName}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: geminiHeaders(apiKey),
          body: JSON.stringify(buildRequestBody(request)),
          signal: controller.signal,
        }
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ModelAdapterError(
          body.error?.message || `Gemini API error: ${res.status}`,
          mapHttpStatus(res.status, body),
          res.status >= 500 || res.status === 429
        );
      }

      let finishReason: FinishReason = 'stop';
      let rawUsage: AdapterGenerateResult['rawUsage'] | undefined;
      let anyChunkYielded = false;
      let diagnosticData: GeminiGenerateContentResponse | null = null;

      for await (const eventData of readServerSentEvents(res.body, resetTimeout)) {
        const data = JSON.parse(eventData) as GeminiGenerateContentResponse;
        diagnosticData = mergeDiagnosticData(diagnosticData, data);
        const candidate = data.candidates?.[0];
        const text = extractVisibleText(candidate?.content?.parts);

        if (text) {
          anyChunkYielded = true;
          yield { type: 'chunk', text };
        }
        if (candidate?.finishReason) finishReason = mapFinishReason(candidate.finishReason);
        if (data.usageMetadata) {
          rawUsage = {
            promptTokens: data.usageMetadata.promptTokenCount ?? 0,
            completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: data.usageMetadata.totalTokenCount ?? 0,
          };
        }
      }

      const debugInfo =
        !anyChunkYielded || finishReason === 'content_filter'
          ? buildEmptyResponseDebugInfo(diagnosticData, finishReason)
          : undefined;
      yield { type: 'done', finishReason, rawUsage, debugInfo };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (request.abortSignal?.aborted) {
          throw new ModelAdapterError('生成が中断されました', 'aborted', false);
        }
        throw new ModelAdapterError('生成がタイムアウトしました', 'timeout', true);
      }
      if (err instanceof ModelAdapterError) throw err;
      throw new ModelAdapterError(
        err instanceof Error ? err.message : 'Unknown error',
        'network_error',
        true
      );
    } finally {
      clearTimeout(timeout);
      request.abortSignal?.removeEventListener('abort', handleAbort);
    }
  }

  async generateText(request: AdapterGenerateRequest): Promise<AdapterGenerateResult> {
    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      return {
        text: '',
        finishReason: 'error',
        errorCode: 'api_key_missing',
        retryable: false,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const modelName = normalizeModelName(request.modelName || DEFAULT_MODEL);
      const res = await fetch(
        `${API_BASE}/models/${modelName}:generateContent`,
        {
          method: 'POST',
          headers: geminiHeaders(apiKey),
          body: JSON.stringify(buildRequestBody(request)),
          signal: controller.signal,
        }
      );

      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = body.error?.message || `Gemini API error: ${res.status}`;
        return {
          text: '',
          finishReason: 'error',
          errorCode: mapHttpStatus(res.status, body),
          errorMessage: message,
          retryable: res.status >= 500 || res.status === 429,
        };
      }

      const data = (await res.json()) as GeminiGenerateContentResponse;
      const candidate = data.candidates?.[0];
      const text = extractVisibleText(candidate?.content?.parts).trim();
      const finishReason = mapFinishReason(candidate?.finishReason);
      const debugInfo =
        !text || finishReason === 'content_filter'
          ? buildEmptyResponseDebugInfo(data, finishReason)
          : undefined;

      return {
        text,
        finishReason,
        rawUsage: data.usageMetadata
          ? {
              promptTokens: data.usageMetadata.promptTokenCount ?? 0,
              completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
              totalTokens: data.usageMetadata.totalTokenCount ?? 0,
            }
          : undefined,
        retryable: finishReason === 'error',
        debugInfo,
      };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          text: '',
          finishReason: 'timeout',
          errorCode: 'timeout',
          retryable: true,
        };
      }
      throw new ModelAdapterError(
        err instanceof Error ? err.message : 'Unknown error',
        'network_error',
        true
      );
    }
  }

  async validateConnection(config: ModelConfig): Promise<ConnectionStatus> {
    const apiKey = config.apiKey || (await this.loadApiKey());
    if (!apiKey) {
      return { ok: false, message: 'APIキーが設定されていません', errorCode: 'api_key_missing' };
    }

    try {
      const res = await fetch(`${API_BASE}/models`, {
        headers: geminiHeaders(apiKey),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return {
          ok: false,
          message: body.error?.message || `HTTP ${res.status}`,
          errorCode: mapHttpStatus(res.status, body),
        };
      }
      return { ok: true, message: '接続できました' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : '接続に失敗しました',
        errorCode: 'network_error',
      };
    }
  }

  private async loadApiKey(): Promise<string | undefined> {
    const { getCredential } = await import('../services/credentialService.js');
    return getCredential(PROVIDER_NAME);
  }
}

// NOTE: 創作用途のため全カテゴリで安全フィルタをオフにする。ブロック時は Gemini が
// 本文を空にして finishReason=SAFETY を返すため、通常の生成が沈黙で失敗する事故を防ぐ。
const CREATIVE_SAFETY_SETTINGS: Array<{ category: string; threshold: 'BLOCK_NONE' }> = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
];

function buildRequestBody(request: AdapterGenerateRequest): unknown {
  const systemInstructions = request.systemInstructions.trim();
  const body: {
    contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
    systemInstruction?: { parts: Array<{ text: string }> };
    safetySettings: typeof CREATIVE_SAFETY_SETTINGS;
    generationConfig: {
      temperature: number;
      maxOutputTokens: number;
      thinkingConfig?: { thinkingLevel: 'high'; includeThoughts?: boolean };
      responseMimeType?: string;
    };
  } = {
    contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
    safetySettings: CREATIVE_SAFETY_SETTINGS,
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: estimateMaxOutputTokens(request.outputLength, MAX_OUTPUT_TOKENS),
    },
  };

  // NOTE: Gemini 3.xでは数値のthinkingBudgetではなくthinkingLevelを使う。
  // 2.5系はthinkingLevel非対応なので設定を省略し、モデル既定のthinkingに任せる。
  if (/^gemini-3(?:[.-]|$)/i.test(normalizeModelName(request.modelName))) {
    body.generationConfig.thinkingConfig = {
      thinkingLevel: 'high',
      includeThoughts: false,
    };
  }

  // NOTE: 構造化 JSON 出力（Structured Output）。scan / chat のように JSON を
  // 期待する呼び出しでは前置き文やコードフェンスの混入を防げる。
  if (request.responseMimeType) {
    body.generationConfig.responseMimeType = request.responseMimeType;
  }

  // NOTE: 機能ごとのシステム指示を先頭からそのまま送る。Gemini専用の固定文を
  // 足すと、設定相談などフィクション以外の呼び出しにも不要な語が混ざるため付加しない。
  if (systemInstructions) {
    body.systemInstruction = { parts: [{ text: systemInstructions }] };
  }

  // NOTE: Gemini 3.xではpenalty指定がINVALID_ARGUMENTになる環境があるため送らない。
  // 設定値は他プロバイダー用に保持し、Gemini側だけ無効化する。

  return body;
}

function normalizeModelName(modelName: string): string {
  return modelName.replace(/^models\//, '');
}

function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: unknown;
  inlineData?: unknown;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
  safetyRatings?: Array<{ category?: string; probability?: string; blocked?: boolean }>;
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<{ category?: string; probability?: string; blocked?: boolean }>;
  };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

function mergeDiagnosticData(
  current: GeminiGenerateContentResponse | null,
  next: GeminiGenerateContentResponse
): GeminiGenerateContentResponse {
  const currentCandidate = current?.candidates?.[0];
  const nextCandidate = next.candidates?.[0];
  const currentPromptFeedback = current?.promptFeedback;
  const nextPromptFeedback = next.promptFeedback;
  const candidate = currentCandidate || nextCandidate
    ? {
        content:
          nextCandidate?.content?.parts?.length
            ? nextCandidate.content
            : currentCandidate?.content,
        finishReason: nextCandidate?.finishReason ?? currentCandidate?.finishReason,
        safetyRatings:
          nextCandidate?.safetyRatings?.length
            ? nextCandidate.safetyRatings
            : currentCandidate?.safetyRatings,
      }
    : undefined;
  const promptFeedback = currentPromptFeedback || nextPromptFeedback
    ? {
        blockReason: nextPromptFeedback?.blockReason ?? currentPromptFeedback?.blockReason,
        safetyRatings:
          nextPromptFeedback?.safetyRatings?.length
            ? nextPromptFeedback.safetyRatings
            : currentPromptFeedback?.safetyRatings,
      }
    : undefined;

  return {
    candidates: candidate ? [candidate] : undefined,
    promptFeedback,
    usageMetadata: next.usageMetadata ?? current?.usageMetadata,
  };
}

function extractVisibleText(parts: GeminiPart[] | undefined): string {
  if (!parts) return '';
  // NOTE: includeThoughts=false のはずだが、モデルによっては thought:true の
  // パートが混ざる。可視本文は thought でないパートのみに絞る。
  return parts
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? '')
    .join('');
}

function summarizePartTypes(parts: GeminiPart[] | undefined): string {
  if (!parts || parts.length === 0) return 'none';
  const counts: Record<string, number> = {};
  for (const part of parts) {
    const kind = part.thought
      ? 'thought'
      : typeof part.text === 'string'
      ? 'text'
      : part.functionCall
      ? 'functionCall'
      : part.inlineData
      ? 'inlineData'
      : 'unknown';
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
}

function summarizeSafetyRatings(
  ratings?: Array<{ category?: string; probability?: string; blocked?: boolean }>
): string {
  if (!ratings || ratings.length === 0) return '';
  const flagged = ratings.filter(
    (r) => r.blocked || (r.probability && !/^NEGLIGIBLE|LOW$/i.test(r.probability))
  );
  if (flagged.length === 0) return '';
  return flagged
    .map((r) => `${(r.category ?? '?').replace(/^HARM_CATEGORY_/, '')}=${r.probability ?? '?'}${r.blocked ? '(blocked)' : ''}`)
    .join(',');
}

function buildEmptyResponseDebugInfo(
  data: GeminiGenerateContentResponse | null,
  finishReason: FinishReason
): string {
  const candidateCount = data?.candidates?.length ?? 0;
  const candidate = data?.candidates?.[0];
  const bits: string[] = [
    `finishReason=${finishReason}`,
    `candidates=${candidateCount}`,
    `parts=${summarizePartTypes(candidate?.content?.parts)}`,
  ];
  if (data?.promptFeedback?.blockReason) {
    bits.push(`promptBlockReason=${data.promptFeedback.blockReason}`);
  }
  const promptSafety = summarizeSafetyRatings(data?.promptFeedback?.safetyRatings);
  if (promptSafety) bits.push(`promptSafety=${promptSafety}`);
  const candSafety = summarizeSafetyRatings(candidate?.safetyRatings);
  if (candSafety) bits.push(`candidateSafety=${candSafety}`);
  if (data?.usageMetadata) {
    const u = data.usageMetadata;
    bits.push(
      `usage=prompt:${u.promptTokenCount ?? 0}/completion:${u.candidatesTokenCount ?? 0}/thoughts:${u.thoughtsTokenCount ?? 0}/total:${u.totalTokenCount ?? 0}`
    );
  }
  return bits.join(' ');
}

function mapHttpStatus(
  status: number,
  body: { error?: { code?: number; status?: string; message?: string } }
): string {
  const statusCode = body.error?.code ?? status;
  const reason = body.error?.status;

  if (status === 401 || status === 403) return 'invalid_api_key';
  if (status === 429) return 'rate_limit';
  if (status === 500) return 'server_error';
  if (status === 503) return 'service_unavailable';
  if (reason === 'UNAUTHENTICATED' || reason === 'PERMISSION_DENIED') return 'invalid_api_key';
  if (reason === 'INVALID_ARGUMENT' || status === 400 || statusCode === 400) {
    return 'invalid_request_error';
  }
  if (reason === 'RESOURCE_EXHAUSTED') return 'rate_limit';
  if (statusCode === 401 || statusCode === 403) return 'invalid_api_key';
  if (statusCode === 429) return 'rate_limit';
  return body.error?.message?.toLowerCase().includes('api key')
    ? 'invalid_api_key'
    : 'api_error';
}

function mapFinishReason(reason?: string): FinishReason {
  if (!reason) return 'stop';
  const r = reason.toUpperCase();
  if (r === 'STOP') return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  // NOTE: Gemini の「解除できない固定安全フィルタ」に当たる finishReason は
  // SAFETY / RECITATION 以外にも PROHIBITED_CONTENT / BLOCKLIST / SPII /
  // IMAGE_SAFETY があり、いずれも再試行しても同じ結果になる。error 扱いだと
  // 再試行ボタンが出て混乱するので、まとめて content_filter に寄せる。
  if (
    r === 'SAFETY' ||
    r === 'RECITATION' ||
    r === 'PROHIBITED_CONTENT' ||
    r === 'BLOCKLIST' ||
    r === 'SPII' ||
    r === 'IMAGE_SAFETY'
  ) {
    return 'content_filter';
  }
  return 'error';
}
