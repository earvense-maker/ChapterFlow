export interface ModelConfig {
  provider: string;
  modelName: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs: number;
  defaultTemperature: number;
}

export interface ModelProviderInfo {
  name: string;
  label: string;
  defaultModel: string;
  apiKeyPlaceholder: string;
  apiKeyHelp: string;
  hasApiKey?: boolean;
}

export interface AppModelSettings {
  provider: string;
  modelName: string;
}

export interface AdapterGenerateRequest {
  systemInstructions: string;
  userPrompt: string;
  outputLength: number;
  temperature: number;
  timeoutMs: number;
  modelName: string;
  abortSignal?: AbortSignal;
  frequencyPenalty?: number;
  presencePenalty?: number;
  // NOTE: 明示的な最大出力トークン数。指定すると各アダプタは outputLength から
  // estimateMaxOutputTokens で導出する既定挙動をスキップし、この値（プロバイダー
  // ハードキャップで clamp）を使う。JSON 抽出のように「outputLength ベースの
  // 推定（+ Gemini thinking 分の 2048）だとキャップに張り付いて再試行の headroom
  // が消える」用途で使う。単位はトークン。指定しなければ従来通り。
  maxOutputTokens?: number;
  // NOTE: 'application/json' を指定するとプロバイダー側で構造化 JSON 出力を
  // 有効化する（Gemini: responseMimeType、OpenAI/DeepSeek: response_format）。
  // これで前置き文やコードフェンスが混ざる事故を減らせる。JSON.parse で直接
  // 読める応答になる想定だが、モデルが flag を無視することもあるため
  // 呼び出し側は fenced fallback パーサも用意しておく。
  responseMimeType?: 'application/json';
}

export type FinishReason = 'stop' | 'length' | 'timeout' | 'error' | 'content_filter';

export interface AdapterGenerateResult {
  text: string;
  finishReason: FinishReason;
  rawUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
  // OpenRouterのようなルーターが実際に選択したモデル。通常の直結APIでは未指定。
  resolvedModelName?: string;
  // NOTE: 空応答時の切り分け用に、adapter 側で拾えた診断情報（候補数・パート種別・
  // blockReason・safetyRatings 要約など）を短い文字列で残す。ユーザーには
  // エラー詳細としてそのまま見せる。
  debugInfo?: string;
}

export interface ConnectionStatus {
  ok: boolean;
  message?: string;
  errorCode?: string;
}

export type AdapterGenerateStreamEvent =
  | { type: 'chunk'; text: string }
  | {
      type: 'done';
      finishReason: FinishReason;
      rawUsage?: AdapterGenerateResult['rawUsage'];
      debugInfo?: string;
      resolvedModelName?: string;
    };
