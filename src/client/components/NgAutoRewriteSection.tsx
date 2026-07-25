import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import {
  NG_AUTO_REWRITE_MAX_LIMIT,
  NG_AUTO_REWRITE_MIN_LIMIT,
  type NgAutoRewriteSettings,
} from '@shared/types';

interface Props {
  onError: (msg: string | null) => void;
  onFlashMessage: (msg: string) => void;
  // NOTE: アプリ全体設定なので、作品の設定タブに置くときだけ、どこから変えても
  // 同じ値であることを補足する（生成通知の節と同じ扱い）。
  scopeNote?: string;
  disabled?: boolean;
}

export default function NgAutoRewriteSection({
  onError,
  onFlashMessage,
  scopeNote,
  disabled,
}: Props) {
  const [settings, setSettings] = useState<NgAutoRewriteSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getNgAutoRewriteSettings()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch((err) => {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : '自動書き換え設定の読み込みに失敗しました');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // NOTE: onError は呼び出し側で毎レンダー再生成される想定なので依存に入れない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(next: NgAutoRewriteSettings) {
    // NOTE: 失敗したら表示を元に戻す。ここを楽観更新のままにすると、保存できて
    // いないのに「有効」と表示され、自動で直っていると誤解したまま生成が進む。
    const previous = settings;
    setSettings(next);
    try {
      setSaving(true);
      onError(null);
      const saved = await api.updateNgAutoRewriteSettings(next);
      setSettings(saved);
      onFlashMessage('自動書き換えの設定を保存しました');
    } catch (err) {
      setSettings(previous);
      onError(err instanceof Error ? err.message : '自動書き換え設定の保存に失敗しました');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="loading">自動書き換え設定を読み込み中…</div>;
  if (!settings) {
    return (
      <p className="settings-help">
        自動書き換えの設定を読み込めませんでした。画面を再読み込みしてください。
      </p>
    );
  }

  const busy = saving || disabled === true;

  return (
    <div className="ng-auto-rewrite">
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void save({ ...settings, enabled: e.target.checked })}
          disabled={busy}
        />
        <span>生成のたびに自動で書き換える</span>
      </label>
      <p className="settings-help">
        生成が終わったら、見つかったNG表現を古い順に1件ずつ書き換えます。1件につきその一文だけをモデルに投げ直すので、本文全体は作り直しません。書き換えられなかった箇所はハイライトのまま残るので、あとから手で直せます。
      </p>
      <label>
        1回の生成で書き換える上限
        <input
          type="number"
          min={NG_AUTO_REWRITE_MIN_LIMIT}
          max={NG_AUTO_REWRITE_MAX_LIMIT}
          value={settings.maxRewritesPerGeneration}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (!Number.isFinite(value)) return;
            void save({
              ...settings,
              maxRewritesPerGeneration: Math.min(
                NG_AUTO_REWRITE_MAX_LIMIT,
                Math.max(NG_AUTO_REWRITE_MIN_LIMIT, Math.floor(value))
              ),
            });
          }}
          disabled={busy || !settings.enabled}
        />
      </label>
      <p className="settings-help">
        {/* NOTE: 上限がそのまま1回の生成あたりの追加モデル呼び出し回数の上限になる。
            トークン消費の見積もりが立つよう、意味を明示しておく。 */}
        この件数がそのまま、1回の生成で余分に走るモデル呼び出しの上限になります（{NG_AUTO_REWRITE_MIN_LIMIT}〜
        {NG_AUTO_REWRITE_MAX_LIMIT}）。
      </p>
      {scopeNote && <p className="settings-help">{scopeNote}</p>}
    </div>
  );
}
