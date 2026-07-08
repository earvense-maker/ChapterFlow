import { useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import { GeneratingLabel } from './GeneratingLabel';
import type { DataDirInfo, DataDirPreview, RuntimeKind } from '@shared/types';

interface Props {
  onBack: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'previewing' }
  | { kind: 'applying'; text: string }
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string };

export default function AppSettingsPanel({ onBack }: Props) {
  const [info, setInfo] = useState<DataDirInfo | null>(null);
  const [runtime, setRuntime] = useState<RuntimeKind>('server');
  const [targetPath, setTargetPath] = useState('');
  const [preview, setPreview] = useState<DataDirPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const restartWatch = useRef<{ intervalId?: number; timeoutId?: number }>({});

  const canMoveDataDir = runtime === 'electron';
  const busy = status.kind === 'previewing' || status.kind === 'applying';

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setStatus({ kind: 'idle' });
        const [data, version] = await Promise.all([
          api.getDataDirInfo(),
          api.getSystemVersion(),
        ]);
        if (!cancelled) {
          setInfo(data);
          setRuntime(version.runtime);
          setTargetPath(data.current);
        }
      } catch (err) {
        if (!cancelled) {
          setStatus({
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
  }, []);

  async function copyCurrentPath() {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.current);
      setStatus({ kind: 'success', text: '保存先をコピーしました' });
      window.setTimeout(() => {
        setStatus((current) =>
          current.kind === 'success' && current.text === '保存先をコピーしました'
            ? { kind: 'idle' }
            : current
        );
      }, 2000);
    } catch {
      setStatus({ kind: 'error', text: 'コピーできませんでした' });
    }
  }

  async function handlePreview() {
    if (!canMoveDataDir) return;
    try {
      setStatus({ kind: 'previewing' });
      setPreview(await api.previewDataDirMove(targetPath));
      setStatus({ kind: 'idle' });
    } catch (err) {
      setPreview(null);
      setStatus({
        kind: 'error',
        text: err instanceof Error ? err.message : 'プレビューに失敗しました',
      });
    }
  }

  async function handleApply() {
    if (!canMoveDataDir || !preview || preview.invalidReason) return;
    if (!window.confirm('保存先を移動します。完了後、アプリを自動で再起動します。移動中はアプリを終了しないでください。')) return;
    try {
      clearRestartWatch();
      setStatus({
        kind: 'applying',
        text: 'コピーと検証を実行しています。アプリを終了しないでください。',
      });
      await api.applyDataDirMove(targetPath);
      setStatus({ kind: 'success', text: '移動が完了しました。アプリを再起動しています。' });
      watchRestart();
    } catch (err) {
      clearRestartWatch();
      setStatus({
        kind: 'error',
        text: err instanceof Error ? `移動に失敗しました: ${err.message}` : '移動に失敗しました',
      });
    }
  }

  function watchRestart() {
    restartWatch.current.timeoutId = window.setTimeout(() => {
      clearRestartWatch();
      setStatus({
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

  if (loading) return <div className="loading">読み込み中…</div>;

  return (
    <div className="settings-panel">
      <header className="reader-header">
        <button onClick={onBack} disabled={busy}>← 戻る</button>
        <h1>アプリ設定</h1>
      </header>

      {status.kind === 'error' && <div className="error-toast">{status.text}</div>}
      {(status.kind === 'success' || status.kind === 'applying') && (
        <div className="status-toast">
          {status.kind === 'applying' ? <GeneratingLabel text={status.text} /> : status.text}
        </div>
      )}

      <section className="settings-section">
        <h2>作品データの保存先</h2>
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
          <input
            type="text"
            value={targetPath}
            onChange={(e) => {
              setTargetPath(e.target.value);
              setPreview(null);
              if (status.kind !== 'applying') setStatus({ kind: 'idle' });
            }}
            placeholder="例: D:\Yumeweaving"
            disabled={busy || !canMoveDataDir}
          />
        </label>
        <div className="summary-card-actions">
          <button
            type="button"
            onClick={handlePreview}
            disabled={busy || !targetPath.trim() || !canMoveDataDir}
          >
            {status.kind === 'previewing' ? <GeneratingLabel text="確認中…" /> : 'プレビュー'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={handleApply}
            disabled={busy || !preview || Boolean(preview.invalidReason) || !canMoveDataDir}
          >
            {status.kind === 'applying' ? '再起動待ち' : 'この場所に移動する'}
          </button>
        </div>
      </section>

      {preview && (
        <section className="settings-section">
          <h2>移動プレビュー</h2>
          <dl className="data-dir-preview">
            <dt>実際の移動先</dt>
            <dd><code>{preview.resolvedPath}</code></dd>
            <dt>コピー対象</dt>
            <dd>{formatBytes(preview.estimatedSize)}</dd>
            <dt>選択フォルダ</dt>
            <dd>{preview.targetIsEmpty ? '空です' : '空ではないため Yumeweaving サブフォルダを使います'}</dd>
            <dt>空き容量</dt>
            <dd>{preview.hasFreeSpace ? '問題ありません' : '不足しています'}</dd>
          </dl>
          {preview.invalidReason ? (
            <div className="error-toast">{preview.invalidReason}</div>
          ) : (
            <div className="status-toast">この場所に移動できます。</div>
          )}
        </section>
      )}
    </div>
  );
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
