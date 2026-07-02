import type {
  Character,
  CreateProjectBody,
  GenerationRecord,
  Memory,
  PresetsFile,
  Project,
  ProjectState,
  ProjectSummary,
  ReaderState,
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
    throw new Error(body.error || `Request failed: ${res.status}`);
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

  getPresets: () => request<unknown>('/presets'),
  getProjectPresets: (id: string) => request<PresetsFile>(`/projects/${id}/presets`),
  updateProjectPresets: (id: string, presets: Partial<PresetsFile>) =>
    request<PresetsFile>(`/projects/${id}/presets`, { method: 'PUT', body: JSON.stringify(presets) }),

  getCharacters: (id: string) => request<Character[]>(`/projects/${id}/characters`),
  updateCharacters: (id: string, characters: Character[]) =>
    request<Character[]>(`/projects/${id}/characters`, { method: 'PUT', body: JSON.stringify(characters) }),

  getWorld: (id: string) => request<{ text: string }>(`/projects/${id}/world`),
  updateWorld: (id: string, text: string) =>
    request<{ text: string }>(`/projects/${id}/world`, { method: 'PUT', body: JSON.stringify({ text }) }),

  getMemories: (id: string) => request<Memory[]>(`/projects/${id}/memories`),
  createMemory: (id: string, memory: Omit<Memory, 'memoryId' | 'createdAt' | 'updatedAt'>) =>
    request<Memory>(`/projects/${id}/memories`, { method: 'POST', body: JSON.stringify(memory) }),
  updateMemory: (id: string, memoryId: string, memory: Partial<Memory>) =>
    request<Memory>(`/projects/${id}/memories/${memoryId}`, { method: 'PUT', body: JSON.stringify(memory) }),
  deleteMemory: (id: string, memoryId: string) =>
    request<void>(`/projects/${id}/memories/${memoryId}`, { method: 'DELETE' }),

  generate: (id: string, body: { wish: string; mode: 'continue' | 'regenerate' | 'variate' }) =>
    request<GenerationRecord>(`/projects/${id}/generate`, { method: 'POST', body: JSON.stringify(body) }),
  acceptGeneration: (id: string, generationId: string) =>
    request<GenerationRecord>(`/projects/${id}/accept`, { method: 'POST', body: JSON.stringify({ generationId }) }),
  rejectGeneration: (id: string, generationId: string) =>
    request<GenerationRecord>(`/projects/${id}/reject`, { method: 'POST', body: JSON.stringify({ generationId }) }),
  revertGeneration: (id: string) =>
    request<GenerationRecord>(`/projects/${id}/revert`, { method: 'POST' }),

  getReaderState: (id: string) => request<ReaderState>(`/projects/${id}/reader-state`),
  updateState: (id: string, state: Partial<ProjectState>) =>
    request<ProjectState>(`/projects/${id}/state`, { method: 'PUT', body: JSON.stringify(state) }),
};
