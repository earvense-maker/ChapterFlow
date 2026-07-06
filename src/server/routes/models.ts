import { Router } from 'express';
import { OpenAIAdapter } from '../adapters/openaiAdapter.js';
import { GeminiAdapter } from '../adapters/geminiAdapter.js';
import { DeepSeekAdapter } from '../adapters/deepseekAdapter.js';
import * as credentialService from '../services/credentialService.js';
import { listModelProvidersWithKeyInfo } from '../services/modelInfoService.js';
import type { ModelConfig } from '../types/index.js';

const router = Router();

const adapters = [new OpenAIAdapter(), new GeminiAdapter(), new DeepSeekAdapter()];

router.get('/models/providers', async (_req, res, next) => {
  try {
    const providers = await listModelProvidersWithKeyInfo();
    res.json(providers);
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
