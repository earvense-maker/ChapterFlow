# 夢見るモード MVP 設計書

- 作成日: 2026-08-18
- 対象: 次期ベータ版
- 実装後: 受け入れ完了後に `docs/design/archive/` へ移動する

## 1. 目的

ChapterFlow に、文章で現れる夢世界を、自由入力と「何も書かず Enter」だけで漂う体験を追加する。

MVP で検証するのは次の一点である。

> 本文と入力欄だけの画面で、ユーザーが「AI へ指示している」のではなく、夢の中で浮かんだことを書いていると感じられるか。

## 2. MVP の体験

### 基本フロー

1. 一覧の「夢を見る」から、一文の種を入れて夢用プロジェクトを作る。
2. プロジェクトを開くと最初の情景をストリーミング生成する。
3. 文字を書いて Enter すると、行動・認識・感情・注意のどれとも限定せず世界が応答する。
4. 空欄のまま Enter すると、「しばらく眺める」として時間が少し進む。
5. 「目覚める」または `/wake` でセッションをアーカイブし、一覧へ戻る。

### 画面

表示するものは、夢の本文、末尾の一行入力欄、生成中の最小限の状態と停止、画面端の小さな「目覚める」、回復に必要なエラーだけとする。

吹き出し、発言者名、セッション一覧、設定ピル、再生成ボタン、選択肢は出さない。ユーザー入力も本文中には再表示しない。

### キーボード

- `Enter`: 送信。空入力なら眺める。
- `Shift+Enter`: 改行。
- `Escape`: 生成中だけ停止。
- `/wake` + `Enter`: 目覚める。

生成完了・回復可能なエラー後は、常に入力欄へフォーカスを戻す。IME 変換中の Enter は送信にしない。

## 3. MVP の対象外

- 本文中の語句クリックや範囲選択
- `current_focus` のような明示的な注目状態
- 「近づく」「離れる」などの常設ボタン
- 画像生成、音、アニメーション
- 複数の夢をまたぐモチーフ学習
- 「70% 新規 / 30% 残響」の数値制御

MVP の残響は同一セッションの履歴からのみ生じる。セッションをまたぐ記憶は、基本体験を検証した後に設計する。

## 4. アーキテクチャ

### `ProjectType` は増やさない

`ProjectType` は `novel | roleplay` のままとし、別軸の `ExperienceMode` を拡張する。

```ts
export type ExperienceMode = 'standard' | 'amplifier' | 'dream';
```

夢プロジェクトの内部 `projectType` は `roleplay` とする。ロールプレイ基盤のセッション保存、SSE、revision、停止・再接続回復が今回のターン型体験と一致するためである。

`ExperienceMode` が現在 `types/amplifier.ts` にある名前上の不自然さは、MVP ではファイル移動せず後の整理とする。

### 再利用するもの

- `roleplay/sessions/{sessionId}.json`
- sessionId 単位 mutex と revision 検査
- user 先行保存、応答コミット、未応答復旧
- SSE の `chunk / replace / done / error`
- プロンプト上限、NG 表現の保存前後処理
- `conversationSummary`
- セッションのアーカイブ

関係性数値は夢画面に表示せず、夢プロンプトにも入れない。MVP では既存要約が関係性を更新しても未使用値とし、要約パイプライン全体は分岐しない。

### 採用しない最小案

`Reader` と既存の小説生成 API をそのまま使う案は採用しない。この経路は夢の一ターンだけでなく、GenerationRecord、章、物語状態も更新するためである。また、空 Enter を LLM を呼ばないローカル演出にする案は、「何もしないときも世界側が存在して反応する」という体験の核を検証できない。

## 5. データ契約

### セッションモード

```ts
export type InteractiveSessionMode = 'roleplay' | 'dream';

export interface RoleplaySession {
  // 既存フィールド
  sessionMode?: InteractiveSessionMode;
}
```

`sessionMode` 欠損は `roleplay` と解釈する。プロジェクトの `experienceMode` は入口と表示、セッションの `sessionMode` は保存済み履歴の解釈契約とする。

### 入力種別

空 Enter を空文字の発言として通さず、API 契約で意味を持たせる。

```ts
export type DreamInputKind = 'text' | 'observe';

export interface SendRoleplayMessageBody {
  message?: string;
  inputKind?: DreamInputKind;
  revision: number;
  replacePendingMessageId?: string;
}
```

- `inputKind` 欠損は既存互換のため `text`。
- `observe` は `sessionMode === 'dream'` だけで受理する。
- `text` は trim 後空文字を拒否する。
- `observe` は内部で「しばらく眺める」という user message に正規化し、履歴・再試行・要約の順序契約を保つ。
- `RoleplayMessage` に optional の `inputKind?: 'text' | 'observe'` を保存する。

### `characterId` の MVP 制約

現行セッションは `characterId` が必須である。optional 化は storage、canon、fingerprint、要約へ影響が広がるため、MVP ではプロジェクトの先頭キャラクター ID を内部の視点アンカーとして使う。

- 夢 UI ではキャラクター選択を出さない。
- 夢 prompt はそのキャラクターを必ず演じる会話相手としては扱わない。
- キャラクター 0 件では回復可能な開始エラーを表示する。

## 6. 夢専用プロンプ

`roleplayPromptBuilder.ts` に大きな条件分岐を追加せず、`dreamPromptBuilder.ts` を新設する。`roleplaySessionService.ts` のターン実行基盤は共用し、プロンプト組み立てだけを `sessionMode` で切り替える。

### 固定規則

1. 会話キャラクターやゲームマスターではなく、ユーザーが内部にいる夢世界を描写する。
2. 説明、目的、クエスト、選択肢、メタな前置き、ユーザーへの質問を出さない。
3. 入力を行動命令だけでなく、感情、認識、内言、注意の手がかりとして読む。
4. 注意を向けられたものの意味密度を一段だけ上げ、すぐに全てを説明しない。
5. `observe` では小さな変化、偶然目に入るもの、または何も起きない時間を描く。毎回事件を起こさない。
6. ユーザーが糸を追い始めたら数ターンは優先するが、興味が移ったら未完のまま離れてよい。
7. 直前の空間・物・人物から 1〜2 個の錨を残しながら、夢らしい不連続は許す。
8. ユーザーの発言、心情、重要な決断を勝手に書かない。
9. 応答は日本語の夢の本文だけとし、見出し、箇条書き、Markdown を使わない。
10. 1 ターンは `roleplayOutputChars` 程度とする。

「70% 新規 / 30% 残響」は数値ロジックにせず、「大部分は新しく、少数の錨を残す」という原則に翻訳する。

### 可変プロンプト

1. 夢の種、世界観、関連する人物・潜在設定
2. `conversationSummary`
3. 直近の「夢の描写 / ユーザーの反応」
4. 今回の `text / observe`
5. 「夢の本文だけを続ける」という最終指示

すべて命令ではなく data block として渡す。

## 7. セッション開始と初回生成

1. active session の最新件があればそのまま再開する。
2. なければ、「夢を見る」で `sessionMode: 'dream'` の空セッションを作る。
3. 作成後、UI が直ちに `inputKind: 'observe'` の最初ターンを送る。
4. セッション作成と初回生成は別リクエストとする。初回生成が失敗しても session を失わず、Enter で再試行できる。

SSE、中断、user 先行保存、revision 復旧を既存ターンと同じ契約に保つため、初回生成を session create API へ統合しない。

## 8. UI とルーティング

`RoleplayWorkspace.tsx` は既に大きいため、夢 UI をその中へ追加せず `DreamWorkspace.tsx` を新設する。見た目は別でも、エラー時の GET 再同期と未応答ターンの回復契約は `RoleplayWorkspace` と同等にする。

`App.tsx` の画面種別に `dream` を追加し、次の順で振り分ける。

```text
experienceMode === dream -> DreamWorkspace
projectType === roleplay -> RoleplayWorkspace
otherwise                -> Reader
```

`ProjectList.onOpen` は `projectType` と `experienceMode` を渡す。作成完了や通知からの遷移でも、取得した project 本体で同じ判定を行う。

一覧の「夢を見る」は、既存の一文クイックセットアップを次の値で開く。

```ts
purpose: 'roleplay'
experienceMode: 'dream'
```

`QuickSetupWorkspace` の見出しとプレースホルダーだけは「どんな夢の入り口が欲しいですか」のような夢向け文言に変える。詳細設定全体の語彙変更は MVP 外とする。

## 9. 互換性と失敗時の扱い

- `experienceMode` 欠損は `standard`。`sessionMode` 欠損は `roleplay`。`inputKind` 欠損は `text`。
- 通常ロールプレイの空メッセージは従来どおり 400。
- 夢の `observe` だけが空入力を意味あるターンとして受理する。
- ストリーム中断後は保存済み末尾 user message から再試行し、同じ入力を追加しない。
- 初回生成失敗で作成済み session を削除しない。
- 生成中に目覚める操作は行わず、停止完了を待つ。
- setup session の localStorage キーは `standard / amplifier / dream` ごとに分ける。

## 10. 変更ファイル

### 共有

- `src/shared/types/amplifier.ts`: `ExperienceMode` へ `dream`。
- `src/shared/types/roleplay.ts`: `sessionMode`、`inputKind`、送信 body。
- `src/shared/defaults.ts`: `normalizeExperienceMode`。

### サーバー

- `src/server/services/dreamPromptBuilder.ts`: 夢専用 system / variable prompt。
- `src/server/services/roleplaySessionService.ts`: 夢 session、`observe` 正規化、prompt 切り替え。
- `src/server/routes/roleplay.ts`: 夢の characterId 解決と `inputKind` 伝播。
- `src/server/services/projectService.ts`: `dream` の作成検査・正規化。
- `src/server/services/setupSessionService.ts`: `dream` の作成検査・正規化。

### クライアント

- `src/client/components/DreamWorkspace.tsx`: 新規。
- `src/client/styles/dream.css`: 新規。
- `src/client/App.tsx`: dream view と振り分け。
- `src/client/components/ProjectList.tsx`: 作成入口、バッジ、mode 伝播。
- `src/client/components/QuickSetupWorkspace.tsx`: 夢向けの最小文言。
- `src/client/components/setupWorkspace/sessionStorage.ts`: mode ごとのキー分離。
- `src/client/clientApi.ts`: 変更された body 型。新規 endpoint は作らない。

### テスト

- `tests/unit/dreamPromptBuilder.test.ts`
- `tests/unit/dreamSessionService.test.ts`
- `tests/unit/DreamWorkspace.test.tsx`
- 既存 roleplay、ProjectList、setup テストへ後方互換ケースを追加する。

## 11. 受け入れ条件

1. 既存 novel / roleplay / amplifier の表示と生成が変わらない。
2. `experienceMode: dream` が作成、一覧、複製、再読み込みで保持される。
3. キャラクター選択なしで最初の情景を生成できる。
4. 空 Enter が `observe` として一回だけ保存され、本文が一ターン続く。
5. 空発言や自由入力が夢本文中に表示されない。ただし自由入力は保存と次 prompt に入る。
6. 夢 prompt に「選択肢・質問・メタ説明を出さない」「observe で毎回事件を起こさない」「注意対象を一段だけ濃くする」が含まれる。
7. 生成完了後に入力へフォーカスが戻り、マウスなしで 10 ターン続けられる。
8. 停止・通信エラー後に GET 再同期し、ターンを二重保存せず再開できる。
9. 目覚めると session が archive され、次回は新しい夢を開始できる。
10. 通常 roleplay の空送信は従来どおり拒否される。
11. 1280×720、390×844で本文と入力が同時に見え、操作が画面外へはみ出さない。

## 12. 実装順

1. 共有型、正規化、後方互換テスト。
2. `dreamPromptBuilder` と単体テスト。
3. session 基盤へ `sessionMode / inputKind` を通し、保存・再試行をテストする。
4. `DreamWorkspace` とクライアントテスト。
5. 作成入口、一覧、ルーティング。
6. 機能 QA、視覚 QA、ビューポート収まり QA を別々に行う。

## 13. 実装時に見るリスク

- 既存 roleplay クイックセットアップが人物会話に寄りすぎる場合だけ、dream 専用 setup prompt を追加する。
- 既存要約の関係性状態は MVP で未使用だが、将来は夢専用要約に分ける。
- ユーザー入力を完全に隠すことが、没入感と可読性のどちらに強く働くかを確認する。
- 空 Enter の連続で毎回「次のフック」を出す傾向がないかを確認する。
- モチーフ再出が単なる反復ではなく、残響と感じられるかを確認する。
