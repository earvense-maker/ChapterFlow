import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeAcceptedGenerationStyle,
  queueAcceptedGenerationStyleAnalysis,
  renderStyleLensPrompt,
  selectGenerationStyleProfile,
  waitForStyleAnalysis,
} from '../../src/server/services/styleVariationService';
import * as storage from '../../src/server/services/storageService';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import { normalizeStyleVariationSettings } from '../../src/shared/defaults';
import type {
  GenerationRecord,
  GenerationStyleProfile,
  Project,
  StyleVariationSettings,
} from '../../src/shared/types';

const settings: StyleVariationSettings = {
  enabled: true,
  intensity: 'balanced',
  axisWeights: {
    visual: 0.5,
    auditory: 0.5,
    somatic: 0.5,
    introspective: 0.5,
    kinetic: 0.5,
    dialogic: 0.5,
    temporal: 0.5,
  },
  surfaceDecayEnabled: true,
  patternDecayEnabled: true,
  motifExclusions: [],
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1,
    projectId: 'proj-style-variation',
    title: '文体変調',
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    activeModelProvider: 'gemini',
    activeModelName: 'gemini-test',
    outputLength: 3000,
    streamingEnabled: false,
    activePresetIds: { narration: 'third-close' },
    styleVariation: settings,
    ...overrides,
  };
}

function generation(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    generationId: 'gen-style',
    sceneId: 'scene-style',
    episodeId: 'ep-style',
    request: { wish: '続き', outputLength: 3000, previousContextText: '' },
    responseText: '窓の外で雨が鳴った。彼女は足を止め、暗い廊下を振り返った。',
    usedPresets: { narration: 'third-close' },
    usedModel: { provider: 'gemini', modelName: 'gemini-test' },
    referencedMemoryIds: [],
    status: 'accepted',
    createdAt: '2026-07-23T00:00:00.000Z',
    parentGenerationId: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeStyleVariationSettings', () => {
  it('clamps weights, restores an all-zero map, and removes duplicate motifs', () => {
    const normalized = normalizeStyleVariationSettings({
      enabled: true,
      intensity: 'unknown',
      axisWeights: {
        visual: 2,
        auditory: -1,
        somatic: 0,
        introspective: 0,
        kinetic: 0,
        dialogic: 0,
        temporal: 0,
      },
      motifExclusions: [' 月 ', '月', '', 12],
    })!;

    expect(normalized.enabled).toBe(false);
    expect(normalized.intensity).toBe('subtle');
    expect(normalized.axisWeights.visual).toBe(1);
    expect(normalized.axisWeights.auditory).toBe(0);
    expect(normalized.motifExclusions).toEqual(['月']);
  });

  it('normalizes a truly all-zero map to equal defaults', () => {
    const normalized = normalizeStyleVariationSettings({
      enabled: true,
      intensity: 'balanced',
      axisWeights: Object.fromEntries(
        ['visual', 'auditory', 'somatic', 'introspective', 'kinetic', 'dialogic', 'temporal'].map(
          (axis) => [axis, 0]
        )
      ),
    })!;

    expect(Object.values(normalized.axisWeights)).toEqual(Array(7).fill(0.5));
  });

  it('does not share the default motif array when normalizing a broken value', () => {
    const first = normalizeStyleVariationSettings(null)!;
    first.motifExclusions.push('mutation');

    expect(normalizeStyleVariationSettings(null)?.motifExclusions).toEqual([]);
  });
});

describe('style profile selection', () => {
  it('does nothing while the feature is disabled', async () => {
    await expect(
      selectGenerationStyleProfile({
        project: project({ styleVariation: { ...settings, enabled: false } }),
        mode: 'continue',
        wish: '',
      })
    ).resolves.toBeUndefined();
  });

  it('reuses the complete saved profile for regenerate', async () => {
    const saved: GenerationStyleProfile = {
      schemaVersion: 1,
      seed: 'saved-seed',
      primaryAxis: 'auditory',
      secondaryAxis: 'temporal',
      entryChannel: 'sound',
      attenuatedPatterns: ['沈黙で閉じる'],
      intensity: 'balanced',
    };
    vi.spyOn(storage, 'findGenerationRecord').mockResolvedValue(
      generation({ status: 'draft', styleProfile: saved })
    );

    await expect(
      selectGenerationStyleProfile({
        project: project(),
        mode: 'regenerate',
        targetGenerationId: 'gen-style',
        wish: '書き直す',
      })
    ).resolves.toEqual(saved);
  });

  it('applies cooldown and excludes intentional motifs from attenuation', async () => {
    vi.spyOn(storage, 'readGenerationStyleTraceStore').mockResolvedValue({
      schemaVersion: 1,
      traces: Array.from({ length: 3 }, (_, index) => ({
        generationId: `gen-${index}`,
        openingChannel: '視線',
        dominantAxes: ['visual'],
        endingPattern: '沈黙',
        metaphorCores: ['月'],
        reactionPatterns: [],
        createdAt: `2026-07-2${index}T00:00:00.000Z`,
      })),
      analyses: [],
    });

    const selected = await selectGenerationStyleProfile({
      project: project({
        styleVariation: { ...settings, motifExclusions: ['視線', '月'] },
      }),
      mode: 'continue',
      wish: '',
    });

    expect(selected?.primaryAxis).not.toBe('visual');
    expect(selected?.attenuatedPatterns).toEqual(['沈黙で閉じる']);
  });

  it('avoids a recently saturated opening channel within the selected axis', async () => {
    vi.spyOn(storage, 'readGenerationStyleTraceStore').mockResolvedValue({
      schemaVersion: 1,
      traces: Array.from({ length: 3 }, (_, index) => ({
        generationId: `gen-sound-${index}`,
        openingChannel: '環境音から始める',
        dominantAxes: [],
        metaphorCores: [],
        reactionPatterns: [],
        createdAt: `2026-07-2${index}T00:00:00.000Z`,
      })),
      analyses: [],
    });
    const selected = await selectGenerationStyleProfile({
      project: project({
        styleVariation: {
          ...settings,
          intensity: 'subtle',
          axisWeights: {
            visual: 0,
            auditory: 1,
            somatic: 0,
            introspective: 0,
            kinetic: 0,
            dialogic: 0,
            temporal: 0,
          },
        },
      }),
      mode: 'continue',
      wish: '',
    });

    expect(selected).toMatchObject({
      primaryAxis: 'auditory',
      entryChannel: 'distance',
    });
  });

  it('renders no more than five short soft rules', () => {
    const rendered = renderStyleLensPrompt({
      schemaVersion: 1,
      seed: 'seed',
      primaryAxis: 'auditory',
      secondaryAxis: 'temporal',
      entryChannel: 'sound',
      attenuatedPatterns: ['視線から始める', '沈黙で閉じる'],
      intensity: 'balanced',
    });

    expect(rendered).toContain('【今回の文体レンズ】');
    expect(rendered).toContain('文体見本・人称・視点・人物の口調は維持');
    expect(rendered.length).toBeLessThanOrEqual(900);
    expect(rendered.split('\n').slice(1)).toHaveLength(5);
  });
});

describe('accepted style trace analysis', () => {
  it('skips drafts and records model usage plus quality for accepted text', async () => {
    const adapterSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        openingChannel: '環境音',
        dominantAxes: ['auditory', 'kinetic'],
        endingPattern: '動作で閉じる',
        metaphorCores: ['雨'],
        reactionPatterns: ['足を止める'],
        rhythmSummary: '短文と中程度の文を交互に置く',
      }),
      finishReason: 'stop',
      retryable: false,
      rawUsage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
    });
    vi.spyOn(storage, 'readGenerationStyleTraceStore').mockResolvedValue(null);
    const writeSpy = vi.spyOn(storage, 'writeGenerationStyleTraceStore').mockResolvedValue();

    await expect(
      analyzeAcceptedGenerationStyle(project(), generation({ status: 'draft' }))
    ).resolves.toBeNull();
    expect(adapterSpy).not.toHaveBeenCalled();

    const trace = await analyzeAcceptedGenerationStyle(project(), generation());
    expect(trace).toMatchObject({
      generationId: 'gen-style',
      openingChannel: '環境音',
      dominantAxes: ['auditory', 'kinetic'],
    });
    expect(writeSpy).toHaveBeenCalledWith(
      'proj-style-variation',
      expect.objectContaining({
        traces: [expect.objectContaining({ generationId: 'gen-style' })],
        analyses: [
          expect.objectContaining({
            status: 'completed',
            usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
            qualityScore: 1,
          }),
        ],
      })
    );
  });

  it('records low-quality JSON as a failed analysis and does not retry it automatically', async () => {
    const adapterSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '{}',
      finishReason: 'stop',
      retryable: false,
      rawUsage: { promptTokens: 80, completionTokens: 2, totalTokens: 82 },
    });
    let stored: Awaited<ReturnType<typeof storage.readGenerationStyleTraceStore>> = null;
    vi.spyOn(storage, 'readGenerationStyleTraceStore').mockImplementation(async () => stored);
    vi.spyOn(storage, 'writeGenerationStyleTraceStore').mockImplementation(async (_id, value) => {
      stored = value;
    });

    await expect(analyzeAcceptedGenerationStyle(project(), generation())).resolves.toBeNull();
    expect(stored).toMatchObject({
      traces: [],
      analyses: [
        expect.objectContaining({
          generationId: 'gen-style',
          status: 'failed',
          usage: { promptTokens: 80, completionTokens: 2, totalTokens: 82 },
        }),
      ],
    });

    await expect(analyzeAcceptedGenerationStyle(project(), generation())).resolves.toBeNull();
    expect(adapterSpy).toHaveBeenCalledTimes(1);
  });

  it('contains a corrupt trace-store read inside the background queue', async () => {
    const adapterSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText');
    vi.spyOn(storage, 'readGenerationStyleTraceStore').mockRejectedValue(
      new SyntaxError('broken style-traces.json')
    );

    queueAcceptedGenerationStyleAnalysis(project(), generation());
    await expect(waitForStyleAnalysis('proj-style-variation')).resolves.toBeUndefined();

    expect(adapterSpy).not.toHaveBeenCalled();
  });
});
