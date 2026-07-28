import type { UserContext } from '../context/userContext.js';
import type { LegacyCharacterInput } from '../../shared/characterSchema.js';
import type {
  Character,
  EpisodeRecord,
  ExpressionsFile,
  GenerationRecord,
  GenerationStatus,
  GenerationStyleProfile,
  GenerationStyleTraceStore,
  KnowledgeExtension,
  KnowledgeIndexFile,
  Memory,
  PresetsFile,
  Project,
  ProjectState,
  RefineAutomationStore,
  RefineScanResult,
  RefineSession,
  RoleplaySession,
  SetupSession,
  StoryState,
  StoryStateDiffRecord,
  WorldContent,
} from '../types/index.js';

/**
 * 保存層の契約（設計書 4.2 / Phase 0）。
 *
 * NOTE: ここにはデータ操作だけを置き、`projectDir` などのパスヘルパーは含めない。
 * パスは Electron 版のファイル保存に固有の概念で、公開Web版の `WebStorage` には
 * 対応物が存在しない（設計書 3 の「保存先選択」行）。パスヘルパーを使っている
 * 呼び出し側は、Phase 2 で単なる差し替えではなく作り替えが必要になるため、
 * 契約に載せずインベントリ側で区別して追跡する。
 *
 * NOTE: 全メソッドが `UserContext` を第1引数に取る。所有権条件はAPIルートだけでなく
 * 保存層でも必須にするという原則（設計書 7.1-5）を、型で省略できない形にするための
 * 並びなので、引数順を変えないこと。
 */
export interface ProjectStorage {
  // --- 作品コンテナ ---
  createProjectContainer(context: UserContext, projectId: string): Promise<void>;
  projectExists(context: UserContext, projectId: string): Promise<boolean>;
  deleteProject(context: UserContext, projectId: string): Promise<void>;
  listProjectIds(context: UserContext): Promise<string[]>;

  // --- 作品メタデータと状態 ---
  readProject(context: UserContext, projectId: string): Promise<Project | null>;
  writeProject(context: UserContext, project: Project): Promise<void>;
  readState(context: UserContext, projectId: string): Promise<ProjectState | null>;
  writeState(context: UserContext, projectId: string, state: ProjectState): Promise<void>;
  readPresets(context: UserContext, projectId: string): Promise<PresetsFile | null>;
  writePresets(context: UserContext, projectId: string, presets: PresetsFile): Promise<void>;

  // --- 人物・記憶・世界設定 ---
  readCharacters(context: UserContext, projectId: string): Promise<Character[]>;
  writeCharacters(
    context: UserContext,
    projectId: string,
    characters: LegacyCharacterInput[]
  ): Promise<void>;
  readMemories(context: UserContext, projectId: string): Promise<Memory[]>;
  writeMemories(context: UserContext, projectId: string, memories: Memory[]): Promise<void>;
  readWorld(context: UserContext, projectId: string): Promise<WorldContent>;
  readWorldText(context: UserContext, projectId: string): Promise<string>;
  readWorldPromptText(context: UserContext, projectId: string): Promise<string>;
  writeWorld(context: UserContext, projectId: string, content: WorldContent): Promise<void>;
  restoreWorldText(context: UserContext, projectId: string, text: string): Promise<void>;
  readContextSummary(context: UserContext, projectId: string): Promise<string>;
  writeContextSummary(context: UserContext, projectId: string, text: string): Promise<void>;

  // --- 物語状態 ---
  readStoryState(context: UserContext, projectId: string): Promise<StoryState | null>;
  writeStoryState(context: UserContext, projectId: string, storyState: StoryState): Promise<void>;
  readStoryStateDiffs(context: UserContext, projectId: string): Promise<StoryStateDiffRecord[]>;
  writeStoryStateDiffs(
    context: UserContext,
    projectId: string,
    diffs: StoryStateDiffRecord[]
  ): Promise<void>;

  // --- NG表現 ---
  readExpressions(context: UserContext, projectId: string): Promise<ExpressionsFile>;
  writeExpressions(context: UserContext, projectId: string, file: ExpressionsFile): Promise<void>;

  // --- 参考資料 ---
  readKnowledgeIndex(context: UserContext, projectId: string): Promise<KnowledgeIndexFile>;
  writeKnowledgeIndex(
    context: UserContext,
    projectId: string,
    index: KnowledgeIndexFile
  ): Promise<void>;
  readKnowledgeContent(
    context: UserContext,
    projectId: string,
    knowledgeId: string,
    extension: KnowledgeExtension
  ): Promise<string>;
  knowledgeContentExists(
    context: UserContext,
    projectId: string,
    knowledgeId: string,
    extension: KnowledgeExtension
  ): Promise<boolean>;
  writeKnowledgeContent(
    context: UserContext,
    projectId: string,
    knowledgeId: string,
    extension: KnowledgeExtension,
    text: string
  ): Promise<void>;
  deleteKnowledgeContent(
    context: UserContext,
    projectId: string,
    knowledgeId: string,
    extension: KnowledgeExtension
  ): Promise<void>;
  listKnowledgeContentFiles(context: UserContext, projectId: string): Promise<string[]>;

  // --- 表現調整 ---
  readRefineScan(context: UserContext, projectId: string): Promise<RefineScanResult | null>;
  writeRefineScan(context: UserContext, projectId: string, scan: RefineScanResult): Promise<void>;
  readRefineSession(context: UserContext, projectId: string): Promise<RefineSession | null>;
  writeRefineSession(
    context: UserContext,
    projectId: string,
    session: RefineSession
  ): Promise<void>;
  deleteRefineSession(context: UserContext, projectId: string): Promise<void>;
  readRefineAutomation(
    context: UserContext,
    projectId: string
  ): Promise<RefineAutomationStore | null>;
  writeRefineAutomation(
    context: UserContext,
    projectId: string,
    store: RefineAutomationStore
  ): Promise<void>;
  deleteRefineAutomation(context: UserContext, projectId: string): Promise<void>;

  // --- エピソード ---
  readEpisodeRecord(
    context: UserContext,
    projectId: string,
    episodeId: string
  ): Promise<EpisodeRecord | null>;
  listEpisodeIds(context: UserContext, projectId: string): Promise<string[]>;
  writeEpisodeRecord(
    context: UserContext,
    projectId: string,
    episode: EpisodeRecord
  ): Promise<void>;
  readEpisodeText(context: UserContext, projectId: string, episodeId: string): Promise<string>;
  writeEpisodeText(
    context: UserContext,
    projectId: string,
    episodeId: string,
    text: string
  ): Promise<void>;

  // --- 生成履歴 ---
  appendGenerationLog(
    context: UserContext,
    projectId: string,
    record: GenerationRecord
  ): Promise<void>;
  appendGenerationStatusLog(
    context: UserContext,
    projectId: string,
    generationId: string,
    status: GenerationStatus
  ): Promise<void>;
  appendGenerationStyleProfileLog(
    context: UserContext,
    projectId: string,
    generationId: string,
    styleProfile: GenerationStyleProfile
  ): Promise<void>;
  appendGenerationTextRevisionLog(
    context: UserContext,
    projectId: string,
    generationId: string,
    responseText: string,
    revision: { reason: string; before: string; after: string }
  ): Promise<void>;
  findGenerationRecord(
    context: UserContext,
    projectId: string,
    generationId: string
  ): Promise<GenerationRecord | null>;
  findGenerationRecords(
    context: UserContext,
    projectId: string,
    generationIds: Iterable<string>
  ): Promise<Map<string, GenerationRecord>>;
  readGenerationStyleTraceStore(
    context: UserContext,
    projectId: string
  ): Promise<GenerationStyleTraceStore | null>;
  writeGenerationStyleTraceStore(
    context: UserContext,
    projectId: string,
    store: GenerationStyleTraceStore
  ): Promise<void>;
  readGenerationMarkdown(
    context: UserContext,
    projectId: string,
    generationId: string
  ): Promise<string>;
  writeGenerationMarkdown(
    context: UserContext,
    projectId: string,
    generationId: string,
    text: string
  ): Promise<void>;
  readGenerationPromptSnapshot(
    context: UserContext,
    projectId: string,
    generationId: string
  ): Promise<string>;
  writeGenerationPromptSnapshot(
    context: UserContext,
    projectId: string,
    generationId: string,
    text: string
  ): Promise<void>;

  // --- 作品化前の相談セッション（作品ではなく利用者に属する） ---
  readSetupSession(context: UserContext, sessionId: string): Promise<SetupSession | null>;
  writeSetupSession(context: UserContext, session: SetupSession): Promise<void>;
  deleteSetupSession(context: UserContext, sessionId: string): Promise<void>;
  setupSessionExists(context: UserContext, sessionId: string): Promise<boolean>;
  listSetupSessionIds(context: UserContext): Promise<string[]>;

  // --- ロールプレイセッション ---
  readRoleplaySession(
    context: UserContext,
    projectId: string,
    sessionId: string
  ): Promise<RoleplaySession | null>;
  writeRoleplaySession(context: UserContext, session: RoleplaySession): Promise<void>;
  listRoleplaySessionIds(context: UserContext, projectId: string): Promise<string[]>;
  roleplaySessionExists(
    context: UserContext,
    projectId: string,
    sessionId: string
  ): Promise<boolean>;
}

/**
 * 契約メソッドの実行時一覧。ガードやバインドを1箇所で回すために必要で、
 * 型だけの `keyof ProjectStorage` では実行時に列挙できないため併置する。
 */
export const PROJECT_STORAGE_METHODS = [
  'createProjectContainer',
  'projectExists',
  'deleteProject',
  'listProjectIds',
  'readProject',
  'writeProject',
  'readState',
  'writeState',
  'readPresets',
  'writePresets',
  'readCharacters',
  'writeCharacters',
  'readMemories',
  'writeMemories',
  'readWorld',
  'readWorldText',
  'readWorldPromptText',
  'writeWorld',
  'restoreWorldText',
  'readContextSummary',
  'writeContextSummary',
  'readStoryState',
  'writeStoryState',
  'readStoryStateDiffs',
  'writeStoryStateDiffs',
  'readExpressions',
  'writeExpressions',
  'readKnowledgeIndex',
  'writeKnowledgeIndex',
  'readKnowledgeContent',
  'knowledgeContentExists',
  'writeKnowledgeContent',
  'deleteKnowledgeContent',
  'listKnowledgeContentFiles',
  'readRefineScan',
  'writeRefineScan',
  'readRefineSession',
  'writeRefineSession',
  'deleteRefineSession',
  'readRefineAutomation',
  'writeRefineAutomation',
  'deleteRefineAutomation',
  'readEpisodeRecord',
  'listEpisodeIds',
  'writeEpisodeRecord',
  'readEpisodeText',
  'writeEpisodeText',
  'appendGenerationLog',
  'appendGenerationStatusLog',
  'appendGenerationStyleProfileLog',
  'appendGenerationTextRevisionLog',
  'findGenerationRecord',
  'findGenerationRecords',
  'readGenerationStyleTraceStore',
  'writeGenerationStyleTraceStore',
  'readGenerationMarkdown',
  'writeGenerationMarkdown',
  'readGenerationPromptSnapshot',
  'writeGenerationPromptSnapshot',
  'readSetupSession',
  'writeSetupSession',
  'deleteSetupSession',
  'setupSessionExists',
  'listSetupSessionIds',
  'readRoleplaySession',
  'writeRoleplaySession',
  'listRoleplaySessionIds',
  'roleplaySessionExists',
] as const satisfies readonly (keyof ProjectStorage)[];

// NOTE: 契約へメソッドを足して PROJECT_STORAGE_METHODS への追加を忘れると、
// ガードもバインドもそのメソッドを素通りさせてしまう（= 所有権検査が抜ける）。
// 追加漏れをここで型エラーにする。
type RequireEmpty<T extends never> = T;
export type ProjectStorageMethodsAreExhaustive = RequireEmpty<
  Exclude<keyof ProjectStorage, (typeof PROJECT_STORAGE_METHODS)[number]>
>;

/** 契約から `UserContext` 引数だけを外した形。実装側とバインド済み facade で使う。 */
export type WithoutUserContext<T> = {
  [K in keyof T]: T[K] extends (context: UserContext, ...args: infer A) => infer R
    ? (...args: A) => R
    : never;
};
