import * as storage from '../services/storageService.js';
import { readStoryState } from '../services/storyStateService.js';
import { dropLeadingTextToBoundary } from '../utils/textBoundary.js';
import type {
  EpisodeRecord,
  GenerationRecord,
  ProjectId,
  SceneId,
  SceneRecord,
  StoryState,
} from '../types/index.js';

const DEFAULT_MAX_CHARS = 12000;
// NOTE: まだ要約へ畳まれていない場面は、通常枠を超えても直近本文に残す。ここで打ち切ると
// 「窓からも落ちたが要約にも入っていない」本文が生まれ、その場面はどこからも参照できなく
// なる。要約は採用のたびに即走るわけではない（まとめて畳む）ので、この延長が無いと
// 畳まれるまでの数場面が毎回抜ける。要約が失敗し続けても無制限に育たないよう上限を置く。
const UNSUMMARIZED_MAX_CHARS = 20000;

export interface RecentContextWindowOptions {
  maxChars?: number;
  includeCurrentScene?: boolean;
  // NOTE: 要約へ畳み済みの生成ID。渡すと「未要約の場面は通常枠を超えても残す」延長が
  // 効く。渡さない場合は通常枠のみで、これが「畳む対象を決めるための窓」になる。
  summarizedGenerationIds?: ReadonlySet<string>;
}

// NOTE: 直近本文に入る採用済み生成を「新しい順」で返す。本文組み立てと
// 「窓から落ちた場面はどれか」の判定が別々の再現実装になると、要約が現役の本文を
// 二重に含めたり、逆に落ちた場面を取りこぼしたりする。選択規則はここを正本にする。
async function selectRecentContextGenerations(
  projectId: ProjectId,
  currentEpisodeId: string | null,
  currentSceneId: SceneId | null,
  options: RecentContextWindowOptions = {}
): Promise<{ selected: GenerationRecord[]; charLimit: number }> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  // NOTE: variate / regenerate モードでは現在シーンの採用済み本文を除外する。
  // 含めたままだと AI が「その先」を書いてしまい、現在シーンの別案ではなく
  // 次のシーンの内容がドラフトとして保存されてしまうため。
  const includeCurrentScene = options.includeCurrentScene ?? true;

  const empty = { selected: [] as GenerationRecord[], charLimit: maxChars };
  if (!currentEpisodeId || !currentSceneId) return empty;

  const contextScenes = await selectContextScenesThroughCurrent(
    projectId,
    currentEpisodeId,
    currentSceneId,
    includeCurrentScene
  );
  const summarized = options.summarizedGenerationIds;
  const selected: GenerationRecord[] = [];
  let chars = 0;
  // NOTE: 末尾の切り詰め幅。延長が起きた回だけ広げる。ここを maxChars のままにすると、
  // 未要約の場面を選び直しても最後の slice で切り戻され、延長が無意味になる。
  let charLimit = maxChars;

  // NOTE: When the reader is moved to an earlier scene, later scenes must not leak into the prompt.
  for (const scene of [...contextScenes].reverse()) {
    if (!scene.acceptedGenerationId) continue;
    const generation = await findGeneration(projectId, scene.acceptedGenerationId);
    if (!generation) continue;
    if (chars >= maxChars) {
      // 通常枠を使い切った後は、まだ要約に入っていない場面だけ延長して残す。
      if (!summarized) break;
      // NOTE: 要約済みIDは通常は古い側へ連続するが、過去場面の採用し直しで途中に
      // 未要約IDが生まれることがある。要約済みを1件見ただけで打ち切ると、その穴が
      // 本文にも要約にも入らないため、要約済み場面だけを飛ばして走査は続ける。
      if (summarized.has(generation.generationId)) continue;
      if (chars >= UNSUMMARIZED_MAX_CHARS) break;
      charLimit = UNSUMMARIZED_MAX_CHARS;
    }
    selected.push(generation);
    chars += generation.responseText.length;
  }

  return { selected, charLimit };
}

async function selectContextScenesThroughCurrent(
  projectId: ProjectId,
  currentEpisodeId: string | null,
  currentSceneId: SceneId | null,
  includeCurrentScene: boolean
): Promise<SceneRecord[]> {
  if (!currentEpisodeId || !currentSceneId) return [];
  const episodeIds = await storage.listEpisodeIds(projectId);
  const episodes = (
    await Promise.all(episodeIds.map((episodeId) => storage.readEpisodeRecord(projectId, episodeId)))
  ).filter((episode): episode is EpisodeRecord => episode !== null);
  episodes.sort((a, b) => a.order - b.order || a.episodeId.localeCompare(b.episodeId));
  const currentEpisodeIndex = episodes.findIndex(
    (episode) => episode.episodeId === currentEpisodeId
  );
  if (currentEpisodeIndex < 0) return [];

  const currentEpisodeScenes = [...episodes[currentEpisodeIndex].scenes].sort(
    (a, b) => a.order - b.order
  );
  const currentIndex = currentEpisodeScenes.findIndex((scene) => scene.sceneId === currentSceneId);
  if (currentIndex < 0) return [];
  const upperExclusive = includeCurrentScene ? currentIndex + 1 : currentIndex;

  // NOTE: 現在話だけを見ると、次話へ移った瞬間に前話が通常窓から丸ごと消え、自動要約の
  // 閾値に届くまで本文にも要約にも存在しなくなる。現在位置より前の全話を候補にし、過去話へ
  // 戻った場合はそれより後の話を含めない。
  return [
    ...episodes
      .slice(0, currentEpisodeIndex)
      .flatMap((episode) => [...episode.scenes].sort((a, b) => a.order - b.order)),
    ...currentEpisodeScenes.slice(0, upperExclusive),
  ];
}

// NOTE: 要約候補の母集合。全作品の採用済みを走査すると、読み位置より後の場面まで
// 「窓外」と誤認して要約へ混ぜるため、現在位置までの物語prefixを正本として共有する。
export async function getContextGenerationIdsThroughCurrentScene(
  projectId: ProjectId,
  currentEpisodeId: string | null,
  currentSceneId: SceneId | null,
  options: { includeCurrentScene?: boolean } = {}
): Promise<string[]> {
  const scenes = await selectContextScenesThroughCurrent(
    projectId,
    currentEpisodeId,
    currentSceneId,
    options.includeCurrentScene ?? true
  );
  return scenes.flatMap((scene) =>
    scene.acceptedGenerationId ? [scene.acceptedGenerationId] : []
  );
}

// NOTE: 「畳む対象を決めるための窓」。要約側が畳む候補を選ぶのに使う。
// ここでは summarizedGenerationIds を意図的に渡さず、必ず通常枠だけで判定する。
// 未要約の場面は getRecentContext 側で延長表示されているが、その延長を窓に含めると
// 「表示されているから畳まない → 畳まれないから表示が続く」で永久に畳めなくなる。
// 通常枠を出た時点で畳む候補にし、畳み終わるまでの間だけ本文側で見せ続ける、が正しい。
export async function getRecentContextGenerationIds(
  projectId: ProjectId,
  currentEpisodeId: string | null,
  currentSceneId: SceneId | null,
  options: Omit<RecentContextWindowOptions, 'summarizedGenerationIds'> = {}
): Promise<Set<string>> {
  const { selected } = await selectRecentContextGenerations(
    projectId,
    currentEpisodeId,
    currentSceneId,
    options
  );
  return new Set(selected.map((generation) => generation.generationId));
}

export async function getRecentContext(
  projectId: ProjectId,
  currentEpisodeId: string | null,
  currentSceneId: SceneId | null,
  options: RecentContextWindowOptions = {}
): Promise<string> {
  const { selected, charLimit } = await selectRecentContextGenerations(
    projectId,
    currentEpisodeId,
    currentSceneId,
    options
  );
  if (selected.length === 0) return '';

  // selectRecentContextGenerations は新しい順なので、本文は古い順へ戻して連結する。
  const joined = [...selected]
    .reverse()
    .map((generation) => generation.responseText)
    .join('\n\n');
  if (joined.length <= charLimit) return joined;
  return dropLeadingTextToBoundary(joined.slice(-charLimit));
}

// NOTE: variate / regenerate モード向け。現在シーンの「書き直し対象本文」を返す。
// 採用済み本文があればそれを、なければ選択中のドラフトを、それも無ければ空文字。
export async function getCurrentSceneReferenceText(
  projectId: ProjectId,
  currentEpisodeId: string | null,
  currentSceneId: SceneId | null,
  selectedDraftGenerationId: string | null
): Promise<string> {
  const targetGenId = await getCurrentSceneReferenceGenerationId(
    projectId,
    currentEpisodeId,
    currentSceneId,
    selectedDraftGenerationId
  );
  if (!targetGenId) return '';

  const generation = await findGeneration(projectId, targetGenId);
  return generation?.responseText ?? '';
}

// NOTE: 本文参照と文体profile再生が別のgenerationを見ないよう、rewrite対象IDの
// accepted優先規則を1箇所に集約する。
export async function getCurrentSceneReferenceGenerationId(
  projectId: ProjectId,
  currentEpisodeId: string | null,
  currentSceneId: SceneId | null,
  selectedDraftGenerationId: string | null
): Promise<string | null> {
  if (!currentEpisodeId || !currentSceneId) return null;
  const episode = await storage.readEpisodeRecord(projectId, currentEpisodeId);
  if (!episode) return null;
  const scene = episode.scenes.find((s) => s.sceneId === currentSceneId);
  if (!scene) return null;

  return scene.acceptedGenerationId ?? selectedDraftGenerationId;
}

export async function getContextSummary(projectId: ProjectId): Promise<string> {
  return storage.readContextSummary(projectId);
}

export async function getStoryState(projectId: ProjectId): Promise<StoryState> {
  return readStoryState(projectId);
}

async function findGeneration(
  projectId: ProjectId,
  generationId: string
): Promise<GenerationRecord | null> {
  return storage.findGenerationRecord(projectId, generationId);
}

export async function getAcceptedEpisodeText(projectId: ProjectId, episodeId: string): Promise<string> {
  return storage.readEpisodeText(projectId, episodeId);
}

export async function buildEpisodeMarkdown(
  projectId: ProjectId,
  episode: EpisodeRecord
): Promise<string> {
  const parts: string[] = [];
  for (const scene of episode.scenes) {
    if (!scene.acceptedGenerationId) continue;
    const generation = await findGeneration(projectId, scene.acceptedGenerationId);
    if (generation) parts.push(generation.responseText);
  }
  return parts.join('\n\n');
}

export async function appendToEpisodeText(
  projectId: ProjectId,
  episodeId: string,
  text: string
): Promise<void> {
  const existing = await storage.readEpisodeText(projectId, episodeId);
  const next = existing ? `${existing}\n\n${text}` : text;
  await storage.writeEpisodeText(projectId, episodeId, next);
}
