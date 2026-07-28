import * as storage from '../services/storageService.js';
import { assertLocalUserContext, type UserContext } from '../context/userContext.js';
import {
  PROJECT_STORAGE_METHODS,
  type ProjectStorage,
  type WithoutUserContext,
} from './projectStorage.js';

/**
 * Electron 版の保存実装（設計書 4.2 の `FileStorage`）。
 *
 * NOTE: 既存 `storageService` の挙動・保存形式を変えないことが Phase 0 の完了条件なので、
 * ここでは委譲だけを行い、正規化やロック順序を足さない。
 *
 * NOTE: 各メソッドを `storage.foo` の参照でなく呼び出しで包んでいるのは、テストの
 * `vi.spyOn(storage, ...)` を効かせ続けるため。参照を束縛すると差し替え前の実体が
 * 残り、既存テストが黙って素通りする。
 */
const localOperations: WithoutUserContext<ProjectStorage> = {
  createProjectContainer: (projectId) => storage.createProjectDir(projectId),
  projectExists: (projectId) => storage.projectExists(projectId),
  deleteProject: (projectId) => storage.deleteProjectDir(projectId),
  listProjectIds: () => storage.listProjectIds(),

  readProject: (projectId) => storage.readProject(projectId),
  writeProject: (project) => storage.writeProject(project),
  readState: (projectId) => storage.readState(projectId),
  writeState: (projectId, state) => storage.writeState(projectId, state),
  readPresets: (projectId) => storage.readPresets(projectId),
  writePresets: (projectId, presets) => storage.writePresets(projectId, presets),

  readCharacters: (projectId) => storage.readCharacters(projectId),
  writeCharacters: (projectId, characters) => storage.writeCharacters(projectId, characters),
  readMemories: (projectId) => storage.readMemories(projectId),
  writeMemories: (projectId, memories) => storage.writeMemories(projectId, memories),
  readWorld: (projectId) => storage.readWorld(projectId),
  readWorldText: (projectId) => storage.readWorldText(projectId),
  readWorldPromptText: (projectId) => storage.readWorldPromptText(projectId),
  writeWorld: (projectId, content) => storage.writeWorld(projectId, content),
  restoreWorldText: (projectId, text) => storage.restoreWorldText(projectId, text),
  readContextSummary: (projectId) => storage.readContextSummary(projectId),
  writeContextSummary: (projectId, text) => storage.writeContextSummary(projectId, text),

  readStoryState: (projectId) => storage.readStoryState(projectId),
  writeStoryState: (projectId, storyState) => storage.writeStoryState(projectId, storyState),
  readStoryStateDiffs: (projectId) => storage.readStoryStateDiffs(projectId),
  writeStoryStateDiffs: (projectId, diffs) => storage.writeStoryStateDiffs(projectId, diffs),

  readExpressions: (projectId) => storage.readExpressions(projectId),
  writeExpressions: (projectId, file) => storage.writeExpressions(projectId, file),

  readKnowledgeIndex: (projectId) => storage.readKnowledgeIndex(projectId),
  writeKnowledgeIndex: (projectId, index) => storage.writeKnowledgeIndex(projectId, index),
  readKnowledgeContent: (projectId, knowledgeId, extension) =>
    storage.readKnowledgeContent(projectId, knowledgeId, extension),
  knowledgeContentExists: (projectId, knowledgeId, extension) =>
    storage.knowledgeContentExists(projectId, knowledgeId, extension),
  writeKnowledgeContent: (projectId, knowledgeId, extension, text) =>
    storage.writeKnowledgeContent(projectId, knowledgeId, extension, text),
  deleteKnowledgeContent: (projectId, knowledgeId, extension) =>
    storage.deleteKnowledgeContent(projectId, knowledgeId, extension),
  listKnowledgeContentFiles: (projectId) => storage.listKnowledgeContentFiles(projectId),

  readRefineScan: (projectId) => storage.readRefineScan(projectId),
  writeRefineScan: (projectId, scan) => storage.writeRefineScan(projectId, scan),
  readRefineSession: (projectId) => storage.readRefineSession(projectId),
  writeRefineSession: (projectId, session) => storage.writeRefineSession(projectId, session),
  deleteRefineSession: (projectId) => storage.deleteRefineSession(projectId),
  readRefineAutomation: (projectId) => storage.readRefineAutomation(projectId),
  writeRefineAutomation: (projectId, store) => storage.writeRefineAutomation(projectId, store),
  deleteRefineAutomation: (projectId) => storage.deleteRefineAutomation(projectId),

  readEpisodeRecord: (projectId, episodeId) => storage.readEpisodeRecord(projectId, episodeId),
  listEpisodeIds: (projectId) => storage.listEpisodeIds(projectId),
  writeEpisodeRecord: (projectId, episode) => storage.writeEpisodeRecord(projectId, episode),
  readEpisodeText: (projectId, episodeId) => storage.readEpisodeText(projectId, episodeId),
  writeEpisodeText: (projectId, episodeId, text) =>
    storage.writeEpisodeText(projectId, episodeId, text),

  appendGenerationLog: (projectId, record) => storage.appendGenerationLog(projectId, record),
  appendGenerationStatusLog: (projectId, generationId, status) =>
    storage.appendGenerationStatusLog(projectId, generationId, status),
  appendGenerationStyleProfileLog: (projectId, generationId, styleProfile) =>
    storage.appendGenerationStyleProfileLog(projectId, generationId, styleProfile),
  appendGenerationTextRevisionLog: (projectId, generationId, responseText, revision) =>
    storage.appendGenerationTextRevisionLog(projectId, generationId, responseText, revision),
  findGenerationRecord: (projectId, generationId) =>
    storage.findGenerationRecord(projectId, generationId),
  findGenerationRecords: (projectId, generationIds) =>
    storage.findGenerationRecords(projectId, generationIds),
  readGenerationStyleTraceStore: (projectId) => storage.readGenerationStyleTraceStore(projectId),
  writeGenerationStyleTraceStore: (projectId, store) =>
    storage.writeGenerationStyleTraceStore(projectId, store),
  readGenerationMarkdown: (projectId, generationId) =>
    storage.readGenerationMarkdown(projectId, generationId),
  writeGenerationMarkdown: (projectId, generationId, text) =>
    storage.writeGenerationMarkdown(projectId, generationId, text),
  readGenerationPromptSnapshot: (projectId, generationId) =>
    storage.readGenerationPromptSnapshot(projectId, generationId),
  writeGenerationPromptSnapshot: (projectId, generationId, text) =>
    storage.writeGenerationPromptSnapshot(projectId, generationId, text),

  readSetupSession: (sessionId) => storage.readSetupSession(sessionId),
  writeSetupSession: (session) => storage.writeSetupSession(session),
  deleteSetupSession: (sessionId) => storage.deleteSetupSession(sessionId),
  setupSessionExists: (sessionId) => storage.setupSessionExists(sessionId),
  listSetupSessionIds: () => storage.listSetupSessionIds(),

  readRoleplaySession: (projectId, sessionId) =>
    storage.readRoleplaySession(projectId, sessionId),
  writeRoleplaySession: (session) => storage.writeRoleplaySession(session),
  listRoleplaySessionIds: (projectId) => storage.listRoleplaySessionIds(projectId),
  roleplaySessionExists: (projectId, sessionId) =>
    storage.roleplaySessionExists(projectId, sessionId),
};

export function createFileProjectStorage(): ProjectStorage {
  return requireLocalUserContext(localOperations);
}

// NOTE: 所有権検査をメソッドごとに書くと、追加時に1つ書き忘れただけで穴が開く。
// 一覧を回して同じガードを機械的に付ける形にし、書き忘れを構造的に不可能にする。
// FileStorage は単一利用者のローカルディレクトリしか見ないので、web コンテキストは
// 「ユーザーの取り違え」ではなく「配線ミス」として即座に失敗させる。
function requireLocalUserContext(operations: WithoutUserContext<ProjectStorage>): ProjectStorage {
  const guarded: Partial<Record<keyof ProjectStorage, unknown>> = {};
  for (const method of PROJECT_STORAGE_METHODS) {
    const operation = operations[method] as (...args: unknown[]) => unknown;
    guarded[method] = (context: UserContext, ...args: unknown[]) => {
      assertLocalUserContext(context, method);
      return operation(...args);
    };
  }
  return guarded as ProjectStorage;
}
