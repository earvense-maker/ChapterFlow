import { useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import { useConfirm } from './ConfirmDialog';
import { GeneratingLabel } from './GeneratingLabel';
import type { DataDirInfo, DataDirPreview, RuntimeKind, SystemVersionInfo } from '@shared/types';

type Status =
  | { kind: 'idle' }
  | { kind: 'previewing' }
  | { kind: 'applying'; text: string }
  | { kind: 'restarting'; text: string }
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string };

interface Props {
  systemVersion?: SystemVersionInfo | null;
  onBusyChange?: (busy: boolean) => void;
}

export default function DataDirSettingsSection({ systemVersion, onBusyChange }: Props) {
  const confirmAction = useConfirm();
  const [info, setInfo] = useState<DataDirInfo | null>(null);
  const [runtime, setRuntime] = useState<RuntimeKind>('server');
  const [targetPath, setTargetPath] = useState('');
  const [preview, setPreview] = useState<DataDirPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectingFolder, setSelectingFolder] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const restartWatch = useRef<{ intervalId?: number; timeoutId?: number }>({});
  const busyRef = useRef(false);
  const onBusyChangeRef = useRef(onBusyChange);

  const canMoveDataDir = runtime === 'electron';
  const busy = isBusyStatus(status);

  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  }, [onBusyChange]);

  useEffect(() => {
    return () => {
      if (busyRef.current) {
        busyRef.current = false;
        onBusyChangeRef.current?.(false);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setSectionStatus({ kind: 'idle' });
        const [data, version] = await Promise.all([
          api.getDataDirInfo(),
          systemVersion ? Promise.resolve(systemVersion) : api.getSystemVersion(),
        ]);
        if (!cancelled) {
          setInfo(data);
          setRuntime(version.runtime);
          setTargetPath(data.current);
        }
      } catch (err) {
        if (!cancelled) {
          setSectionStatus({
            kind: 'error',
            text: err instanceof Error ? err.message : '読み込みに失敗しました',
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      clearRestartWatch();
    };
  }, [systemVersion]);

  async function copyCurrentPath() {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.current);
      setSectionStatus({ kind: 'success', text: '保存先をコピーしました' });
      window.setTimeout(() => {
        setStatus((current) =>
          current.kind === 'success' && current.text === '保存先をコピーしました'
            ? { kind: 'idle' }
            : current
        );
      }, 2000);
    } catch {
      setSectionStatus({ kind: 'error', text: 'コピーできませんでした' });
    }
  }

  async function handleSelectFolder() {
    if (!canMoveDataDir) return;
    try {
      setSelectingFolder(true);
      setSectionStatus({ kind: 'idle' });
      const selected = await api.selectDataDirFolder(targetPath || info?.current);
      if (!selected.path) return;
      setTargetPath(selected.path);
      const nextPreview = await previewTarget(selected.path);
      setPreview(nextPreview);
    } catch (err) {
      setPreview(null);
      setSectionStatus({
        kind: 'error',
        text: err instanceof Error ? err.message : 'フォルダを選択できませんでした',
      });
    } finally {
      setSelectingFolder(false);
    }
  }

  async function previewTarget(path: string): Promise<DataDirPreview> {
    setSectionStatus({ kind: 'previewing' });
    const nextPreview = await api.previewDataDirMove(path);
    setSectionStatus({ kind: 'idle' });
    return nextPreview;
  }

  async function handlePreview() {
    if (!canMoveDataDir) return;
    try {
      setPreview(await previewTarget(targetPath));
    } catch (err) {
      setPreview(null);
      setSectionStatus({
        kind: 'error',
        text: err instanceof Error ? err.message : 'プレビューに失敗しました',
      });
    }
  }

  async function handleApply() {
    if (!canMoveDataDir) return;
    let applyPreview = preview;
    try {
      if (!applyPreview) {
        applyPreview = await previewTarget(targetPath);
        setPreview(applyPreview);
      }
    } catch (err) {
      setPreview(null);
      setSectionStatus({
        kind: 'error',
        text: err instanceof Error ? err.message : 'プレビューに失敗しました',
      });
      return;
    }
    if (!applyPreview || applyPreview.invalidReason) {
      setSectionStatus({
        kind: 'error',
        text: applyPreview?.invalidReason ?? '移動先を確認できませんでした',
      });
      return;
    }
    if (
      !(await confirmAction(
        '保存先を移動します。完了後、アプリを自動で再起動します。移動中はアプリを終了しないでください。',
        { confirmLabel: '移動して再起動' }
      ))
    ) return;
    try {
      clearRestartWatch();
      setSectionStatus({
        kind: 'applying',
        text: 'コピーと検証を実行しています。アプリを終了しないでください。',
      });
      await api.applyDataDirMove(targetPath);
      setSectionStatus({ kind: 'restarting', text: '移動が完了しました。アプリを再起動しています。' });
      watchRestart();
    } catch (err) {
      clearRestartWatch();
      setSectionStatus({
        kind: 'error',
        text: err instanceof Error ? `移動に失敗しました: ${err.message}` : '移動に失敗しました',
      });
    }
  }

  function watchRestart() {
    restartWatch.current.timeoutId = window.setTimeout(() => {
      clearRestartWatch();
      setSectionStatus({
        kind: 'error',
        text: '自動再起動が完了しませんでした。アプリを一度閉じて開き直してください。',
      });
    }, 15_000);

    restartWatch.current.intervalId = window.setInterval(async () => {
      try {
        await fetch('/api/system/version', { cache: 'no-store' });
      } catch {
        clearRestartWatch();
        window.location.reload();
      }
    }, 1000);
  }

  function clearRestartWatch() {
    if (restartWatch.current.intervalId) {
      window.clearInterval(restartWatch.current.intervalId);
    }
    if (restartWatch.current.timeoutId) {
      window.clearTimeout(restartWatch.current.timeoutId);
    }
    restartWatch.current = {};
  }

  function setSectionStatus(nextStatus: Status) {
    setStatus(nextStatus);
    const nextBusy = isBusyStatus(nextStatus);
    if (busyRef.current !== nextBusy) {
      busyRef.current = nextBusy;
      onBusyChangeRef.current?.(nextBusy);
    }
  }

  if (loading) return <div className="loading">読み込み中…</div>;

  return (
    <section className="settings-section">
      <h2>作品データの保存先</h2>
      {status.kind === 'error' && <div className="error-toast">{status.text}</div>}
      {(status.kind === 'success' || status.kind === 'applying' || status.kind === 'restarting') && (
        <div className="status-toast">
          {status.kind === 'applying' || status.kind === 'restarting'
            ? <GeneratingLabel text={status.text} />
            : status.text}
        </div>
      )}
      {!canMoveDataDir && (
        <div className="story-state-alert stale">
          <div>
            <strong>LAN モードでは変更できません</strong>
            <p>データ保存先の移動は Electron 版のアプリから実行してください。</p>
          </div>
        </div>
      )}
      {info && (
        <div className="data-dir-current">
          <div>
            <span className="settings-meta">
              現在の保存先{info.isUsingDefault ? ' (既定の場所)' : ''}
            </span>
            <code>{info.current}</code>
            {!info.isUsingDefault && <span className="settings-meta">既定: {info.defaultPath}</span>}
          </div>
          <button type="button" onClick={copyCurrentPath} disabled={busy}>
            コピー
          </button>
        </div>
      )}
      {info?.pendingCleanup && (
        <div className="story-state-alert stale">
          <div>
            <strong>旧データが残っています</strong>
            <p>次回起動時に再削除を試します。手動で削除する場合: {info.pendingCleanup}</p>
          </div>
        </div>
      )}
      <label>
        新しい保存先フォルダ
        <div className="data-dir-target-row">
          <input
            type="text"
            value={targetPath}
            onChange={(e) => {
              setTargetPath(e.target.value);
              setPreview(null);
              if (status.kind !== 'applying' && status.kind !== 'restarting') {
                setSectionStatus({ kind: 'idle' });
              }
            }}
            placeholder="例: D:\ChapterFlow"
            disabled={busy || selectingFolder || !canMoveDataDir}
          />
          <button
            type="button"
            onClick={handleSelectFolder}
            disabled={busy || selectingFolder || !canMoveDataDir}
          >
            {selectingFolder ? '参照中…' : '参照…'}
          </button>
        </div>
      </label>
      <div className="summary-card-actions">
        <button
          type="button"
          onClick={handlePreview}
          disabled={busy || selectingFolder || !targetPath.trim() || !canMoveDataDir}
        >
          {status.kind === 'previewing' ? <GeneratingLabel text="確認中…" /> : 'プレビュー'}
        </button>
        <button
          type="button"
          className="primary"
          onClick={handleApply}
          disabled={
            busy ||
            selectingFolder ||
            !targetPath.trim() ||
            Boolean(preview?.invalidReason) ||
            !canMoveDataDir
          }
        >
          {status.kind === 'applying' || status.kind === 'restarting' ? '再起動待ち' : 'この場所へ移動する'}
        </button>
      </div>

      {preview && (
        <div className="data-dir-preview-panel">
          <h3>移動プレビュー</h3>
          <dl className="data-dir-preview">
            <dt>実際の移動先</dt>
            <dd><code>{preview.resolvedPath}</code></dd>
            <dt>コピー対象</dt>
            <dd>{formatBytes(preview.estimatedSize)}</dd>
            <dt>選択フォルダ</dt>
            <dd>{preview.targetIsEmpty ? '空です' : '空ではないため ChapterFlow サブフォルダを使います'}</dd>
            <dt>空き容量</dt>
            <dd>{preview.hasFreeSpace ? '問題ありません' : '不足しています'}</dd>
          </dl>
          {preview.invalidReason ? (
            <div className="error-toast">{preview.invalidReason}</div>
          ) : (
            <div className="status-toast">この場所に移動できます。</div>
          )}
        </div>
      )}
    </section>
  );
}

function isBusyStatus(status: Status): boolean {
  return status.kind === 'previewing' || status.kind === 'applying' || status.kind === 'restarting';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(1)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} PB`;
}
