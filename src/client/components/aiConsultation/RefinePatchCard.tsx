import type {
  Character,
  RefineAutomationRun,
  RefinePatch,
  RefinePatchOperation,
  RefinePatchStatus,
} from '@shared/types';
import {
  evidenceScopeLabel,
  formatCharacterFieldValue,
  formatCharacterPatchValue,
  statusLabel,
} from './consultationFormat';

interface Props {
  patch: RefinePatch;
  characters: Character[];
  busy: boolean;
  disabled: boolean;
  onApply: () => void;
  onReject: () => void;
  onDiscussAdjustment: () => void;
  automationRun?: RefineAutomationRun;
}

export default function RefinePatchCard({
  patch,
  characters,
  busy,
  disabled,
  onApply,
  onReject,
  onDiscussAdjustment,
  automationRun,
}: Props) {
  const effectiveStatus: RefinePatchStatus =
    automationRun?.status === 'stale' && patch.status === 'pending' ? 'stale' : patch.status;
  const isActionable = effectiveStatus === 'pending';
  return (
    <div
      id={`refine-patch-${patch.patchId}`}
      className={`refine-patch-card status-${effectiveStatus}`}
    >
      <div className="refine-patch-header">
        <span className={`refine-patch-status status-${effectiveStatus}`}>
          {statusLabel(effectiveStatus)}
        </span>
        {patch.riskLevel === 'review' && <span className="settings-badge warn">要確認</span>}
        <span className="refine-patch-summary">{patch.summary}</span>
      </div>
      {automationRun && (
        <div className="refine-patch-meta">
          <span>根拠: {evidenceScopeLabel(patch.evidenceScope)}</span>
          {patch.riskReasons && patch.riskReasons.length > 0 && (
            <span>{patch.riskReasons.join(' / ')}</span>
          )}
        </div>
      )}
      <ul className="refine-patch-ops">
        {patch.operations.map((op, idx) => (
          <li key={idx}>
            <PatchOpView op={op} characters={characters} />
          </li>
        ))}
      </ul>
      {patch.applyError && <div className="refine-patch-error">反映失敗: {patch.applyError}</div>}
      {isActionable ? (
        <div className="refine-patch-actions">
          <button type="button" onClick={onReject} disabled={disabled}>
            見送る
          </button>
          <button type="button" onClick={onDiscussAdjustment} disabled={disabled}>
            調整を相談
          </button>
          <button type="button" className="primary" onClick={onApply} disabled={disabled}>
            {busy ? '反映中…' : '反映する'}
          </button>
        </div>
      ) : (
        effectiveStatus === 'stale' && (
          // NOTE: stale は履歴として残すが反映はさせない。理由を書かないと
          // 「ボタンが消えた」だけに見える。
          <p className="refine-patch-stale-note">
            この後に新しい相談や設定変更があったため、この提案は反映できません。
          </p>
        )
      )}
    </div>
  );
}

function PatchOpView({ op, characters }: { op: RefinePatchOperation; characters: Character[] }) {
  switch (op.kind) {
    case 'world-replace':
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">世界: 置換</div>
          <div className="refine-patch-old">
            <span className="refine-patch-change-label">変更前</span> {op.op.anchor}
          </div>
          <div className="refine-patch-new">
            <span className="refine-patch-change-label">変更後</span> {op.op.replacement}
          </div>
        </div>
      );
    case 'world-append':
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">世界: 追記</div>
          <div className="refine-patch-new">
            <span className="refine-patch-change-label">追加</span> {op.op.text}
          </div>
        </div>
      );
    case 'character-update': {
      const character = characters.find((c) => c.characterId === op.characterId);
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">
            人物: 更新（{character?.name ?? op.characterId}）
          </div>
          {Object.entries(op.fields).map(([key, value]) => (
            <div key={key} className="refine-patch-field">
              <span className="refine-patch-field-key">{key}</span>
              <div className="refine-patch-old">
                <span className="refine-patch-change-label">変更前</span>{' '}
                {formatCharacterFieldValue(character, key)}
              </div>
              <div className="refine-patch-new">
                <span className="refine-patch-change-label">変更後</span>{' '}
                {formatCharacterPatchValue(value)}
              </div>
            </div>
          ))}
        </div>
      );
    }
    case 'character-add':
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">人物: 追加</div>
          <div className="refine-patch-new">
            <span className="refine-patch-change-label">追加</span> {op.character.name}（
            {op.character.role}）
          </div>
          {op.character.description && (
            <div className="refine-patch-new">{op.character.description}</div>
          )}
          {(op.character.traits?.length ?? 0) > 0 && (
            <div className="refine-patch-new">{formatCharacterPatchValue(op.character.traits)}</div>
          )}
          {op.character.secrets && (
            <div className="refine-patch-new">見せない面: {op.character.secrets}</div>
          )}
        </div>
      );
    case 'character-remove': {
      const character = characters.find((c) => c.characterId === op.characterId);
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">人物: 削除</div>
          <div className="refine-patch-old">
            <span className="refine-patch-change-label">変更前</span>{' '}
            {character?.name ?? op.characterId}
          </div>
        </div>
      );
    }
  }
}
