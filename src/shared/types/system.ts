import type { ProjectId } from './ids.js';

export type RuntimeKind = 'electron' | 'server';

export interface SystemVersionInfo {
  version: string;
  runtime: RuntimeKind;
}

export interface DataDirInfo {
  current: string;
  defaultPath: string;
  isUsingDefault: boolean;
  pendingCleanup?: string | null;
  previousDataDir?: string | null;
}

export interface DataDirPreview {
  resolvedPath: string;
  targetIsEmpty: boolean;
  hasFreeSpace: boolean;
  estimatedSize: number;
  sameAsCurrentDir: boolean;
  invalidReason?: string;
}

export interface DataDirApplyResponse {
  ok: true;
  dataDir: string;
  pendingCleanup: string;
  restartScheduled: boolean;
}

export interface DataDirSwitchProjectSummary {
  projectId: ProjectId;
  title: string;
  updatedAt: string;
}

export interface DataDirSwitchPreview {
  resolvedPath: string;
  projectCount: number;
  projects: DataDirSwitchProjectSummary[];
  unreadableProjectIds: ProjectId[];
  hasCredentials: boolean;
  invalidReason?: string;
}

export interface DataDirSwitchResponse {
  ok: true;
  dataDir: string;
  previousDataDir: string;
  restartScheduled: boolean;
}

export interface DataDirSelectResponse {
  path: string | null;
}
