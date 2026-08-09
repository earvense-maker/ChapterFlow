import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../clientApi';
import type {
  CanonSummaryResponse,
  CreativeContract,
  CreativeContractItem,
  CreativeContractItemInput,
  LatentCanonItem,
} from '@shared/types';

// NOTE: 作品設定の先頭に置く「作品の約束 / 公開済みの設定 / 未公開設定 / 要確認」
// カード群（設計書 4.2・4.3）。shielded時は未公開本文を取得しない。
interface Props {
  projectId: string;
  onError: (msg: string | null) => void;
  onFlashMessage: (msg: string) => void;
}

type ConflictStatus = 'resolved' | 'exception-accepted' | 'dismissed';

function isRevisionConflict(err: unknown, code: 'contract_revision_conflict' | 'canon_revision_conflict') {
  return err instanceof ApiError && err.status === 409 && err.body?.code === code;
}

const CONTRACT_ITEM_FIELDS = ['kind', 'strength', 'text', 'source', 'status'] as const;

function generateContractId(): string {
  return `ctr-${globalThis.crypto.randomUUID()}`;
}

interface ContractDraftRebaseInput {
  baseItems: CreativeContractItemInput[];
  draftItems: CreativeContractItemInput[];
  latestItems: CreativeContractItemInput[];
  baseMode: 'strict' | 'fast';
  draftMode: 'strict' | 'fast';
  latestMode: 'strict' | 'fast';
}

export function reapplyContractDraft(input: ContractDraftRebaseInput): {
  items: CreativeContractItemInput[];
  verificationMode: 'strict' | 'fast';
  hasConflicts: boolean;
} {
  const baseById = new Map(input.baseItems.map((item) => [item.contractId, item]));
  const draftById = new Map(input.draftItems.map((item) => [item.contractId, item]));
  const latestIds = new Set(input.latestItems.map((item) => item.contractId));
  let hasConflicts = false;

  const items = input.latestItems.flatMap((latestItem) => {
    const baseItem = baseById.get(latestItem.contractId);
    const draftItem = draftById.get(latestItem.contractId);
    if (!baseItem) return [{ ...latestItem }];

    // 利用者が削除した項目は、他画面で未変更なら削除を引き継ぐ。並行変更済みなら
    // 最新値を残して、利用者に確認させる。
    if (!draftItem) {
      const changedElsewhere = CONTRACT_ITEM_FIELDS.some(
        (field) => latestItem[field] !== baseItem[field]
      );
      if (changedElsewhere) {
        hasConflicts = true;
        return [{ ...latestItem }];
      }
      return [];
    }

    let rebasedItem: CreativeContractItemInput = { ...latestItem };
    for (const field of CONTRACT_ITEM_FIELDS) {
      const changedByUser = draftItem[field] !== baseItem[field];
      const changedElsewhere = latestItem[field] !== baseItem[field];
      if (changedByUser && changedElsewhere && draftItem[field] !== latestItem[field]) {
        hasConflicts = true;
        continue;
      }
      if (changedByUser && !changedElsewhere) {
        rebasedItem = { ...rebasedItem, [field]: draftItem[field] } as CreativeContractItemInput;
      }
    }
    return [rebasedItem];
  });

  // 基準版に無かった利用者追加項目は、同じIDが既に無い場合だけ末尾へ加える。
  for (const draftItem of input.draftItems) {
    if (!baseById.has(draftItem.contractId) && !latestIds.has(draftItem.contractId)) {
      items.push({ ...draftItem });
    }
  }

  // 最新版から消えた基準版項目を利用者が編集していた場合、削除を勝手に覆さず
  // 明示確認へ回す。利用者側も削除していれば同じ削除なので競合にはしない。
  for (const baseItem of input.baseItems) {
    if (latestIds.has(baseItem.contractId)) continue;
    const draftItem = draftById.get(baseItem.contractId);
    if (
      draftItem &&
      CONTRACT_ITEM_FIELDS.some((field) => draftItem[field] !== baseItem[field])
    ) {
      hasConflicts = true;
    }
  }

  const changedModeByUser = input.draftMode !== input.baseMode;
  const changedModeElsewhere = input.latestMode !== input.baseMode;
  const modeConflict =
    changedModeByUser && changedModeElsewhere && input.draftMode !== input.latestMode;
  return {
    items,
    verificationMode: changedModeByUser && !changedModeElsewhere ? input.draftMode : input.latestMode,
    hasConflicts: hasConflicts || modeConflict,
  };
}

export default function CanonSettingsSection({ projectId, onError, onFlashMessage }: Props) {
  const [contract, setContract] = useState<CreativeContract | null>(null);
  const [canon, setCanon] = useState<CanonSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingContract, setEditingContract] = useState(false);
  const [draftItems, setDraftItems] = useState<CreativeContractItemInput[]>([]);
  const [draftMode, setDraftMode] = useState<'strict' | 'fast'>('strict');
  const [editingBaseItems, setEditingBaseItems] = useState<CreativeContractItemInput[]>([]);
  const [editingBaseMode, setEditingBaseMode] = useState<'strict' | 'fast'>('strict');
  const [openedHidden, setOpenedHidden] = useState(false);
  const [revealedItems, setRevealedItems] = useState<Map<string, LatentCanonItem>>(new Map());
  const [expandedConflictId, setExpandedConflictId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextContract, nextCanon] = await Promise.all([
        api.getCreativeContract(projectId),
        api.getCanonSummary(projectId),
      ]);
      setContract(nextContract);
      setCanon(nextCanon);
      setDraftMode(nextContract.verificationMode);
    } catch (err) {
      onError(err instanceof Error ? err.message : '設定の読み込みに失敗しました。');
    } finally {
      setLoading(false);
    }
  }, [projectId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const beginEdit = () => {
    if (!contract) return;
    const items = contract.items.map((item) => ({
        contractId: item.contractId,
        kind: item.kind,
        strength: item.strength,
        text: item.text,
        source: item.source,
        status: item.status,
      }));
    setDraftItems(items);
    setDraftMode(contract.verificationMode);
    setEditingBaseItems(items);
    setEditingBaseMode(contract.verificationMode);
    setEditingContract(true);
  };

  const saveContract = async (
    confirmConflictFingerprint?: string,
    revision = contract?.revision,
    hasRetried = false,
    items = draftItems,
    verificationMode = draftMode,
    baseItems = editingBaseItems,
    baseMode = editingBaseMode
  ) => {
    if (!contract || revision === undefined) return;
    try {
      const saved = await api.updateCreativeContract(projectId, {
        revision,
        items,
        verificationMode,
        ...(confirmConflictFingerprint
          ? { confirmConflictFingerprint }
          : {}),
      });
      setContract(saved);
      setEditingContract(false);
      onFlashMessage('作品の約束を保存しました。');
      void load();
    } catch (err) {
      if (!hasRetried && isRevisionConflict(err, 'contract_revision_conflict')) {
        const latest = await api.getCreativeContract(projectId).catch((refreshErr) => {
          onError(refreshErr instanceof Error ? refreshErr.message : '作品の約束を再取得できませんでした。');
          return null;
        });
        if (latest) {
          setContract(latest);
          const rebased = reapplyContractDraft({
            baseItems,
            draftItems: items,
            latestItems: latest.items,
            baseMode,
            draftMode: verificationMode,
            latestMode: latest.verificationMode,
          });
          setDraftItems(rebased.items);
          setDraftMode(rebased.verificationMode);
          setEditingBaseItems(
            latest.items.map((item) => ({
              contractId: item.contractId,
              kind: item.kind,
              strength: item.strength,
              text: item.text,
              source: item.source,
              status: item.status,
            }))
          );
          setEditingBaseMode(latest.verificationMode);
          if (rebased.hasConflicts) {
            onError('作品の約束が別の画面で変更されました。競合する項目は最新値に更新したので、内容を確認して保存してください。');
            return;
          }
          await saveContract(
            confirmConflictFingerprint,
            latest.revision,
            true,
            rebased.items,
            rebased.verificationMode,
            latest.items,
            latest.verificationMode
          );
        }
        return;
      }
      if (err instanceof ApiError && err.status === 409 && err.body?.code === 'contract_conflict') {
        const conflicts = Array.isArray(err.body.conflicts)
          ? (err.body.conflicts as Array<{ contractIds: string[]; reason: string }>)
          : [];
        const fingerprint =
          typeof err.body.conflictFingerprint === 'string'
            ? err.body.conflictFingerprint
            : undefined;
        const confirmed = window.confirm(
          '強く守る約束の間に、意味的に両立しない組み合わせが見つかりました。\n\n' +
            conflicts.map((conflict) => `・${conflict.reason}`).join('\n') +
            '\n\nこの内容を承知して保存しますか？'
        );
        if (confirmed && fingerprint) {
          await saveContract(
            fingerprint,
            revision,
            hasRetried,
            items,
            verificationMode,
            baseItems,
            baseMode
          );
        }
        return;
      }
      onError(err instanceof Error ? err.message : '作品の約束の保存に失敗しました。');
    }
  };

  const retryCanonMutation = async <T,>(
    mutate: (revision: number) => Promise<T>
  ): Promise<T | null> => {
    if (!canon) return null;
    try {
      return await mutate(canon.revision);
    } catch (err) {
      if (!isRevisionConflict(err, 'canon_revision_conflict')) throw err;
      const latest = await api.getCanonSummary(projectId);
      setCanon(latest);
      return mutate(latest.revision);
    }
  };

  const openHidden = async () => {
    if (!canon) return;
    try {
      // shielded の summary には未公開項目本文が含まれないため、一覧を開く操作では
      // 表示モードも切り替えてから再取得する。
      if (canon.spoilerMode === 'shielded') {
        await api.updateState(projectId, {
          uiState: { canonSpoilerMode: 'visible' } as never,
        });
      }
      const summary = await api.getCanonSummary(projectId);
      setCanon(summary);
      setOpenedHidden(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : '未公開設定を表示できませんでした。');
    }
  };

  const revealItem = async (canonId: string) => {
    try {
      const item = await api.revealCanonItem(projectId, canonId);
      setRevealedItems((current) => new Map(current).set(canonId, item));
    } catch (err) {
      onError(err instanceof Error ? err.message : '設定の取得に失敗しました。');
    }
  };

  const toggleSpoilerMode = async () => {
    if (!canon) return;
    const nextMode = canon.spoilerMode === 'shielded' ? 'visible' : 'shielded';
    try {
      // NOTE: 表示モードはstate.jsonのuiStateに保存する（設計書 5.4）。
      await api.updateState(projectId, {
        uiState: { canonSpoilerMode: nextMode } as never,
      });
      setCanon({ ...canon, spoilerMode: nextMode });
      onFlashMessage(nextMode === 'visible' ? '未公開設定を表示します。' : '未公開設定を隠します。');
      void load();
    } catch (err) {
      onError(err instanceof Error ? err.message : '表示モードの変更に失敗しました。');
    }
  };

  const resolveConflict = async (conflictId: string, status: ConflictStatus) => {
    if (!canon) return;
    try {
      const next = await retryCanonMutation((revision) =>
        api.resolveCanonConflict(projectId, conflictId, { revision, status })
      );
      if (!next) return;
      setCanon(next);
      onFlashMessage(
        status === 'exception-accepted'
          ? '今回の採用本文だけを例外として残しました。'
          : status === 'dismissed'
            ? '表示を閉じました。次回生成前の要確認一覧には残ります。'
            : '競合を解決済みにしました。'
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : '競合の解決に失敗しました。');
    }
  };

  const lockItem = async (item: LatentCanonItem, locked: boolean) => {
    if (!canon) return;
    try {
      await retryCanonMutation((revision) =>
        api.setCanonLock(projectId, item.canonId, { revision, locked })
      );
      onFlashMessage(locked ? 'この設定を固定しました。' : '固定を解除しました。');
      void load();
    } catch (err) {
      onError(err instanceof Error ? err.message : '固定の変更に失敗しました。');
    }
  };

  const retireItem = async (item: LatentCanonItem) => {
    if (!canon) return;
    const confirmed = window.confirm('この設定を使わない設定として退役させますか？');
    if (!confirmed) return;
    try {
      await retryCanonMutation((revision) =>
        api.retireCanonItem(projectId, item.canonId, { revision, reason: 'manual' })
      );
      onFlashMessage('設定を退役させました。');
      void load();
    } catch (err) {
      onError(err instanceof Error ? err.message : '退役に失敗しました。');
    }
  };

  const restoreItem = async (canonId: string) => {
    if (!canon) return;
    const confirmed = window.confirm('この退役した設定を元の状態へ戻しますか？');
    if (!confirmed) return;
    try {
      await retryCanonMutation((revision) =>
        api.restoreCanonItem(projectId, canonId, { revision })
      );
      onFlashMessage('設定を元の状態へ戻しました。');
      setRevealedItems(new Map());
      void load();
    } catch (err) {
      onError(err instanceof Error ? err.message : '設定の復元に失敗しました。');
    }
  };

  const updateDraftItem = (index: number, patch: Partial<CreativeContractItemInput>) => {
    setDraftItems((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item))
    );
  };

  if (loading && !contract && !canon) {
    return (
      <section className="summary-card detail-settings-card">
        <header className="summary-card-header">
          <h2>作品の約束と未公開設定</h2>
        </header>
        <p className="settings-loading">読み込み中…</p>
      </section>
    );
  }

  const pendingConflicts = (canon?.pendingConflicts ?? []).filter(
    (conflict) => conflict.status === 'pending'
  );

  return (
    <section className="summary-card detail-settings-card">
      <header className="summary-card-header">
        <h2>作品の約束と未公開設定</h2>
        <div className="summary-card-badges">
          {canon && (
            <button
              type="button"
              className="settings-badge-link"
              onClick={() => void toggleSpoilerMode()}
              title="未公開設定の表示モード"
            >
              {canon.spoilerMode === 'shielded' ? '未公開設定: 隠す' : '未公開設定: 表示'}
            </button>
          )}
          {canon?.latentSeedStatus === 'failed' && (
            <span className="settings-badge warn">未公開設定を準備できませんでした（進行中に補完します）</span>
          )}
          {pendingConflicts.length > 0 && (
            <span className="settings-badge warn">要確認 {pendingConflicts.length}件</span>
          )}
        </div>
      </header>

      {/* 1. 作品の約束 */}
      <div className="canon-card">
        <div className="detail-settings-panel-header">
          <h3>作品の約束</h3>
          {!editingContract && contract && (
            <button type="button" className="settings-inline-button" onClick={beginEdit}>
              編集
            </button>
          )}
        </div>
        {!editingContract && (
          <div>
            {!contract || contract.items.length === 0 ? (
              <p className="summary-field-missing">まだありません。クイックセットアップや編集から追加できます。</p>
            ) : (
              <ul className="contract-item-list">
                {contract.items.map((item) => (
                  <li key={item.contractId} className={item.status === 'disabled' ? 'contract-item disabled' : 'contract-item'}>
                    <span className={`contract-strength ${item.strength}`}>
                      {item.strength === 'hard' ? '強く守る' : '好み'}
                    </span>
                    <span className="contract-text">
                      {item.text}
                      {item.status === 'disabled' ? '（無効）' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {contract && (
              <p className="canon-note">
                検証モード: {contract.verificationMode === 'strict' ? 'strict（本文を表示しながら厳格に検証）' : 'fast（表示を優先）'}
                {contract.exceptions.length > 0 ? ` / 承認済み例外 ${contract.exceptions.length}件` : ''}
              </p>
            )}
          </div>
        )}
        {editingContract && contract && (
          <div className="contract-editor">
            <div className="detail-settings-panel-header">
              <h4>約束（強く守る）・好み（soft）</h4>
            </div>
            {draftItems.map((item, index) => (
              <div key={index} className="contract-edit-row">
                <select
                  value={item.kind}
                  onChange={(e) =>
                    updateDraftItem(index, {
                      kind: e.target.value as CreativeContractItem['kind'],
                      strength: e.target.value === 'preference' ? 'soft' : 'hard',
                    })
                  }
                >
                  <option value="promise">約束（promise）</option>
                  <option value="prohibition">禁止（prohibition）</option>
                  <option value="preference">好み（preference）</option>
                </select>
                <input
                  type="text"
                  value={item.text}
                  maxLength={500}
                  onChange={(e) => updateDraftItem(index, { text: e.target.value })}
                  placeholder="契約の文言"
                />
                <select
                  value={item.status}
                  onChange={(e) =>
                    updateDraftItem(index, { status: e.target.value as CreativeContractItem['status'] })
                  }
                >
                  <option value="active">有効</option>
                  <option value="disabled">無効</option>
                </select>
                <button
                  type="button"
                  className="settings-inline-button danger"
                  onClick={() => setDraftItems((current) => current.filter((_, i) => i !== index))}
                >
                  削除
                </button>
              </div>
            ))}
            <button
              type="button"
              className="settings-inline-button"
              onClick={() =>
                setDraftItems((current) => [
                  ...current,
                  {
                    contractId: generateContractId(),
                    kind: 'promise',
                    strength: 'hard',
                    text: '',
                    source: 'user',
                    status: 'active',
                  },
                ])
              }
            >
              + 追加
            </button>
            <label className="contract-mode-row">
              検証モード:
              <select value={draftMode} onChange={(e) => setDraftMode(e.target.value as 'strict' | 'fast')}>
                <option value="strict">strict（本文を表示しながら厳格に検証）</option>
                <option value="fast">fast（表示を優先）</option>
              </select>
            </label>
            <div className="contract-edit-actions">
              <button type="button" className="settings-inline-button primary" onClick={() => void saveContract()}>
                保存
              </button>
              <button type="button" className="settings-inline-button" onClick={() => setEditingContract(false)}>
                キャンセル
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 2. 公開済みの設定 */}
      <div className="canon-card">
        <div className="detail-settings-panel-header">
          <h3>公開済みの設定</h3>
          <span className="settings-meta">{canon?.revealed.length ?? 0}件</span>
        </div>
        {(canon?.revealed.length ?? 0) === 0 ? (
          <p className="summary-field-missing">本文でまだ明らかになっていません。</p>
        ) : (
          <ul className="contract-item-list">
            {canon!.revealed.map((item) => (
              <li key={item.canonId} className="contract-item">
                <span className="contract-strength soft">公開済み</span>
                <span className="contract-text">
                  {item.statement}
                  {item.epistemicStatus !== 'fact' ? `（${item.epistemicStatus}）` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 3. 未公開設定 */}
      <div className="canon-card">
        <div className="detail-settings-panel-header">
          <h3>未公開設定</h3>
          <span className="settings-meta">
            {canon ? `${canon.hidden.total}件（人物${canon.hidden.byScope.character ?? 0}・世界${canon.hidden.byScope.world ?? 0}・関係${canon.hidden.byScope.relationship ?? 0}）` : ''}
          </span>
        </div>
        {!openedHidden && (canon?.hidden.total ?? 0) > 0 && (
          <p className="canon-note">
            <button type="button" className="settings-inline-button" onClick={() => void openHidden()}>
              内容を見る
            </button>
            <span className="canon-spoiler-warning">先の展開に関する内容が含まれます。</span>
          </p>
        )}
        {openedHidden && canon?.items && canon.items.length > 0 && (
          <ul className="contract-item-list">
            {canon.items.map((item) => (
              <li key={item.canonId} className="contract-item">
                <span className="contract-strength soft">
                  {item.status === 'foreshadowed' ? '示唆済み' : '未公開'}
                </span>
                <span className="contract-text">
                  {revealedItems.get(item.canonId)?.statement ?? (
                    <button
                      type="button"
                      className="settings-inline-button"
                      onClick={() => void revealItem(item.canonId)}
                    >
                      内容を表示
                    </button>
                  )}
                  {item.manualLock ? '（固定）' : ''}
                </span>
                {revealedItems.get(item.canonId) && (
                  <span className="contract-actions">
                    <button
                      type="button"
                      className="settings-inline-button"
                      onClick={() => void lockItem(item, !item.manualLock)}
                    >
                      {item.manualLock ? '固定解除' : '固定'}
                    </button>
                    <button
                      type="button"
                      className="settings-inline-button danger"
                      onClick={() => void retireItem(item)}
                    >
                      退役
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {openedHidden && (canon?.hidden.total ?? 0) === 0 && (
          <p className="summary-field-missing">未公開の設定はありません。</p>
        )}
      </div>

      {/* 4. 退役済み（取り消し可能・レビュー指摘 P2） */}
      {(canon?.retired.total ?? 0) > 0 && (
        <div className="canon-card">
          <div className="detail-settings-panel-header">
            <h3>退役済みの設定</h3>
            <span className="settings-meta">{canon?.retired.total ?? 0}件</span>
          </div>
          <ul className="contract-item-list">
            {canon!.retired.items.map((item) => (
              <li key={item.canonId} className="contract-item disabled">
                <span className="contract-strength soft">退役</span>
                <span className="contract-text">
                  {revealedItems.get(item.canonId)?.statement ?? (
                    <button
                      type="button"
                      className="settings-inline-button"
                      onClick={() => void revealItem(item.canonId)}
                    >
                      内容を表示
                    </button>
                  )}
                </span>
                <span className="contract-actions">
                  <button
                    type="button"
                    className="settings-inline-button"
                    onClick={() => void restoreItem(item.canonId)}
                  >
                    取り消す
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 5. 要確認（pending conflicts） */}
      <div className="canon-card">
        <div className="detail-settings-panel-header">
          <h3>要確認</h3>
          <span className="settings-meta">{pendingConflicts.length}件</span>
        </div>
        {pendingConflicts.length === 0 ? (
          <p className="summary-field-missing">確認が必要な競合はありません。</p>
        ) : (
          <ul className="contract-item-list">
            {pendingConflicts.map((conflict) => (
              <li key={conflict.conflictId} className="contract-item conflict-item">
                <div className="contract-text">
                  <strong>
                    {conflict.kind === 'hard-contract' ? '作品の約束との衝突' : '公開済み設定との衝突'}
                  </strong>
                  <div>{conflict.summary}</div>
                  <div className="canon-evidence">根拠: {conflict.evidenceExcerpt}</div>
                </div>
                <div className="contract-actions">
                  <button
                    type="button"
                    className="settings-inline-button"
                    onClick={() => setExpandedConflictId(expandedConflictId === conflict.conflictId ? null : conflict.conflictId)}
                  >
                    解決方法を選ぶ
                  </button>
                </div>
                {expandedConflictId === conflict.conflictId && (
                  <div className="conflict-actions">
                    <button
                      type="button"
                      className="settings-inline-button primary"
                      onClick={() => void resolveConflict(conflict.conflictId, 'exception-accepted')}
                    >
                      今回の本文だけ例外として残す
                    </button>
                    <button
                      type="button"
                      className="settings-inline-button"
                      onClick={() => void resolveConflict(conflict.conflictId, 'resolved')}
                    >
                      誤検出として解決済みにする
                    </button>
                    <button
                      type="button"
                      className="settings-inline-button"
                      onClick={() => void resolveConflict(conflict.conflictId, 'dismissed')}
                    >
                      表示を閉じる
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
