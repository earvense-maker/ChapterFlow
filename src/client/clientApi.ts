import type {
  ArchiveRoleplaySessionBody,
  Character,
  CommitSetupBody,
  ContextCompressionResult,
  CreateMemoryBody,
  CreateProjectBody,
  CreateRoleplaySessionBody,
  DataDirApplyResponse,
  DataDirInfo,
  DataDirPreview,
  DataDirSelectResponse,
  AppModelSettings,
  GenerateRequestBody,
  GenerationRecord,
  KnowledgeContentResponse,
  KnowledgeFile,
  KnowledgeListItem,
  Memory,
  ModelProviderInfo,
  NgExpression,
  NgExpressionSource,
  NgExpressionsResponse,
  PresetsFile,
  Project,
  ProjectState,
  ProjectSummary,
  ReaderState,
  RefineApplyResponse,
  RefineChatResponse,
  RefineReviewStatus,
  RefineScanResult,
  RefineSession,
  RegenerateRoleplayBody,
  RoleplaySessionListResponse,
  RoleplaySessionResponse,
  RoleplaySessionView,
  SceneNavigationDirection,
  SendRoleplayMessageBody,
  StoryState,
  StoryStateDiffRecord,
  StyleSamplePreset,
  CreateSetupSessionBody,
  PatchSetupSettingsBody,
  PatchSetupSettingsResponse,
  RetrySetupMessageBody,
  SendSetupMessageBody,
  SetLockStateBody,
  SetupCommitPlanResponse,
  SetupCommitResponse,
  SetupDraftResponse,
  SetupLockStateResponse,
  SetupMessageResponse,
  SetupPreviewResponse,
  SetupSession,
  SetupSessionResponse,
  SetupSessionSummary,
  SystemVersionInfo,
  SystemPromptPreview,
  SystemPromptPreset,
  UpdateSetupDraftBody,
  UpdateProjectBody,
} from '@shared/types';

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(formatApiError(body, res.status));
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () => request<ProjectSummary[]>('/projects'),
  createProject: (body: CreateProjectBody) => request<Project>('/projects', { method: 'POST', body: JSON.stringify(body) }),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  updateProject: (id: string, body: UpdateProjectBody) =>
    request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  duplicateProject: (id: string, title?: string) =>
    request<Project>(`/projects/${id}/duplicate`, { method: 'POST', body: JSON.stringify({ title }) }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
  shutdown: () => request<{ ok: boolean }>('/shutdown', { method: 'POST' }),
  getSystemVersion: () => request<SystemVersionInfo>('/system/version'),
  getDataDirInfo: () => request<DataDirInfo>('/system/data-dir'),
  previewDataDirMove: (targetPath: string) =>
    request<DataDirPreview>('/system/data-dir/preview', {
      method: 'POST',
      body: JSON.stringify({ targetPath }),
    }),
  applyDataDirMove: (targetPath: string) =>
    request<DataDirApplyResponse>('/system/data-dir/apply', {
      method: 'POST',
      body: JSON.stringify({ targetPath }),
    }),
  selectDataDirFolder: (currentPath?: string) =>
    request<DataDirSelectResponse>('/system/data-dir/select-folder', {
      method: 'POST',
      body: JSON.stringify({ currentPath }),
    }),

  createSetupSession: (body: CreateSetupSessionBody) =>
    request<SetupSessionResponse>('/setup-sessions', { method: 'POST', body: JSON.stringify(body) }),
  listSetupSessions: () => request<SetupSessionSummary[]>('/setup-sessions'),
  getSetupSession: (id: string) => request<SetupSession>(`/setup-sessions/${id}`),
  sendSetupMessage: (id: string, body: SendSetupMessageBody) =>
    request<SetupMessageResponse>(`/setup-sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  retrySetupMessage: (id: string, body: RetrySetupMessageBody = {}) =>
    request<SetupMessageResponse>(`/setup-sessions/${id}/messages/retry`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateSetupDraft: (id: string, body: UpdateSetupDraftBody) =>
    request<SetupDraftResponse>(`/setup-sessions/${id}/draft`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  setSetupLockState: (id: string, body: SetLockStateBody) =>
    request<SetupLockStateResponse>(`/setup-sessions/${id}/lock-state`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  previewSetup: (id: string, instruction?: string) =>
    request<SetupPreviewResponse>(`/setup-sessions/${id}/preview`, {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    }),
  createSetupCommitPlan: (id: string) =>
    request<SetupCommitPlanResponse>(`/setup-sessions/${id}/commit-plan`, { method: 'POST' }),
  commitSetup: (id: string, body: CommitSetupBody) =>
    request<SetupCommitResponse>(`/setup-sessions/${id}/commit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  abandonSetupSession: (id: string) =>
    request<SetupSession>(`/setup-sessions/${id}/abandon`, { method: 'POST' }),
  deleteSetupSession: (id: string) =>
    request<{ ok: true }>(`/setup-sessions/${id}`, { method: 'DELETE' }),
  patchSetupSettings: (id: string, body: PatchSetupSettingsBody) =>
    request<PatchSetupSettingsResponse>(`/setup-sessions/${id}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  getPresets: () => request<unknown>('/presets'),
  getStyleSamples: () =>
    request<{ items: StyleSamplePreset[] }>('/style-samples').then((res) => res.items),
  getSystemPromptPresets: () =>
    request<{ items: SystemPromptPreset[] }>('/system-prompt-presets').then((res) => res.items),
  createSystemPromptPreset: (body: { name: string; prompt: string }) =>
    request<SystemPromptPreset>('/system-prompt-presets', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateSystemPromptPreset: (
    id: string,
    body: { name: string; prompt: string; expectedUpdatedAt: string }
  ) =>
    request<SystemPromptPreset>(`/system-prompt-presets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteSystemPromptPreset: (id: string) =>
    request<void>(`/system-prompt-presets/${id}`, { method: 'DELETE' }),
  getProjectPresets: (id: string) => request<PresetsFile>(`/projects/${id}/presets`),
  updateProjectPresets: (id: string, presets: Partial<PresetsFile>) =>
    request<PresetsFile>(`/projects/${id}/presets`, { method: 'PUT', body: JSON.stringify(presets) }),
  previewSystemPrompt: (id: string, presets: Partial<PresetsFile>, customSystemPrompt?: string | null) =>
    request<SystemPromptPreview>(`/projects/${id}/system-prompt/preview`, {
      method: 'POST',
      body: JSON.stringify({ presets, customSystemPrompt }),
    }),
  saveCredential: (provider: string, apiKey: string) =>
    request<{ ok: true }>('/models/credentials', {
      method: 'POST',
      body: JSON.stringify({ provider, apiKey }),
    }),
  getModelProviders: () => request<ModelProviderInfo[]>('/models/providers'),
  getDefaultModelSettings: () => request<AppModelSettings>('/models/default'),
  updateDefaultModelSettings: (body: AppModelSettings) =>
    request<AppModelSettings>('/models/default', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  getCharacters: (id: string) => request<Character[]>(`/projects/${id}/characters`),
  updateCharacters: (id: string, characters: Character[]) =>
    request<Character[]>(`/projects/${id}/characters`, { method: 'PUT', body: JSON.stringify(characters) }),

  getWorld: (id: string) => request<{ text: string }>(`/projects/${id}/world`),
  updateWorld: (id: string, text: string) =>
    request<{ text: string }>(`/projects/${id}/world`, { method: 'PUT', body: JSON.stringify({ text }) }),

  getStoryState: (id: string) => request<StoryState>(`/projects/${id}/story-state`),
  updateStoryState: (id: string, state: StoryState) =>
    request<StoryState>(`/projects/${id}/story-state`, { method: 'PUT', body: JSON.stringify(state) }),
  getStoryStateDiffs: (id: string) =>
    request<StoryStateDiffRecord[]>(`/projects/${id}/story-state/diffs`),
  revertStoryStateDiff: (id: string, diffId: string) =>
    request<{ storyState: StoryState; diff: StoryStateDiffRecord }>(
      `/projects/${id}/story-state/diffs/${diffId}/revert`,
      { method: 'POST' }
    ),

  getMemories: (id: string) => request<Memory[]>(`/projects/${id}/memories`),
  createMemory: (id: string, memory: CreateMemoryBody) =>
    request<Memory>(`/projects/${id}/memories`, { method: 'POST', body: JSON.stringify(memory) }),
  updateMemory: (id: string, memoryId: string, memory: Partial<Memory>) =>
    request<Memory>(`/projects/${id}/memories/${memoryId}`, { method: 'PUT', body: JSON.stringify(memory) }),
  deleteMemory: (id: string, memoryId: string) =>
    request<void>(`/projects/${id}/memories/${memoryId}`, { method: 'DELETE' }),

  getKnowledge: (id: string) => request<KnowledgeListItem[]>(`/projects/${id}/knowledge`),
  getKnowledgeContent: (id: string, knowledgeId: string) =>
    request<KnowledgeContentResponse>(`/projects/${id}/knowledge/${knowledgeId}`),
  createKnowledge: (id: string, body: { fileName: string; content: string }) =>
    request<KnowledgeFile>(`/projects/${id}/knowledge`, { method: 'POST', body: JSON.stringify(body) }),
  updateKnowledge: (
    id: string,
    knowledgeId: string,
    body: Partial<{ title: string; content: string; enabled: boolean; order: number }>
  ) =>
    request<KnowledgeFile>(`/projects/${id}/knowledge/${knowledgeId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  reorderKnowledge: (id: string, orderedIds: string[]) =>
    request<KnowledgeFile[]>(`/projects/${id}/knowledge-order`, {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    }),
  deleteKnowledge: (id: string, knowledgeId: string) =>
    request<void>(`/projects/${id}/knowledge/${knowledgeId}`, { method: 'DELETE' }),

  getExpressions: (id: string) => request<NgExpressionsResponse>(`/projects/${id}/expressions`),
  createExpression: (id: string, body: { text: string; source?: NgExpressionSource }) =>
    request<NgExpression>(`/projects/${id}/expressions`, { method: 'POST', body: JSON.stringify(body) }),
  archiveExpression: (id: string, expressionId: string) =>
    request<{ ok: true }>(`/projects/${id}/expressions/${expressionId}`, { method: 'DELETE' }),

  getRefineScan: (id: string) =>
    request<RefineScanResult | null>(`/projects/${id}/refine/scan`),
  scanRefine: (id: string) =>
    request<RefineScanResult>(`/projects/${id}/refine/scan`, { method: 'POST' }),
  getRefineReviewStatus: (id: string) =>
    request<RefineReviewStatus>(`/projects/${id}/refine/status`),

  getRefineSession: (id: string) => request<RefineSession>(`/projects/${id}/refine/session`),
  resetRefineSession: (id: string) =>
    request<RefineSession>(`/projects/${id}/refine/session`, { method: 'DELETE' }),
  sendRefineMessage: (id: string, content: string) =>
    request<RefineChatResponse>(`/projects/${id}/refine/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  applyRefinePatch: (id: string, patchId: string) =>
    request<RefineApplyResponse>(`/projects/${id}/refine/patches/${patchId}/apply`, {
      method: 'POST',
    }),
  rejectRefinePatch: (id: string, patchId: string) =>
    request<RefineApplyResponse>(`/projects/${id}/refine/patches/${patchId}/reject`, {
      method: 'POST',
    }),

  generate: (id: string, body: { wish: string; mode: 'continue' | 'regenerate' | 'variate' }) =>
    request<GenerationRecord>(`/projects/${id}/generate`, { method: 'POST', body: JSON.stringify(body) }),
  generateStream: (
    id: string,
    body: GenerateRequestBody,
    onChunk: (text: string) => void,
    abortSignal?: AbortSignal
  ) => requestGenerationStream(id, body, onChunk, abortSignal),
  sendSetupMessageStream: (
    id: string,
    body: SendSetupMessageBody,
    handlers: SetupMessageStreamHandlers,
    abortSignal?: AbortSignal
  ) => sendSetupMessageStream(id, body, handlers, abortSignal),
  acceptGeneration: (id: string, generationId: string) =>
    request<GenerationRecord>(`/projects/${id}/accept`, { method: 'POST', body: JSON.stringify({ generationId }) }),
  rejectGeneration: (id: string, generationId: string) =>
    request<GenerationRecord>(`/projects/${id}/reject`, { method: 'POST', body: JSON.stringify({ generationId }) }),
  revertGeneration: (id: string) =>
    request<GenerationRecord>(`/projects/${id}/revert`, { method: 'POST' }),
  unacceptCurrentScene: (id: string) =>
    request<GenerationRecord>(`/projects/${id}/unaccept`, { method: 'POST' }),
  navigateScene: (id: string, direction: SceneNavigationDirection) =>
    request<ReaderState>(`/projects/${id}/navigate-scene`, {
      method: 'POST',
      body: JSON.stringify({ direction }),
    }),
  compressContext: (id: string) =>
    request<ContextCompressionResult>(`/projects/${id}/context/compress`, { method: 'POST' }),
  refreshStoryState: (id: string) =>
    request<ReaderState>(`/projects/${id}/story-state/refresh`, { method: 'POST' }),

  getReaderState: (id: string) => request<ReaderState>(`/projects/${id}/reader-state`),
  updateState: (id: string, state: Partial<ProjectState>) =>
    request<ProjectState>(`/projects/${id}/state`, { method: 'PUT', body: JSON.stringify(state) }),

  // ===== ロールプレイモード =====
  createRoleplaySession: (projectId: string, body: CreateRoleplaySessionBody) =>
    request<RoleplaySessionResponse>(`/projects/${projectId}/roleplay/sessions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listRoleplaySessions: (projectId: string) =>
    request<RoleplaySessionListResponse>(`/projects/${projectId}/roleplay/sessions`),
  getRoleplaySession: (projectId: string, sessionId: string) =>
    request<RoleplaySessionResponse>(`/projects/${projectId}/roleplay/sessions/${sessionId}`),
  archiveRoleplaySession: (
    projectId: string,
    sessionId: string,
    body: ArchiveRoleplaySessionBody
  ) =>
    request<RoleplaySessionResponse>(`/projects/${projectId}/roleplay/sessions/${sessionId}`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    }),
  sendRoleplayMessageStream: (
    projectId: string,
    sessionId: string,
    body: SendRoleplayMessageBody,
    handlers: RoleplayStreamHandlers,
    abortSignal?: AbortSignal
  ) =>
    roleplayStream(
      `/projects/${projectId}/roleplay/sessions/${sessionId}/messages-stream`,
      body,
      handlers,
      abortSignal
    ),
  regenerateRoleplayStream: (
    projectId: string,
    sessionId: string,
    body: RegenerateRoleplayBody,
    handlers: RoleplayStreamHandlers,
    abortSignal?: AbortSignal
  ) =>
    roleplayStream(
      `/projects/${projectId}/roleplay/sessions/${sessionId}/regenerate-stream`,
      body,
      handlers,
      abortSignal
    ),
};

export interface RoleplayStreamHandlers {
  onChunk: (text: string) => void;
  onDone: (session: RoleplaySessionView) => void;
  onError: (error: {
    error: string;
    code?: string;
    retryable?: boolean;
    revision?: number;
  }) => void;
}

async function roleplayStream(
  path: string,
  body: unknown,
  handlers: RoleplayStreamHandlers,
  abortSignal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
  } catch (err) {
    // NOTE: 接続失敗・AbortError も含めて onError で拾う（review §5.4）。
    // これを onError にフックしないと、呼び元 UI の isStreaming フラグが立ちっぱなしになる。
    const aborted = (err as { name?: string })?.name === 'AbortError';
    handlers.onError({
      error: aborted
        ? '応答の受信を中断しました。'
        : err instanceof Error
          ? err.message
          : '応答の受信に失敗しました。',
      code: aborted ? 'aborted' : 'network_error',
      retryable: !aborted,
    });
    return;
  }
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    handlers.onError({
      error: errorBody.error || `Request failed: ${res.status}`,
      code: errorBody.code,
      retryable: errorBody.retryable,
      revision: errorBody.revision,
    });
    return;
  }
  if (!res.body) {
    handlers.onError({ error: 'ストリーミング応答を読み取れませんでした', retryable: false });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // NOTE: サーバーが done/error のいずれかを送ったかを追跡する。
  // どちらも来ずに EOF した場合は「異常終了」として onError を呼ぶ（review §5.4）。
  let sawTerminal = false;

  const handleEvent = (event: string, data: string) => {
    if (event === 'chunk') {
      const payload = JSON.parse(data) as { text?: string };
      if (payload.text) handlers.onChunk(payload.text);
    } else if (event === 'done') {
      sawTerminal = true;
      const payload = JSON.parse(data) as { session?: RoleplaySessionView };
      if (payload.session) handlers.onDone(payload.session);
    } else if (event === 'error') {
      sawTerminal = true;
      const payload = JSON.parse(data) as {
        error?: string;
        code?: string;
        retryable?: boolean;
        revision?: number;
      };
      handlers.onError({
        error: payload.error ?? 'ロールプレイ応答に失敗しました',
        code: payload.code,
        retryable: payload.retryable,
        revision: payload.revision,
      });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainStreamEvents(buffer, handleEvent);
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      drainStreamEvents(`${buffer}\n\n`, handleEvent);
    }
  } catch (err) {
    // NOTE: reader.read() 中の abort・通信断・decode エラー。ここも必ず onError へ流す。
    const aborted = (err as { name?: string })?.name === 'AbortError';
    handlers.onError({
      error: aborted
        ? '応答の受信を中断しました。'
        : err instanceof Error
          ? err.message
          : '応答の読み取りに失敗しました。',
      code: aborted ? 'aborted' : 'stream_read_failed',
      retryable: !aborted,
    });
    return;
  }

  if (!sawTerminal) {
    // NOTE: サーバーがヘッダーだけ送って接続を切った・プロセス落ちなど、done/error
    // どちらも受信しない EOF。UI が isStreaming のまま固まらないよう明示エラーで通知。
    handlers.onError({
      error: '応答が完了せずに切断されました。しばらくしてから再試行してください。',
      code: 'stream_ended_unexpectedly',
      retryable: true,
    });
  }
}

export interface SetupMessageStreamHandlers {
  onDelta: (text: string) => void;
  onResult: (response: SetupMessageResponse) => void;
  onError: (error: {
    error: string;
    code?: string;
    retryable?: boolean;
    session?: SetupSession;
  }) => void;
}

async function sendSetupMessageStream(
  id: string,
  body: SendSetupMessageBody,
  handlers: SetupMessageStreamHandlers,
  abortSignal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${API_BASE}/setup-sessions/${id}/messages/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(formatApiError(errorBody, res.status));
  }
  if (!res.body) throw new Error('ストリーミング応答を読み取れませんでした');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleEvent = (event: string, data: string) => {
    if (event === 'delta') {
      const payload = JSON.parse(data) as { text?: string };
      if (payload.text) handlers.onDelta(payload.text);
    }
    if (event === 'result') {
      handlers.onResult(JSON.parse(data) as SetupMessageResponse);
    }
    if (event === 'error') {
      const payload = JSON.parse(data) as {
        error?: string;
        code?: string;
        retryable?: boolean;
        session?: SetupSession;
      };
      handlers.onError({
        error: payload.error ?? '相談処理に失敗しました',
        code: payload.code,
        retryable: payload.retryable,
        session: payload.session,
      });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = drainStreamEvents(buffer, handleEvent);
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    drainStreamEvents(`${buffer}\n\n`, handleEvent);
  }
}

async function requestGenerationStream(
  id: string,
  body: GenerateRequestBody,
  onChunk: (text: string) => void,
  abortSignal?: AbortSignal
): Promise<GenerationRecord> {
  const res = await fetch(`${API_BASE}/projects/${id}/generate-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.error || `Request failed: ${res.status}`);
  }
  if (!res.body) throw new Error('ストリーミング応答を読み取れませんでした');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalRecord: GenerationRecord | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = drainStreamEvents(buffer, (event, data) => {
      if (event === 'chunk') {
        const payload = JSON.parse(data) as { text?: string };
        if (payload.text) onChunk(payload.text);
      }
      if (event === 'done') {
        const payload = JSON.parse(data) as { record?: GenerationRecord };
        if (payload.record) finalRecord = payload.record;
      }
      if (event === 'error') {
        const payload = JSON.parse(data) as { error?: string; code?: string; retryable?: boolean };
        throw new Error(formatApiError(payload, 503));
      }
    });
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    drainStreamEvents(`${buffer}\n\n`, (event, data) => {
      if (event === 'chunk') {
        const payload = JSON.parse(data) as { text?: string };
        if (payload.text) onChunk(payload.text);
      }
      if (event === 'done') {
        const payload = JSON.parse(data) as { record?: GenerationRecord };
        if (payload.record) finalRecord = payload.record;
      }
      if (event === 'error') {
        const payload = JSON.parse(data) as { error?: string; code?: string; retryable?: boolean };
        throw new Error(formatApiError(payload, 503));
      }
    });
  }

  if (!finalRecord) throw new Error('生成結果を確定できませんでした');
  return finalRecord;
}

function formatApiError(body: { error?: string; code?: string; retryable?: boolean }, status: number): string {
  const parts = [body.error || `Request failed: ${status}`];
  if (body.code) parts.push(`コード: ${body.code}`);
  if (body.retryable) parts.push('少し待って再試行できます。');
  return parts.join('\n');
}

function drainStreamEvents(
  buffer: string,
  onEvent: (event: string, data: string) => void
): string {
  let current = buffer.replace(/\r\n/g, '\n');

  while (true) {
    const index = current.indexOf('\n\n');
    if (index < 0) return current;

    const block = current.slice(0, index);
    current = current.slice(index + 2);
    const parsed = parseStreamEvent(block);
    if (parsed) onEvent(parsed.event, parsed.data);
  }
}

function parseStreamEvent(block: string): { event: string; data: string } | null {
  const lines = block.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (dataLines.length === 0) return null;

  return {
    event: eventLine?.slice(6).trim() || 'message',
    data: dataLines.map((line) => line.slice(5).trimStart()).join('\n'),
  };
}
