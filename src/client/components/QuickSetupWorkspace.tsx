import { useState } from 'react';
import { api } from '../clientApi';
import { rememberSetupSession } from './setupWorkspace/sessionStorage';
import type {
  ExperienceMode,
  QuickContractCandidate,
  SetupCommitPlan,
  SetupPurpose,
  SetupSession,
} from '@shared/types';

// NOTE: クイックセットアップ画面（設計書 4.1）。一文の自由記述から最小計画を作り、
// hard候補の確認カード → commit の流れで作品を作る。詳細設定は既存の相談画面へ逃げる。
// experienceMode（妄想増幅器）はセッションへ保持し、詳細設定へ移っても失わない（設計書 4.1）。
interface Props {
  purpose: SetupPurpose;
  experienceMode?: ExperienceMode;
  onCreated: (projectId: string, projectType: SetupPurpose) => void;
  onCancel: () => void;
  onOpenFullSetup: () => void;
}

export default function QuickSetupWorkspace({
  purpose,
  experienceMode = 'standard',
  onCreated,
  onCancel,
  onOpenFullSetup,
}: Props) {
  const [wish, setWish] = useState('');
  const [hardContracts, setHardContracts] = useState('');
  const [openingWish, setOpeningWish] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SetupSession | null>(null);
  const [plan, setPlan] = useState<SetupCommitPlan | null>(null);
  const [confirmations, setConfirmations] = useState<Map<string, boolean>>(new Map());

  const copy =
    experienceMode === 'dream'
      ? DREAM_COPY
      : purpose === 'roleplay'
        ? ROLEPLAY_COPY
        : NOVEL_COPY;

  const start = async () => {
    if (!wish.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSetupSession({
        purpose,
        setupMode: 'quick',
        ...(experienceMode !== 'standard' ? { experienceMode } : {}),
      });
      // 詳細設定へ移るときは、このクイック設定セッションを復元する。
      // NOTE: amplifier は専用の復元キーへ保存する（設計書 4.1）。standard 用キーへ保存
      // すると、通常作品の相談として誤復元される。
      rememberSetupSession(created.sessionId, purpose, experienceMode);
      const result = await api.createQuickSetupPlan(created.sessionId, {
        wish: wish.trim(),
        hardContracts: hardContracts
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 8),
        openingWish: openingWish.trim() || undefined,
        revision: created.session.revision,
      });
      setSession(result.session);
      setPlan(result.plan);
      setConfirmations(
        new Map(
          (result.session.draft.quickContracts ?? [])
            .filter((item) => item.status === 'active' && item.strength === 'hard')
            .map((item) => [item.id, item.source === 'user'])
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '計画の作成に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const confirmAndCommit = async () => {
    if (!session || !plan || busy) return;
    setBusy(true);
    setError(null);
    try {
      const confirmedItems = [...confirmations.entries()]
        .filter(([, confirmed]) => confirmed)
        .map(([id]) => ({ id, confirmed: true }));
      const unconfirmedItems = [...confirmations.entries()]
        .filter(([, confirmed]) => !confirmed)
        .map(([id]) => ({ id, confirmed: false }));
      const result = await api.confirmQuickContracts(session.sessionId, {
        items: [...confirmedItems, ...unconfirmedItems],
        revision: session.revision,
      });
      const committed = await api.commitSetup(result.session.sessionId, {
        plan: result.plan,
        revision: result.session.revision,
      });
      onCreated(committed.projectId, purpose);
    } catch (err) {
      setError(err instanceof Error ? err.message : '作品の作成に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const hardCandidates: QuickContractCandidate[] =
    session?.draft.quickContracts?.filter(
      (item) => item.status === 'active' && item.strength === 'hard'
    ) ?? [];

  const softCandidates: QuickContractCandidate[] =
    session?.draft.quickContracts?.filter(
      (item) => item.status === 'active' && item.strength === 'soft'
    ) ?? [];

  return (
    <div className="setup-workspace quick-setup-workspace">
      <header className="setup-header">
        <div>
          <h2>{copy.heading}</h2>
          <p className="setup-description">{copy.description}</p>
        </div>
        <div className="project-list-actions">
          <button onClick={onCancel}>キャンセル</button>
          <button onClick={onOpenFullSetup}>詳細を自分で決める</button>
        </div>
      </header>

      {error && <div className="error-toast">{error}</div>}

      {!plan && (
        <form
          className="quick-setup-form"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <label className="quick-field">
            <span>{copy.wishLabel}</span>
            <textarea
              value={wish}
              onChange={(e) => setWish(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder={copy.wishPlaceholder}
              required
            />
          </label>
          <label className="quick-field">
            <span>絶対に守ってほしいこと（任意・1行に1つ）</span>
            <textarea
              value={hardContracts}
              onChange={(e) => setHardContracts(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder={'例: 護衛は最後まで裏切らない'}
            />
          </label>
          <label className="quick-field">
            <span>{copy.openingLabel}（任意）</span>
            <input
              type="text"
              value={openingWish}
              onChange={(e) => setOpeningWish(e.target.value)}
              maxLength={300}
              placeholder={copy.openingPlaceholder}
            />
          </label>
          <div className="quick-setup-actions">
            <button type="submit" className="primary" disabled={busy || !wish.trim()}>
              {busy ? '作成中…' : copy.submitLabel}
            </button>
          </div>
        </form>
      )}

      {plan && session && (
        <div className="quick-setup-confirm">
          <section className="summary-card detail-settings-card">
            <header className="summary-card-header">
              <h3>作品の約束（確認）</h3>
              <span className="settings-meta">
                強く守る約束は、確認したものだけが hard 契約になります。
              </span>
            </header>
            {hardCandidates.length === 0 ? (
              <p className="summary-field-missing">hard候補はありませんでした。</p>
            ) : (
              <ul className="contract-item-list">
                {hardCandidates.map((item) => (
                  <li key={item.id} className="contract-item">
                    <label className="quick-confirm-row">
                      <input
                        type="checkbox"
                        checked={confirmations.get(item.id) ?? false}
                        onChange={(e) =>
                          setConfirmations((current) =>
                            new Map(current).set(item.id, e.target.checked)
                          )
                        }
                      />
                      <span className="contract-text">{item.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {softCandidates.length > 0 && (
              <>
                <header className="summary-card-header">
                  <h4>好み（soft・確認不要）</h4>
                </header>
                <ul className="contract-item-list">
                  {softCandidates.map((item) => (
                    <li key={item.id} className="contract-item">
                      <span className="contract-strength soft">好み</span>
                      <span className="contract-text">{item.text}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(plan.world.foundation || plan.world.initialSituation) && (
              <>
                <header className="summary-card-header">
                  <h4>世界観</h4>
                </header>
                <ul className="contract-item-list">
                  {plan.world.foundation && (
                    <li className="contract-item">
                      <span className="contract-strength soft">世界の土台</span>
                      <span className="contract-text">{plan.world.foundation}</span>
                    </li>
                  )}
                  {plan.world.initialSituation && (
                    <li className="contract-item">
                      <span className="contract-strength soft">開始時点</span>
                      <span className="contract-text">{plan.world.initialSituation}</span>
                    </li>
                  )}
                </ul>
              </>
            )}
            {purpose === 'novel' && (
              <p className="canon-note">
                未公開設定は {plan.latentCanonItems?.length ?? 0} 件用意しました
                {plan.latentSeedStatus === 'failed' ? '（準備できませんでした。進行中に補完します）' : ''}。
                本文で明らかになるまで設定画面では隠されます。
              </p>
            )}
            <div className="quick-setup-actions">
              <button className="primary" onClick={() => void confirmAndCommit()} disabled={busy}>
                {busy ? '作成中…' : copy.commitLabel}
              </button>
              <button onClick={() => void start()} disabled={busy}>
                作り直す
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

const NOVEL_COPY = {
  heading: '一文から物語を始める',
  description: '見たい作品を一文で書いてください。アプリが最低限の設定を補完します。',
  wishLabel: '見たい作品・関係・感情',
  wishPlaceholder: '例: 人を信じられない魔女と寡黙な護衛が、雨の夜に逃げる話。時間をかけて信頼が育ってほしい。',
  openingLabel: '最初に見たい場面',
  openingPlaceholder: '例: 雨の宿で二人がはじめて言葉を交わす場面',
  submitLabel: 'この一文で作品を作る',
  commitLabel: 'この内容で作品を作る',
};

const ROLEPLAY_COPY = {
  heading: '一文からキャラとの会話を始める',
  description: '会話したい相手と世界を一文で書いてください。',
  wishLabel: '見たいキャラクター・関係・雰囲気',
  wishPlaceholder: '例: 人を信じられない魔女。寡黙な護衛に少しずつ心を開いていく話。',
  openingLabel: '最初の会話の舞台',
  openingPlaceholder: '例: 雨の夜の宿屋の暖炉の前',
  submitLabel: 'この一文で作品を作る',
  commitLabel: 'この内容で作品を作る',
};

// NOTE: 夢見るモードの最小文言（設計書 §9）。見出しとプレースホルダーだけを変え、詳細
// 設定全体の語彙変更は MVP 外とする。
const DREAM_COPY = {
  heading: '夢の入り口を作る',
  description:
    'どんな夢の入り口が欲しいですか？一文で書いてください。言葉はそのまま保存され、未来の夢の奥で形を変えて戻ってきます。',
  wishLabel: 'どんな夢の入り口が欲しいですか',
  wishPlaceholder: '例: 雨の降る街で、行き先の決まらない足音を追う夢。',
  openingLabel: '最初に見たい情景',
  openingPlaceholder: '例: 夜の海岸。遠くの灯りがひとつずつ消えていく。',
  submitLabel: 'この一文で夢を作る',
  commitLabel: 'この内容で夢を作る',
};
