import { Router } from 'express';
import { OpenAIAdapter } from '../adapters/openaiAdapter.js';
import { GeminiAdapter } from '../adapters/geminiAdapter.js';
import { DeepSeekAdapter } from '../adapters/deepseekAdapter.js';
import { XAIAdapter } from '../adapters/xaiAdapter.js';
import * as credentialService from '../services/credentialService.js';
import { readAppSettings, updateAppSettings } from '../services/appSettingsService.js';
import {
  defaultModelForProvider,
  isSupportedProvider,
  listModelProvidersWithKeyInfo,
} from '../services/modelInfoService.js';
import type { AppModelSettings, ModelConfig } from '../types/index.js';

const router = Router();

const adapters = [new OpenAIAdapter(), new GeminiAdapter(), new DeepSeekAdapter(), new XAIAdapter()];

router.get('/models/providers', async (_req, res, next) => {
  try {
    const providers = await listModelProvidersWithKeyInfo();
    res.json(providers);
  } catch (err) {
    next(err);
  }
});

router.get('/models/default', async (_req, res, next) => {
  try {
    res.json(await readDefaultModelSettings());
  } catch (err) {
    next(err);
  }
});

router.put('/models/default', async (req, res, next) => {
  try {
    const { provider, modelName } = req.body as Partial<AppModelSettings>;
    if (typeof provider !== 'string' || !isSupportedProvider(provider)) {
      return res.status(400).json({ error: '未対応のモデルプロバイダーです。' });
    }
    if (typeof modelName !== 'string' || !modelName.trim()) {
      return res.status(400).json({ error: 'モデル名を入力してください。' });
    }
    const normalized: AppModelSettings = {
      provider,
      modelName: modelName.trim(),
    };
    await updateAppSettings((settings) => ({
      ...settings,
      setupModel: normalized,
    }));
    res.json(normalized);
  } catch (err) {
    next(err);
  }
});

router.post('/models/validate', async (req, res, next) => {
  try {
    const config = req.body as ModelConfig;
    const adapter = adapters.find((a) => a.providerName === config.provider);
    if (!adapter) return res.status(400).json({ error: 'Unknown provider' });
    const status = await adapter.validateConnection(config);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

router.post('/models/credentials', async (req, res, next) => {
  try {
    const { provider, apiKey } = req.body as { provider: string; apiKey: string };
    if (!provider || !apiKey) {
      return res.status(400).json({ error: 'provider and apiKey are required' });
    }
    await credentialService.saveCredential(provider, apiKey);
    await credentialService.reloadCredentials();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;

async function readDefaultModelSettings(): Promise<AppModelSettings> {
  const settings = await readAppSettings();
  const savedProvider = settings.setupModel?.provider;
  const provider =
    savedProvider && isSupportedProvider(savedProvider)
      ? savedProvider
      : 'gemini';
  const modelName =
    savedProvider === provider
      ? settings.setupModel?.modelName?.trim()
      : undefined;
  return {
    provider,
    modelName: modelName || defaultModelForProvider(provider),
  };
}
