import { OpenAIAdapter } from './openaiAdapter.js';
import { GeminiAdapter } from './geminiAdapter.js';
import { DeepSeekAdapter } from './deepseekAdapter.js';
import { XAIAdapter } from './xaiAdapter.js';
import { OpenRouterAdapter } from './openrouterAdapter.js';
import { MimoAdapter } from './mimoAdapter.js';
import type { ModelAdapter } from './modelAdapter.js';
import { dumpAdapterPrompt } from '../utils/devPromptDump.js';

// NOTE: 開発版限定のプロンプトダンプをここで挟む。adapter を直接呼ぶ箇所は
// generationService / roleplay / refine / setup / 生成後メンテなど10箇所以上あり、
// 個別に仕込むと必ず取りこぼす。全経路がこのマップを通るので入口は1つで足りる。
// 有効判定はラッパ内で毎回行う（devDiagnostics と同じく process.env を都度読む）。
// モジュール初期化時に固定すると、テストが env を切り替えても効かなくなる。
export function withPromptDump(adapter: ModelAdapter): ModelAdapter {
  const wrapped: ModelAdapter = {
    providerName: adapter.providerName,
    generateText: (request) => {
      dumpAdapterPrompt(adapter.providerName, request);
      return adapter.generateText(request);
    },
    validateConnection: (config) => adapter.validateConnection(config),
  };
  // NOTE: generateTextStream は任意実装で、呼び出し側は `if (!adapter.generateTextStream)`
  // で非ストリーミングへ落ちる。元アダプタが持たないのにラッパが生やすと、その分岐が
  // すり抜けて未実装メソッドを呼ぶ。持つときだけ生やすこと。
  if (adapter.generateTextStream) {
    wrapped.generateTextStream = (request) => {
      dumpAdapterPrompt(adapter.providerName, request);
      return adapter.generateTextStream!(request);
    };
  }
  return wrapped;
}

// NOTE: ModelAdapter は状態を持たないため、プロセス単一のインスタンスを全サービスで
// 使い回す。プロバイダー追加時はここに登録すれば全機能（生成 / refine / setup /
// 接続確認）へ一括で反映される。個別サービスにマップを複製しないこと。
export const adapterMap: Record<string, ModelAdapter> = {
  openai: withPromptDump(new OpenAIAdapter()),
  gemini: withPromptDump(new GeminiAdapter()),
  deepseek: withPromptDump(new DeepSeekAdapter()),
  xai: withPromptDump(new XAIAdapter()),
  openrouter: withPromptDump(new OpenRouterAdapter()),
  mimo: withPromptDump(new MimoAdapter()),
};

export const adapterList: ModelAdapter[] = Object.values(adapterMap);
