import { Router } from 'express';
import { OpenAIAdapter } from '../adapters/openaiAdapter.js';
import * as credentialService from '../services/credentialService.js';
import type { ModelConfig } from '../types/index.js';

const router = Router();

const adapters = [new OpenAIAdapter()];

router.get('/models/providers', (_req, res) => {
  res.json(
    adapters.map((a) => ({
      name: a.providerName,
      defaultModel: a.providerName === 'openai' ? 'gpt-4o-mini' : '',
    }))
  );
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
