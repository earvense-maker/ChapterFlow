import { OpenAIAdapter } from './openaiAdapter.js';
import { GeminiAdapter } from './geminiAdapter.js';
import { DeepSeekAdapter } from './deepseekAdapter.js';
import { XAIAdapter } from './xaiAdapter.js';
import { OpenRouterAdapter } from './openrouterAdapter.js';
import type { ModelAdapter } from './modelAdapter.js';

// NOTE: ModelAdapter は状態を持たないため、プロセス単一のインスタンスを全サービスで
// 使い回す。プロバイダー追加時はここに登録すれば全機能（生成 / refine / setup /
// 接続確認）へ一括で反映される。個別サービスにマップを複製しないこと。
export const adapterMap: Record<string, ModelAdapter> = {
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
  deepseek: new DeepSeekAdapter(),
  xai: new XAIAdapter(),
  openrouter: new OpenRouterAdapter(),
};

export const adapterList: ModelAdapter[] = Object.values(adapterMap);
