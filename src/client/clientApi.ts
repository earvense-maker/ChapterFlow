import type {
  Character,
  ContextCompressionResult,
  CreateMemoryBody,
  CreateProjectBody,
  FrequencyReport,
  GenerateRequestBody,
  GenerationRecord,
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
  SceneNavigationDirection,
  CreateSetupSessionBody,
  SendSetupMessageBody,
  SetupCommitResponse,
  SetupDraftResponse,
  SetupMessageResponse,
  SetupPreviewResponse,
  SetupSession,
  SetupSessionResponse,
  SetupSessionSummary,
  SystemPromptPreview,
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

  createSetupSession: (body: CreateSetupSessionBody) =>
    request<SetupSessionResponse>('/setup-sessions', { method: 'POST', body: JSON.stringify(body) }),
  listSetupSessions: () => request<SetupSessionSummary[]>('/setup-sessions'),
  getSetupSession: (id: string) => request<SetupSession>(`/setup-sessions/${id}`),
  sendSetupMessage: (id: string, body: SendSetupMessageBody) =>
    request<SetupMessageResponse>(`/setup-sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateSetupDraft: (id: string, body: UpdateSetupDraftBody) =>
    request<SetupDraftResponse>(`/setup-sessions/${id}/draft`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  addSetupLock: (id: string, body: { path: string; reason?: 'user_locked' | 'manual_edit' }) =>
    request<SetupSession>(`/setup-sessions/${id}/locks`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeSetupLock: (id: string, lockId: string) =>
    request<SetupSession>(`/setup-sessions/${id}/locks/${lockId}`, { method: 'DELETE' }),
  previewSetup: (id: string) =>
    request<SetupPreviewResponse>(`/setup-sessions/${id}/preview`, { method: 'POST' }),
  commitSetup: (id: string) =>
    request<SetupCommitResponse>(`/setup-sessions/${id}/commit`, { method: 'POST' }),

  getPresets: () => request<unknown>('/presets'),
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

  getCharacters: (id: string) => request<Character[]>(`/projects/${id}/characters`),
  updateCharacters: (id: string, characters: Character[]) =>
    request<Character[]>(`/projects/${id}/characters`, { method: 'PUT', body: JSON.stringify(characters) }),

  getWorld: (id: string) => request<{ text: string }>(`/projects/${id}/world`),
  updateWorld: (id: string, text: string) =>
    request<{ text: string }>(`/projects/${id}/world`, { method: 'PUT', body: JSON.stringify({ text }) }),

  getMemories: (id: string) => request<Memory[]>(`/projects/${id}/memories`),
  createMemory: (id: string, memory: CreateMemoryBody) =>
    request<Memory>(`/projects/${id}/memories`, { method: 'POST', body: JSON.stringify(memory) }),
  updateMemory: (id: string, memoryId: string, memory: Partial<Memory>) =>
    request<Memory>(`/projects/${id}/memories/${memoryId}`, { method: 'PUT', body: JSON.stringify(memory) }),
  deleteMemory: (id: string, memoryId: string) =>
    request<void>(`/projects/${id}/memories/${memoryId}`, { method: 'DELETE' }),

  getExpressions: (id: string) => request<NgExpressionsResponse>(`/projects/${id}/expressions`),
  createExpression: (id: string, body: { text: string; source?: NgExpressionSource }) =>
    request<NgExpression>(`/projects/${id}/expressions`, { method: 'POST', body: JSON.stringify(body) }),
  archiveExpression: (id: string, expressionId: string) =>
    request<{ ok: true }>(`/projects/${id}/expressions/${expressionId}`, { method: 'DELETE' }),
  getExpressionReport: (id: string) => request<FrequencyReport>(`/projects/${id}/expressions/report`),

  generate: (id: string, body: { wish: string; mode: 'continue' | 'regenerate' | 'variate' }) =>
    request<GenerationRecord>(`/projects/${id}/generate`, { method: 'POST', body: JSON.stringify(body) }),
  generateStream: (id: string, body: GenerateRequestBody, onChunk: (text: string) => void) =>
    requestGenerationStream(id, body, onChunk),
  acceptGeneration: (id: string, generationId: string) =>
    request<GenerationRecord>(`/projects/${id}/accept`, { method: 'POST', body: JSON.stringify({ generationId }) }),
  rejectGeneration: (id: string, generationId: string) =>
    request<GenerationRecord>(`/projects/${id}/reject`, { method: 'POST', body: JSON.stringify({ generationId }) }),
  revertGeneration: (id: string) =>
    request<GenerationRecord>(`/projects/${id}/revert`, { method: 'POST' }),
  navigateScene: (id: string, direction: SceneNavigationDirection) =>
    request<ReaderState>(`/projects/${id}/navigate-scene`, {
      method: 'POST',
      body: JSON.stringify({ direction }),
    }),
  compressContext: (id: string) =>
    request<ContextCompressionResult>(`/projects/${id}/context/compress`, { method: 'POST' }),
  refreshStoryState: (id: string) =>
    request<ReaderState>(`/projects/${id}/story-state/refresh`, { method: 'POST' }),
  generationMarkdownUrl: (id: string, generationId: string, download = true) =>
    `${API_BASE}/projects/${id}/generations/${generationId}/markdown${download ? '?download=1' : ''}`,

  getReaderState: (id: string) => request<ReaderState>(`/projects/${id}/reader-state`),
  updateState: (id: string, state: Partial<ProjectState>) =>
    request<ProjectState>(`/projects/${id}/state`, { method: 'PUT', body: JSON.stringify(state) }),
};

async function requestGenerationStream(
  id: string,
  body: GenerateRequestBody,
  onChunk: (text: string) => void
): Promise<GenerationRecord> {
  const res = await fetch(`${API_BASE}/projects/${id}/generate-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
