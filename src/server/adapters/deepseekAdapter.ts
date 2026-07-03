import { OpenAIAdapter } from './openaiAdapter.js';

const PROVIDER_NAME = 'deepseek';
const API_BASE = 'https://api.deepseek.com';
const MAX_COMPLETION_TOKENS = 384_000;

export class DeepSeekAdapter extends OpenAIAdapter {
  constructor() {
    super({
      providerName: PROVIDER_NAME,
      apiBase: API_BASE,
      maxCompletionTokens: MAX_COMPLETION_TOKENS,
      includeStreamOptions: false,
    });
  }
}
