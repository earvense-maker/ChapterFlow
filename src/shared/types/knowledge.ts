import type { KnowledgeId } from './ids.js';

export type KnowledgeExtension = 'md' | 'txt';
export type KnowledgeContentStatus = 'ok' | 'missing' | 'empty';

export interface KnowledgeFile {
  knowledgeId: KnowledgeId;
  title: string;
  originalFileName: string;
  extension: KnowledgeExtension;
  enabled: boolean;
  order: number;
  charCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeIndexFile {
  schemaVersion: 1;
  files: KnowledgeFile[];
}

export type KnowledgeListItem = KnowledgeFile & {
  contentStatus: KnowledgeContentStatus;
};

export interface CreateKnowledgeBody {
  fileName: string;
  content: string;
}

export interface UpdateKnowledgeBody {
  title?: string;
  content?: string;
  enabled?: boolean;
  order?: number;
}

export interface KnowledgeContentResponse {
  meta: KnowledgeFile;
  content: string;
}
