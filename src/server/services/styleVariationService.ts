import { createHash, randomBytes } from 'node:crypto';
import {
  STYLE_AXES,
  normalizeGenerationStyleProfile,
  normalizeStyleVariationSettings,
} from '../../shared/defaults.js';
import { STYLE_PROFILE_SCHEMA_VERSION } from '../../shared/types.js';
import type {
  GenerationRecord,
  GenerationStyleProfile,
  GenerationStyleTrace,
  GenerationStyleTraceStore,
  Project,
  StyleAxis,
  StyleTraceAnalysisRecord,
  StyleVariationSettings,
} from '../types/index.js';
import { nowIso } from '../utils/date.js';
import { runNonStreaming } from './modelGenerationService.js';
import * as storage from './storageService.js';

const TRACE_HISTORY_LIMIT = 5;
const TRACE_STORE_LIMIT = 50;
const ANALYSIS_TIMEOUT_MS = 30_000;
const LENS_PROMPT_MAX_CHARS = 900;

const AXIS_LABELS: Record<StyleAxis, string> = {
  visual: '視覚',
  auditory: '聴覚',
  somatic: '身体感覚',
  introspective: '内省',
  kinetic: '運動',
  dialogic: '対話',
  temporal: '時間感覚',
};

const AXIS_SCENE_CUES: Record<StyleAxis, RegExp> = {
  visual: /光|色|影|景色|見る|見える|視線|輪郭|遠く|近く|visual|light|color/i,
  auditory: /音|声|響|鳴|聞|沈黙|静けさ|auditory|sound|voice|silence/i,
  somatic: /温度|熱|冷|重|痛|触|肌|圧|身体|somatic|touch|pressure/i,
  introspective: /記憶|思う|迷|逡巡|内心|気持ち|introspective|memory|thought/i,
  kinetic: /走|動|戦|追|速度|勢い|運動|kinetic|action|move/i,
  dialogic: /会話|話|言う|問い|答え|対話|dialog|conversation/i,
  temporal: /時間|一瞬|しばらく|過去|未来|経過|temporal|time/i,
};

type StyleEntryChannel = NonNullable<GenerationStyleProfile['entryChannel']>;

const ENTRY_CHANNELS: Record<StyleAxis, StyleEntryChannel[]> = {
  visual: ['visual', 'distance'],
  auditory: ['sound', 'distance'],
  somatic: ['pressure', 'temperature'],
  introspective: ['distance', 'temperature'],
  kinetic: ['pressure', 'distance'],
  dialogic: ['sound', 'distance'],
  temporal: ['distance', 'temperature'],
};

export interface SelectStyleProfileInput {
  project: Project;
  mode: 'continue' | 'regenerate' | 'variate';
  targetGenerationId?: string | null;
  wish: string;
}

export async function selectGenerationStyleProfile(
  input: SelectStyleProfileInput
): Promise<GenerationStyleProfile | undefined> {
  const settings = normalizeStyleVariationSettings(input.project.styleVariation);
  if (!settings?.enabled) return undefined;

  if (input.mode === 'regenerate' && input.targetGenerationId) {
    const target = await storage.findGenerationRecord(
      input.project.projectId,
      input.targetGenerationId
    );
    const saved = normalizeGenerationStyleProfile(target?.styleProfile);
    if (saved) return saved;

    const fallbackSeed = createHash('sha256')
      .update(
        `${input.project.projectId}:${input.targetGenerationId}:${STYLE_PROFILE_SCHEMA_VERSION}`
      )
      .digest('hex')
      .slice(0, 32);
    const selected = await selectNewProfile(input.project, settings, input.wish, fallbackSeed);
    if (target) {
      await storage.appendGenerationStyleProfileLog(
        input.project.projectId,
        target.generationId,
        selected
      );
    }
    return selected;
  }

  return selectNewProfile(
    input.project,
    settings,
    input.wish,
    randomBytes(16).toString('hex')
  );
}

async function selectNewProfile(
  project: Project,
  settings: StyleVariationSettings,
  wish: string,
  seed: string
): Promise<GenerationStyleProfile> {
  const traces = settings.patternDecayEnabled
    ? await readRecentStyleTraces(project.projectId, TRACE_HISTORY_LIMIT)
    : [];
  const recentAxisCounts = new Map<StyleAxis, number>();
  traces.forEach((trace, index) => {
    const recency = (TRACE_HISTORY_LIMIT - index) / TRACE_HISTORY_LIMIT;
    for (const axis of trace.dominantAxes) {
      recentAxisCounts.set(axis, (recentAxisCounts.get(axis) ?? 0) + recency);
    }
  });

  const ranked = STYLE_AXES.map((axis) => {
    const weight = settings.axisWeights[axis] ?? 0.5;
    const sceneFit = AXIS_SCENE_CUES[axis].test(wish) ? 1.2 : 0;
    const cooldown = (recentAxisCounts.get(axis) ?? 0) * 1.1;
    const jitter = seededFraction(seed, axis) * 0.8;
    return { axis, score: weight * 4 + sceneFit + jitter - cooldown };
  }).sort((a, b) => b.score - a.score || a.axis.localeCompare(b.axis));

  const primaryAxis = ranked[0]?.axis ?? 'visual';
  const secondaryAxis =
    settings.intensity === 'balanced' && ranked[1] && ranked[1].axis !== primaryAxis
      ? ranked[1].axis
      : undefined;
  const entryChannel = selectEntryChannel(seed, primaryAxis, traces);

  return {
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    seed,
    primaryAxis,
    ...(secondaryAxis ? { secondaryAxis } : {}),
    entryChannel,
    attenuatedPatterns: settings.patternDecayEnabled
      ? summarizeSaturatedPatterns(traces, settings.motifExclusions)
      : [],
    intensity: settings.intensity,
  };
}

export function renderStyleLensPrompt(profile: GenerationStyleProfile | undefined): string {
  const normalized = normalizeGenerationStyleProfile(profile);
  if (!normalized) return '';

  const axes = normalized.secondaryAxis
    ? `${AXIS_LABELS[normalized.primaryAxis]}を主軸、${AXIS_LABELS[normalized.secondaryAxis]}を副軸`
    : `${AXIS_LABELS[normalized.primaryAxis]}を弱い主軸`;
  const rules = [
    `文体見本・人称・視点・人物の口調は維持し、今回は${axes}とする。`,
    '場面内にすでに存在する情報から自然に使える場合だけ前景化する。',
    normalized.attenuatedPatterns.length > 0
      ? `直近で続いた${normalized.attenuatedPatterns.map((item) => `「${item}」`).join('、')}は、同等以上の別案がある場合だけ弱く避ける。`
      : '',
    '感情を即座に評価語で確定せず、行動・接点・知覚の差分で伝えられる候補を弱く優先する。',
    '人物の目的、伏線、クライマックス、意図的な反復、今回の明示指示と競合する場合は、このレンズを優先しない。',
  ].filter(Boolean);

  return `【今回の文体レンズ】\n${rules.slice(0, 5).join('\n')}`.slice(
    0,
    LENS_PROMPT_MAX_CHARS
  );
}

export function queueAcceptedGenerationStyleAnalysis(
  project: Project,
  generation: GenerationRecord
): void {
  const settings = normalizeStyleVariationSettings(project.styleVariation);
  if (!settings?.enabled || !settings.patternDecayEnabled || generation.status !== 'accepted') return;

  const previous = analysisQueues.get(project.projectId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => analyzeAcceptedGenerationStyle(project, generation))
    .then(() => undefined)
    .catch((error) => {
      // analyzeAcceptedGenerationStyle 自体の防御を越えた例外でも、バックグラウンド
      // promiseを拒否状態のまま放置しない。
      console.warn('Unhandled style analysis queue failure; generation remains available', {
        projectId: project.projectId,
        generationId: generation.generationId,
        error,
      });
    });
  analysisQueues.set(project.projectId, next);
  void next.finally(() => {
    if (analysisQueues.get(project.projectId) === next) {
      analysisQueues.delete(project.projectId);
    }
  });
}

export async function waitForStyleAnalysis(projectId: string): Promise<void> {
  await analysisQueues.get(projectId);
}

export async function analyzeAcceptedGenerationStyle(
  project: Project,
  generation: GenerationRecord
): Promise<GenerationStyleTrace | null> {
  const settings = normalizeStyleVariationSettings(project.styleVariation);
  if (!settings?.enabled || !settings.patternDecayEnabled || generation.status !== 'accepted') {
    return null;
  }

  const startedAt = nowIso();
  const startedMs = Date.now();
  let observedUsage: StyleTraceAnalysisRecord['usage'];
  let observedModelName = project.activeModelName;
  try {
    const existingStore = normalizeTraceStore(
      await storage.readGenerationStyleTraceStore(project.projectId)
    );
    const existing = existingStore.traces.find(
      (trace) => trace.generationId === generation.generationId
    );
    if (existing) return existing;
    // NOTE: 同じaccepted generationの失敗をre-acceptや画面再操作で自動再試行しない。
    // 追加コストを発生させる再解析は、将来の明示retry導線に限定する。
    if (
      existingStore.analyses.some(
        (analysis) => analysis.generationId === generation.generationId
      )
    ) {
      return null;
    }

    const result = await runNonStreaming(project.activeModelProvider, {
      systemInstructions:
        'あなたは日本語小説の文体パターンを監査する分析器です。本文の内容評価や改善提案をせず、指定JSONだけを返してください。',
      userPrompt: buildTraceAnalysisPrompt(generation.responseText, settings.motifExclusions),
      outputLength: 1800,
      temperature: 0.1,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
      modelName: project.activeModelName,
      maxOutputTokens: 700,
      responseMimeType: 'application/json',
    });
    observedUsage = result.rawUsage;
    observedModelName = result.resolvedModelName ?? project.activeModelName;
    if (result.finishReason !== 'stop' && result.finishReason !== 'length') {
      throw new Error(result.errorMessage || `文体解析が完了しませんでした (${result.finishReason})`);
    }
    const trace = parseStyleTrace(result.text, generation.generationId, settings.motifExclusions);
    const qualityScore = calculateTraceQuality(trace);
    if (qualityScore < 0.5) {
      throw new Error('文体解析の有効項目が不足しているため、traceを保存しませんでした。');
    }
    const completedAt = nowIso();
    const analysis: StyleTraceAnalysisRecord = {
      generationId: generation.generationId,
      status: 'completed',
      usedModel: {
        provider: project.activeModelProvider,
        modelName: observedModelName,
      },
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.now() - startedMs),
      ...(result.rawUsage ? { usage: result.rawUsage } : {}),
      qualityScore,
    };
    await persistTraceAnalysis(project.projectId, trace, analysis);
    return trace;
  } catch (error) {
    const analysis: StyleTraceAnalysisRecord = {
      generationId: generation.generationId,
      status: 'failed',
      usedModel: {
        provider: project.activeModelProvider,
        modelName: observedModelName,
      },
      startedAt,
      completedAt: nowIso(),
      durationMs: Math.max(0, Date.now() - startedMs),
      ...(observedUsage ? { usage: observedUsage } : {}),
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    };
    await persistTraceAnalysis(project.projectId, null, analysis).catch((persistError) => {
      console.warn('Failed to persist style trace analysis failure', {
        projectId: project.projectId,
        generationId: generation.generationId,
        error: persistError,
      });
    });
    console.warn('Style trace analysis failed; generation remains available', {
      projectId: project.projectId,
      generationId: generation.generationId,
      error,
    });
    return null;
  }
}

const analysisQueues = new Map<string, Promise<void>>();

async function persistTraceAnalysis(
  projectId: string,
  trace: GenerationStyleTrace | null,
  analysis: StyleTraceAnalysisRecord
): Promise<void> {
  const store = normalizeTraceStore(await storage.readGenerationStyleTraceStore(projectId));
  const traces = trace
    ? [trace, ...store.traces.filter((item) => item.generationId !== trace.generationId)].slice(
        0,
        TRACE_STORE_LIMIT
      )
    : store.traces;
  const analyses = [
    analysis,
    ...store.analyses.filter((item) => item.generationId !== analysis.generationId),
  ].slice(0, TRACE_STORE_LIMIT);
  await storage.writeGenerationStyleTraceStore(projectId, {
    schemaVersion: 1,
    traces,
    analyses,
  });
}

async function readRecentStyleTraces(
  projectId: string,
  limit: number
): Promise<GenerationStyleTrace[]> {
  const store = normalizeTraceStore(await storage.readGenerationStyleTraceStore(projectId));
  return store.traces.slice(0, limit);
}

function normalizeTraceStore(value: GenerationStyleTraceStore | null): GenerationStyleTraceStore {
  if (!value || value.schemaVersion !== 1) {
    return { schemaVersion: 1, traces: [], analyses: [] };
  }
  return {
    schemaVersion: 1,
    traces: Array.isArray(value.traces)
      ? value.traces
          .map(normalizeStoredTrace)
          .filter((trace): trace is GenerationStyleTrace => trace !== null)
      : [],
    analyses: Array.isArray(value.analyses)
      ? value.analyses.filter(
          (analysis): analysis is StyleTraceAnalysisRecord =>
            typeof analysis === 'object' &&
            analysis !== null &&
            typeof analysis.generationId === 'string' &&
            (analysis.status === 'completed' || analysis.status === 'failed')
        )
      : [],
  };
}

function normalizeStoredTrace(value: unknown): GenerationStyleTrace | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Partial<GenerationStyleTrace>;
  if (typeof raw.generationId !== 'string' || typeof raw.createdAt !== 'string') return null;
  return {
    generationId: raw.generationId,
    ...(shortText(raw.openingChannel, 60)
      ? { openingChannel: shortText(raw.openingChannel, 60) }
      : {}),
    dominantAxes: uniqueStrings(raw.dominantAxes)
      .filter((item): item is StyleAxis => STYLE_AXES.includes(item as StyleAxis))
      .slice(0, 2),
    ...(shortText(raw.endingPattern, 60)
      ? { endingPattern: shortText(raw.endingPattern, 60) }
      : {}),
    metaphorCores: sanitizePatternArray(raw.metaphorCores, []),
    reactionPatterns: sanitizePatternArray(raw.reactionPatterns, []),
    ...(shortText(raw.rhythmSummary, 100)
      ? { rhythmSummary: shortText(raw.rhythmSummary, 100) }
      : {}),
    createdAt: raw.createdAt,
  };
}

function summarizeSaturatedPatterns(
  traces: GenerationStyleTrace[],
  exclusions: string[]
): string[] {
  const candidates: string[] = [];
  for (const trace of traces) {
    if (trace.openingChannel) candidates.push(`${trace.openingChannel}から始める`);
    if (trace.endingPattern) candidates.push(`${trace.endingPattern}で閉じる`);
    candidates.push(...trace.metaphorCores.map((item) => `比喩核「${item}」`));
    candidates.push(...trace.reactionPatterns.map((item) => `反応型「${item}」`));
  }
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (isExcluded(candidate, exclusions)) continue;
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .filter(([, count]) => count >= 2)
    .slice(0, 3)
    .map(([pattern]) => pattern);
}

function selectEntryChannel(
  seed: string,
  primaryAxis: StyleAxis,
  traces: GenerationStyleTrace[]
): StyleEntryChannel {
  const recentCounts = new Map<StyleEntryChannel, number>();
  traces.forEach((trace, index) => {
    const channel = classifyOpeningChannel(trace.openingChannel);
    if (!channel) return;
    const recency = (TRACE_HISTORY_LIMIT - index) / TRACE_HISTORY_LIMIT;
    recentCounts.set(channel, (recentCounts.get(channel) ?? 0) + recency);
  });

  const candidates = ENTRY_CHANNELS[primaryAxis];
  return [...candidates].sort((a, b) => {
    const scoreA = seededFraction(seed, `entry:${primaryAxis}:${a}`) * 0.5 -
      (recentCounts.get(a) ?? 0) * 1.2;
    const scoreB = seededFraction(seed, `entry:${primaryAxis}:${b}`) * 0.5 -
      (recentCounts.get(b) ?? 0) * 1.2;
    return scoreB - scoreA || a.localeCompare(b);
  })[0] ?? candidates[0];
}

function classifyOpeningChannel(value: string | undefined): StyleEntryChannel | undefined {
  if (!value) return undefined;
  const normalized = value.normalize('NFKC').toLowerCase();
  if (/音|声|響|sound|voice|auditory/.test(normalized)) return 'sound';
  if (/温|熱|冷|temperature|heat|cold/.test(normalized)) return 'temperature';
  if (/圧|重|触|pressure|weight|touch/.test(normalized)) return 'pressure';
  if (/距離|遠|近|distance/.test(normalized)) return 'distance';
  if (/視|光|色|輪郭|visual|light|color/.test(normalized)) return 'visual';
  return undefined;
}

function buildTraceAnalysisPrompt(text: string, exclusions: string[]): string {
  const exclusionLine =
    exclusions.length > 0
      ? `意図的モチーフ・人物性として除外する語句: ${exclusions.join('、')}\n`
      : '';
  return `次の採用済み小説本文だけを分析し、JSONオブジェクトを返す。
${exclusionLine}{
  "openingChannel": "冒頭の感覚入口を短い日本語で。なければ空文字",
  "dominantAxes": ["visual|auditory|somatic|introspective|kinetic|dialogic|temporal から最大2件"],
  "endingPattern": "末尾の着地型を短い日本語で。なければ空文字",
  "metaphorCores": ["反復しうる比喩核。最大5件"],
  "reactionPatterns": ["人物反応の型。最大5件"],
  "rhythmSummary": "文の長短・間・速度を80字以内で"
}
除外語句はmetaphorCores/reactionPatternsへ入れない。本文の改善案や感想は書かない。

【本文】
${text.slice(0, 20_000)}`;
}

function parseStyleTrace(
  rawText: string,
  generationId: string,
  exclusions: string[]
): GenerationStyleTrace {
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = (fenced ?? rawText).trim();
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const dominantAxes = uniqueStrings(parsed.dominantAxes)
    .filter((item): item is StyleAxis => STYLE_AXES.includes(item as StyleAxis))
    .slice(0, 2);
  const metaphorCores = sanitizePatternArray(parsed.metaphorCores, exclusions);
  const reactionPatterns = sanitizePatternArray(parsed.reactionPatterns, exclusions);

  return {
    generationId,
    ...(shortText(parsed.openingChannel, 60) ? { openingChannel: shortText(parsed.openingChannel, 60) } : {}),
    dominantAxes,
    ...(shortText(parsed.endingPattern, 60) ? { endingPattern: shortText(parsed.endingPattern, 60) } : {}),
    metaphorCores,
    reactionPatterns,
    ...(shortText(parsed.rhythmSummary, 100) ? { rhythmSummary: shortText(parsed.rhythmSummary, 100) } : {}),
    createdAt: nowIso(),
  };
}

function sanitizePatternArray(value: unknown, exclusions: string[]): string[] {
  return uniqueStrings(value)
    .map((item) => item.slice(0, 80))
    .filter((item) => !isExcluded(item, exclusions))
    .slice(0, 5);
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

function shortText(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function isExcluded(value: string, exclusions: string[]): boolean {
  const normalized = value.normalize('NFKC').toLowerCase();
  return exclusions.some((item) => {
    const exclusion = item.normalize('NFKC').trim().toLowerCase();
    return exclusion.length > 0 && normalized.includes(exclusion);
  });
}

function calculateTraceQuality(trace: GenerationStyleTrace): number {
  const fields = [
    Boolean(trace.openingChannel),
    trace.dominantAxes.length > 0,
    Boolean(trace.endingPattern),
    trace.metaphorCores.length > 0,
    trace.reactionPatterns.length > 0,
    Boolean(trace.rhythmSummary),
  ];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100) / 100;
}

function seededFraction(seed: string, key: string): number {
  const digest = createHash('sha256').update(`${seed}:${key}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}
