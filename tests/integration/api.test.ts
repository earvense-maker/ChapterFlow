import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';

// TODO: 統合テスト用のヘルパーとOpenAI Adapterのモック化

describe('projects API', () => {
  it.todo('creates a project and returns it');
  it.todo('lists created projects');
});

describe('generation API', () => {
  it.todo('generates a scene with mocked adapter');
  it.todo('accepts a generated draft');
});
