import { useState } from 'react';
import { api } from '../../clientApi';
import type { useConfirm } from '../ConfirmDialog';
import { summarizeStoryStateReduction } from './workSettingsHelpers';
import type { StoryState, StoryStateDiffRecord } from '@shared/types';

// NOTE: WorkSettingsTab から「物語状態タブ」の状態とハンドラを切り出したカスタムフック。
// 状態は親の render 内で同順に保持され、呼び出し側は同名で分割代入するため JSX は無変更。
// 走査レビュー状態の再取得（複数タブ共通）は refreshRefineReviewStatus として受け取る。

interface StoryStatePanelDeps {
  projectId: string;
  onError: (msg: string | null) => void;
  onFlashMessage: (msg: string) => void;
  setLoading: (value: boolean) => void;
  confirmAction: ReturnType<typeof useConfirm>;
  refreshRefineReviewStatus: () => Promise<void>;
}

export function useStoryStatePanel({
  projectId,
  onError,
  onFlashMessage,
  setLoading,
  confirmAction,
  refreshRefineReviewStatus,
}: StoryStatePanelDeps) {
  const [storyState, setStoryState] = useState<StoryState | null>(null);
  const [storyStateDraft, setStoryStateDraft] = useState('');
  const [storyStateEditing, setStoryStateEditing] = useState(false);
  const [storyStateDiffs, setStoryStateDiffs] = useState<StoryStateDiffRecord[]>([]);

  async function handleSaveStoryState() {
    try {
      onError(null);
      let parsed: StoryState;
      try {
        parsed = JSON.parse(storyStateDraft) as StoryState;
      } catch (parseErr) {
        onError(parseErr instanceof Error ? `JSON構文エラー: ${parseErr.message}` : 'JSON構文エラー');
        return;
      }
      // NOTE: JSON生編集の事故予防。主要配列が減っていたら明示 confirm。
      // 増加や維持は素通し、減少幅と種別を並べて表示する。
      const reduction = storyState ? summarizeStoryStateReduction(storyState, parsed) : [];
      if (reduction.length > 0) {
        const message = [
          '以下の項目が減っています。保存すると復元は差分履歴からのみ可能です。',
          '',
          ...reduction.map((line) => `・${line}`),
          '',
          '本当に保存しますか？',
        ].join('\n');
        if (!(await confirmAction(message, { confirmLabel: '保存', danger: true }))) return;
      }
      setLoading(true);
      const saved = await api.updateStoryState(projectId, parsed);
      setStoryState(saved);
      setStoryStateDraft(JSON.stringify(saved, null, 2));
      setStoryStateEditing(false);
      void refreshRefineReviewStatus();
      onFlashMessage('物語状態を保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleRevertStoryDiff(diffId: string) {
    try {
      setLoading(true);
      onError(null);
      const result = await api.revertStoryStateDiff(projectId, diffId);
      const diffs = await api.getStoryStateDiffs(projectId);
      setStoryState(result.storyState);
      setStoryStateDraft(JSON.stringify(result.storyState, null, 2));
      setStoryStateDiffs(diffs);
      void refreshRefineReviewStatus();
      onFlashMessage('自動更新を取り消しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '取り消しに失敗しました');
    } finally {
      setLoading(false);
    }
  }

  return {
    storyState,
    setStoryState,
    storyStateDraft,
    setStoryStateDraft,
    storyStateEditing,
    setStoryStateEditing,
    storyStateDiffs,
    setStoryStateDiffs,
    handleSaveStoryState,
    handleRevertStoryDiff,
  };
}
