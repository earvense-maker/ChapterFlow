// 妄想増幅器の入口画面（設計書 4.1 / 4.2）
//
// NOTE: 最初に小説またはロールプレイを選ぶ。作成は既存の「一文から始める」クイック
// セットアップを流用し、希望者は既存の詳細設定へ移れる（設計書 2 の決定済み仕様）。
// 初回だけ説明を表示し、確認を amplifierDisclosureVersion としてアプリ設定へ保存する。

import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import type { SetupPurpose } from '@shared/types';

interface Props {
  onChoose: (purpose: SetupPurpose) => void;
  onOpenFullSetup: (purpose: SetupPurpose) => void;
  onCancel: () => void;
}

export default function AmplifierEntry({ onChoose, onOpenFullSetup, onCancel }: Props) {
  const [disclosure, setDisclosure] = useState<{ version: number; acknowledged: boolean } | null>(
    null
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    api
      .getAmplifierDisclosure()
      .then((result) => {
        if (mounted) setDisclosure(result);
      })
      .catch((err) => {
        if (mounted) {
          setLoadError(err instanceof Error ? err.message : '説明の読み込みに失敗しました。');
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const acknowledgeAndContinue = (purpose: SetupPurpose) => {
    void api.acknowledgeAmplifierDisclosure().catch(() => undefined);
    onChoose(purpose);
  };

  return (
    <div className="amplifier-entry">
      <header className="amplifier-entry-header">
        <button className="back-button" onClick={onCancel}>
          ← 一覧に戻る
        </button>
        <h1>妄想増幅器を始める</h1>
        <p className="settings-help">
          物語の続きを、あなたの「見たい方向」から選んで進める体験モードです。既存の小説・
          ロールプレイの形式を使い、場面の後に次への方向を提案します。
        </p>
      </header>

      {loadError && <div className="error-toast">{loadError}</div>}

      {disclosure && !disclosure.acknowledged && (
        <section className="settings-section amplifier-disclosure">
          <h2>はじめる前に</h2>
          <p>妄想増幅器は、あなたの「次に楽しめそうな方向」を毎回3〜5つ提案します。</p>
          <ul>
            <li>選択や自由記述から、作品をまたいで好みの仮説を更新します。</li>
            <li>仮説は設定画面で閲覧・修正・削除できます。</li>
            <li>グローバル学習は設定からオフにできます。</li>
            <li>関連する仮説は、選択したモデルプロバイダーへ生成材料として送られます。</li>
          </ul>
          <div className="summary-card-actions">
            <button className="secondary" onClick={onCancel}>
              やめておく
            </button>
            <button
              className="primary"
              onClick={() => {
                void api.acknowledgeAmplifierDisclosure().catch(() => undefined);
                setDisclosure({ version: disclosure.version, acknowledged: true });
              }}
            >
              理解しました
            </button>
          </div>
        </section>
      )}

      <section className="settings-section">
        <h2>どう体験しますか</h2>
        <div className="amplifier-mode-cards">
          <button
            className="amplifier-mode-card"
            onClick={() => acknowledgeAndContinue('roleplay')}
          >
            <h3>ロールプレイとして体験する</h3>
            <p>キャラクターと会話しながら、分身として体験したい方向を選びます。</p>
          </button>
          <button
            className="amplifier-mode-card"
            onClick={() => acknowledgeAndContinue('novel')}
          >
            <h3>小説として眺める</h3>
            <p>三人称の物語を、次に見たい方向を選びながら進めます。</p>
          </button>
        </div>
        <p className="settings-help">
          どちらも「一文から始める」で作成します。詳細を自分で決めたい場合は
          <button
            className="link-button"
            onClick={() => onOpenFullSetup('novel')}
          >
            詳細を自分で決める
          </button>
          から従来の相談画面へ移れます。
        </p>
      </section>
    </div>
  );
}
