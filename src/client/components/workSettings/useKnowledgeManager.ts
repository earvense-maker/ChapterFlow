import { useState } from 'react';
import { api } from '../../clientApi';
import type { useConfirm } from '../ConfirmDialog';
import { decodeKnowledgeFile } from './knowledgeFile';
import type { KnowledgeListItem } from '@shared/types';

// NOTE: WorkSettingsTab から「資料タブ」の状態とハンドラを丸ごと切り出したカスタム
// フック。状態は依然として WorkSettingsTab の render 内で（同じ呼び出し順で）保持され、
// 呼び出し側は同名で分割代入するため JSX は無変更＝挙動は不変。共有の loading/onError/
// onFlashMessage/confirmAction は引数で受け取り、初期ロードは親の一括取得から
// setKnowledgeItems で流し込む。

interface KnowledgeManagerDeps {
  projectId: string;
  onError: (msg: string | null) => void;
  onFlashMessage: (msg: string) => void;
  setLoading: (value: boolean) => void;
  confirmAction: ReturnType<typeof useConfirm>;
}

export function useKnowledgeManager({
  projectId,
  onError,
  onFlashMessage,
  setLoading,
  confirmAction,
}: KnowledgeManagerDeps) {
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeListItem[]>([]);
  const [knowledgeExpandedId, setKnowledgeExpandedId] = useState<string | null>(null);
  const [knowledgeEditing, setKnowledgeEditing] = useState(false);
  const [knowledgeTitleDraft, setKnowledgeTitleDraft] = useState('');
  const [knowledgeContentDraft, setKnowledgeContentDraft] = useState('');
  const [knowledgeUploading, setKnowledgeUploading] = useState(false);

  async function refreshKnowledge() {
    try {
      setKnowledgeItems(await api.getKnowledge(projectId));
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の再読み込みに失敗しました');
    }
  }

  async function handleKnowledgeFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    if (selected.length === 0) return;
    try {
      setKnowledgeUploading(true);
      onError(null);
      let imported = 0;
      for (const file of selected) {
        const content = await decodeKnowledgeFile(file);
        await api.createKnowledge(projectId, { fileName: file.name, content });
        imported += 1;
      }
      await refreshKnowledge();
      onFlashMessage(`資料を${imported}件追加しました`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の追加に失敗しました');
      await refreshKnowledge();
    } finally {
      setKnowledgeUploading(false);
    }
  }

  async function handleToggleKnowledge(item: KnowledgeListItem) {
    try {
      setLoading(true);
      onError(null);
      await api.updateKnowledge(projectId, item.knowledgeId, { enabled: !item.enabled });
      await refreshKnowledge();
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の更新に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleMoveKnowledge(index: number, delta: -1 | 1) {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= knowledgeItems.length) return;
    const next = [...knowledgeItems];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    try {
      setLoading(true);
      onError(null);
      await api.reorderKnowledge(projectId, next.map((item) => item.knowledgeId));
      await refreshKnowledge();
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の並べ替えに失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleExpandKnowledge(item: KnowledgeListItem) {
    if (knowledgeExpandedId === item.knowledgeId) {
      setKnowledgeExpandedId(null);
      setKnowledgeEditing(false);
      return;
    }
    try {
      setLoading(true);
      onError(null);
      const result = await api.getKnowledgeContent(projectId, item.knowledgeId);
      setKnowledgeExpandedId(item.knowledgeId);
      setKnowledgeTitleDraft(result.meta.title);
      setKnowledgeContentDraft(result.content);
      setKnowledgeEditing(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料本文の読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveKnowledge(item: KnowledgeListItem) {
    try {
      setLoading(true);
      onError(null);
      await api.updateKnowledge(projectId, item.knowledgeId, {
        title: knowledgeTitleDraft,
        content: knowledgeContentDraft,
      });
      await refreshKnowledge();
      setKnowledgeEditing(false);
      onFlashMessage('資料を保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelKnowledgeEdit(item: KnowledgeListItem) {
    try {
      setLoading(true);
      onError(null);
      const result = await api.getKnowledgeContent(projectId, item.knowledgeId);
      setKnowledgeTitleDraft(result.meta.title);
      setKnowledgeContentDraft(result.content);
      setKnowledgeEditing(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料本文の再読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteKnowledge(item: KnowledgeListItem) {
    if (
      !(await confirmAction(`資料「${item.title}」を削除しますか？`, {
        confirmLabel: '削除',
        danger: true,
      }))
    ) return;
    try {
      setLoading(true);
      onError(null);
      await api.deleteKnowledge(projectId, item.knowledgeId);
      if (knowledgeExpandedId === item.knowledgeId) {
        setKnowledgeExpandedId(null);
        setKnowledgeEditing(false);
      }
      await refreshKnowledge();
      onFlashMessage('資料を削除しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の削除に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  const enabledKnowledgeChars = knowledgeItems
    .filter((item) => item.enabled && item.contentStatus === 'ok')
    .reduce((sum, item) => sum + item.charCount, 0);
  const brokenEnabledKnowledgeCount = knowledgeItems.filter(
    (item) => item.enabled && item.contentStatus !== 'ok'
  ).length;

  return {
    knowledgeItems,
    setKnowledgeItems,
    knowledgeExpandedId,
    knowledgeEditing,
    setKnowledgeEditing,
    knowledgeTitleDraft,
    setKnowledgeTitleDraft,
    knowledgeContentDraft,
    setKnowledgeContentDraft,
    knowledgeUploading,
    handleKnowledgeFiles,
    handleToggleKnowledge,
    handleMoveKnowledge,
    handleExpandKnowledge,
    handleSaveKnowledge,
    handleCancelKnowledgeEdit,
    handleDeleteKnowledge,
    enabledKnowledgeChars,
    brokenEnabledKnowledgeCount,
  };
}
