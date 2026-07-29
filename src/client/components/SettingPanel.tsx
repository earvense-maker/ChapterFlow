import { useCallback, useEffect, useState } from 'react';
import { api } from '../clientApi';
import { countUnhandledRefineFindings } from '@shared/refineFinding';
import type {
  Project,
  RefineConsultationTarget,
  RefineFindingTarget,
  RefineReviewStatus,
  RefineScanResult,
  RefineSession,
  SettingsFocusTarget,
} from '@shared/types';
import WorkSettingsTab, { type DetailSettingsTab } from './WorkSettingsTab';
import AIConsultationTab from './AIConsultationTab';
import TechSettingsTab from './TechSettingsTab';
import MemoryEditor from './MemoryEditor';

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenAppSettings: (provider?: string) => void;
  initialTab?: Tab;
  // NOTE: 通知クリックで AI相談の該当 run / patch / finding へ飛ぶための遷移先。
  // 設定されている間は ai タブを強制する。
  focusTarget?: SettingsFocusTarget | null;
  onFocusTargetConsumed?: () => void;
}

// NOTE: 作品ページ内から開いた場合の設定。直接編集（作品設定）と AI相談を目的別に
// 分ける。走査結果・相談チャット・自動レビューはすべて AI相談タブ側に集約する。
type Tab = 'work' | 'ai' | 'memory' | 'tech';

export default function SettingPanel({
  projectId,
  onBack,
  onOpenAppSettings,
  initialTab,
  focusTarget,
  onFocusTargetConsumed,
}: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>(focusTarget ? 'ai' : initialTab ?? 'work');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // NOTE: 走査結果は AI相談タブ、未処理件数バッジはタブ列、判断（disposition）は
  // session の中にある。3つとも SettingPanel が持たないとバッジが両タブで食い違う。
  const [refineScan, setRefineScan] = useState<RefineScanResult | null>(null);
  const [refineSession, setRefineSession] = useState<RefineSession | null>(null);
  const [refineReviewStatus, setRefineReviewStatus] = useState<RefineReviewStatus | null>(null);
  const [pendingConsultTarget, setPendingConsultTarget] =
    useState<RefineConsultationTarget | null>(null);
  const [workDetailFocus, setWorkDetailFocus] = useState<DetailSettingsTab | null>(null);

  useEffect(() => {
    if (focusTarget) setTab('ai');
  }, [focusTarget]);

  useEffect(() => {
    let cancelled = false;
    api
      .getProject(projectId)
      .then((data) => {
        if (!cancelled) setProject(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '読み込みに失敗しました');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    // NOTE: どれもモデルを呼ばない読み取り。走査（課金）は AI相談タブの明示ボタンだけ。
    async function loadRefineState() {
      const [scan, session, status] = await Promise.all([
        api.getRefineScan(projectId).catch(() => null),
        api.getRefineSession(projectId).catch(() => null),
        api.getRefineReviewStatus(projectId).catch(() => null),
      ]);
      if (cancelled) return;
      setRefineScan(scan);
      setRefineSession(session);
      setRefineReviewStatus(status);
    }
    void loadRefineState();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const refreshRefineReviewStatus = useCallback(() => {
    api
      .getRefineReviewStatus(projectId)
      .then(setRefineReviewStatus)
      .catch(() => setRefineReviewStatus(null));
  }, [projectId]);

  function flashMessage(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 5000);
  }

  function showError(text: string | null) {
    setError(text);
  }

  function handleConsultRequest(target: RefineConsultationTarget) {
    // NOTE: 移動するだけ。メッセージは送らないので API 料金は発生しない。
    setPendingConsultTarget(target);
    setTab('ai');
  }

  function handleEditInWorkSettings(target: RefineFindingTarget) {
    setWorkDetailFocus(
      target.kind === 'character' ? 'characters' : target.kind === 'world' ? 'world' : 'basic'
    );
    setTab('work');
  }

  const unhandledFindingCount = countUnhandledRefineFindings(
    refineScan,
    refineSession?.consultationState?.findingDispositions ?? []
  );

  if (!project && !error) return <div className="loading">読み込み中…</div>;

  return (
    // NOTE: AI相談は「会話 + 右の気づき」の2カラム。既定の 800px 幅だと右列を引いた
    // 会話が 400px 弱になり、複数案の読み比べができない。このタブだけ枠を広げる。
    <div className={tab === 'ai' ? 'settings-panel settings-panel--wide' : 'settings-panel'}>
      <header className="reader-header">
        <button onClick={onBack}>← 戻る</button>
        <h1>作品設定{project ? `: ${project.title}` : ''}</h1>
      </header>

      <nav className="settings-tabs" role="tablist" aria-label="設定タブ">
        <button
          role="tab"
          aria-selected={tab === 'work'}
          className={tab === 'work' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setTab('work')}
        >
          作品設定
        </button>
        <button
          role="tab"
          aria-selected={tab === 'ai'}
          className={tab === 'ai' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setTab('ai')}
          // NOTE: 件数を色や数字だけで伝えない。読み上げ名にも件数を含める。
          aria-label={
            unhandledFindingCount > 0
              ? `AI相談 未確認の気づき${unhandledFindingCount}件`
              : 'AI相談'
          }
        >
          AI相談
          {unhandledFindingCount > 0 && (
            <span className="settings-tab-badge">{unhandledFindingCount}</span>
          )}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'memory'}
          className={tab === 'memory' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setTab('memory')}
        >
          記憶
        </button>
        <button
          role="tab"
          aria-selected={tab === 'tech'}
          className={tab === 'tech' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setTab('tech')}
        >
          生成設定
        </button>
      </nav>

      {error && <div className="error-toast">{error}</div>}
      {message && <div className="status-bar">{message}</div>}

      {project && tab === 'work' && (
        <WorkSettingsTab
          projectId={projectId}
          project={project}
          onError={showError}
          onFlashMessage={flashMessage}
          onProjectUpdated={setProject}
          onConsultRequest={handleConsultRequest}
          onRefineInputChanged={refreshRefineReviewStatus}
          focusDetailTab={workDetailFocus}
          onFocusDetailTabConsumed={() => setWorkDetailFocus(null)}
        />
      )}
      {project && tab === 'ai' && (
        <AIConsultationTab
          projectId={projectId}
          project={project}
          session={refineSession}
          onSessionChanged={setRefineSession}
          refineScan={refineScan}
          onRefineScanChanged={setRefineScan}
          reviewStatus={refineReviewStatus}
          onReviewStatusRefresh={refreshRefineReviewStatus}
          pendingTarget={pendingConsultTarget}
          onPendingTargetConsumed={() => setPendingConsultTarget(null)}
          focusTarget={focusTarget}
          onFocusTargetConsumed={onFocusTargetConsumed}
          onSettingsChanged={refreshRefineReviewStatus}
          onEditInWorkSettings={handleEditInWorkSettings}
          onError={showError}
          onFlashMessage={flashMessage}
        />
      )}
      {project && tab === 'tech' && (
        <TechSettingsTab
          projectId={projectId}
          project={project}
          onProjectUpdated={setProject}
          onError={showError}
          onFlashMessage={flashMessage}
          onOpenAppSettings={onOpenAppSettings}
        />
      )}
      {project && tab === 'memory' && <MemoryEditor projectId={projectId} />}
    </div>
  );
}
