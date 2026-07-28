# 作品設定 AI 相談強化 設計書

作成日: 2026-07-28  
対象バージョン: 0.1.0-beta.11 予定  
実装後の扱い: 実装完了後 `archive/` へ移動する。

## 0. 結論

作品設定画面内の「AI と相談して編集」を、ユーザーの修正指示から差分を作る補助欄ではなく、現在の作品を踏まえて方向を一緒に探す相談ワークスペースへ改修する。

本改修の中心は次の6点である。

1. `作品設定` と同列に `AI相談` の大タブを新設し、直接編集と相談を分離する。
2. AIの返答は一つの会話タイムラインへ集約し、現在の `AIからの気づき` / `相談履歴` の内側タブを廃止する。
3. AIはユーザーの言葉を字面どおり処理するだけでなく、求めている効果や読後感を仮説として言い換える。ただし真意を断定せず、ユーザーの明言とAIの推測を分離する。
4. 不足設定や複数案を具体的に提案し、質問だけで返さない。確定・候補・未確定を区別し、次の相談候補をボタンで提示する。
5. 通常の相談中は変更パッチを急いで作らず、方向が固まったとき、またはユーザーが直接変更を依頼したときだけ変更候補を作る。
6. 既存の設定走査、変更差分、反映・見送り、stale判定、自動レビュー監査、通知フォーカスを再利用する。

画面はPCでは「中央のチャット + 右側の気づき・保留中変更」、狭い画面では一列の折りたたみ構成とする。`AIからの気づき` は返答表示場所ではなく、相談テーマの受信箱として扱う。

---

## 1. 背景と現状

### 1.1 現状の実装

作品設定画面は `SettingPanel` の次の3タブで構成される。

- `作品設定`
- `記憶`
- `生成設定`

`AI と相談して編集` は `WorkSettingsTab` の先頭に `RefineChatPanel` として埋め込まれている。`RefineChatPanel` 内はさらに `AIからの気づき` と `相談履歴` の2タブに分かれる。

サーバー側にはすでに以下がある。

- プロジェクト単位の `RefineSession`
- user / assistant / system の会話履歴
- assistantメッセージに紐づく `RefinePatch`
- パッチの `pending / applied / rejected / stale`
- 世界設定の部分置換・追記
- 人物の追加・更新・削除
- 設定走査による `RefineFinding`
- 自動レビューrunと反映・取り消しの監査履歴
- 通知からrunまたはpatchへ移動する `SettingsFocusTarget`

したがって、新しい相談専用の保存・適用基盤を並行して作らない。既存refine系を相談体験に合わせて拡張する。

### 1.2 相談に感じにくい原因

現在の `refineChatService.buildChatPrompt` はAIを「差分パッチを提案する設定編集アシスタント」と定義し、`visibleReply` も「何をどう変えるか、なぜかを1〜3文」と制限する。UIの空状態と入力プレースホルダーも、変えたい点・足したい点をユーザーが先に指定する前提である。

このため、会話履歴は存在するものの、実際の体験は次の形に寄っている。

1. ユーザーが変更内容を考える。
2. ユーザーがAIへ指示する。
3. AIが差分を作る。

本改修では次の形へ変える。

1. ユーザーが曖昧な感覚や困り事を話す。
2. AIが現在の設定を根拠に、真意の仮説や複数の方向を返す。
3. ユーザーが選ぶ、混ぜる、否定する、未確定にする。
4. 方向が固まったときだけ変更候補を作る。
5. ユーザーが差分を確認して反映する。

---

## 2. 目的と非目標

### 2.1 目的

- 直接的な修正指示がなくても、AI側から作品固有の相談テーマを出せる。
- ユーザーがまだ言語化できていない意図を、断定ではなく仮説として返せる。
- 人物背景、関係性、火種、設定の余白を、作品の毛色に合わせて提案できる。
- 質問攻めにせず、違いの分かる2〜3案とおすすめ理由を提示できる。
- 確定事項、AI候補、意図的に残す未確定を混同しない。
- 相談と直接編集を目的別に行き来できる。
- AIが提案した内容は、既存の差分確認を経ない限り作品設定へ反映されない。
- 既存の自動レビュー、通知、stale判定、競合防止を維持する。
- 既存のrefineセッションJSONを読み込める。

### 2.2 非目標

- AIがユーザーの心理や人格を診断する機能にはしない。
- AIの推測をユーザーの確定した好みとしてアプリ全体へ自動保存しない。
- 空欄を機械的にすべて埋めない。意図的な余白も正当な選択として扱う。
- 相談だけで設定を自動適用しない。
- 本改修で世界・人物設定の正本スキーマ自体を全面再設計しない。
- ベクトルDBや外部検索基盤を導入しない。
- 全採用本文を毎ターン無制限にモデルへ渡さない。

---

## 3. 情報設計

### 3.1 上位タブ

`SettingPanel` のタブを次の4つにする。

```text
[ 作品設定 ] [ AI相談 3 ] [ 記憶 ] [ 生成設定 ]
```

型は次の形へ拡張する。

```ts
type Tab = 'work' | 'ai' | 'memory' | 'tech';
```

- `作品設定`: 世界・人物・システムプロンプトなどを直接確認・編集する。
- `AI相談`: AIとの会話、AIからの気づき、変更候補、自動レビュー監査を扱う。
- `記憶`: 現行どおり。
- `生成設定`: 現行どおり。

タブ表示は `AI相談` とし、長い `AIと相談して編集` は説明文にだけ使う。未処理の気づきがある場合は件数バッジを付ける。件数は最新scanのうち `resolved` または `intentional-gap` でない項目数とする。ゼロの場合はバッジを表示しない。

### 3.2 作品設定タブ

`WorkSettingsTab` から次を外す。

- `RefineChatPanel`
- 設定走査の結果一覧
- `RefineAutomationSettingsCard`

世界設定、人物、関係性などの直接編集UIは維持する。各対象には必要に応じて小さな相談導線を置く。

- 世界設定について相談
- この人物を深掘り
- この関係性を相談
- 選択した内容について相談

相談導線を押すと `AI相談` タブへ移動し、対象情報を入力欄上のコンテキストチップとして表示する。移動しただけではメッセージを送信せず、API料金を発生させない。

### 3.3 AI相談タブ

新規 `AIConsultationTab` を作り、既存 `RefineChatPanel` を分割・再構成する。

PCの基本構成:

```text
┌────────────────────────────┬──────────────────┐
│ AIとの相談                  │ AIからの気づき 3 │
│                            │                  │
│ 相談テーマ: 美咲 / 背景     │ ・美咲の動機     │
│                            │ ・二人の接点     │
│ AI: 現在の美咲は……         │ ・世界設定の空白 │
│                            │                  │
│ あなた: Bが近い             ├──────────────────┤
│                            │ 保留中の変更 1   │
│ AI: それなら……             │                  │
│ [この方向で変更候補を作る]  ├──────────────────┤
│                            │ 自動レビュー設定 │
├────────────────────────────┤                  │
│ 入力欄                [送る]│                  │
└────────────────────────────┴──────────────────┘
```

- 左を主領域、右を補助領域とする。
- 主領域の会話幅を優先し、右列は280〜340px程度を目安とする。
- 画面幅が狭い場合は一列にし、右列の各カードを会話上部または下部の折りたたみへ移す。
- 入力欄は会話領域下部に置き、会話スクロールと同時に画面外へ消えにくい構造にする。

### 3.4 会話タイムライン

現在の `AIからの気づき` / `相談履歴` の内側タブは廃止する。AIの返答、ユーザー発話、相談テーマ、変更候補、自動レビューrunは、一つのタイムラインに時系列で表示する。

表示規則:

- user / assistant は現行どおり吹き出しで表示する。
- assistant本文は既存の `LightMarkdown` を使い、段落、箇条書き、A/B/C案を読みやすくする。許可するのは現行実装の見出し、段落、箇条書き、太字、水平線だけとし、生HTML、画像、リンク、script、iframeは解釈しない。モデル出力を `dangerouslySetInnerHTML` へ渡さない。
- 選択した気づきは、ユーザー発話の代わりに送信しない。`相談テーマ` のコンテキストカードを表示し、ユーザーが送信または提案ボタンを押した時点でリクエストへ含める。
- `RefinePatch` は生成元assistantメッセージの直下に表示する。
- 自動レビューrunは現行どおり関連メッセージまたは孤立runとして表示するが、通常の相談を圧迫しないよう監査カードを折りたためるようにする。
- 送信後は新しいassistant応答までスクロールする。ユーザーが過去ログを読んでいる場合に無条件で最下部へ飛ばさず、「新しい返答」ボタンを表示する。

### 3.5 AIからの気づき

右側の `AIからの気づき` は相談テーマの受信箱とする。各カードに次を置く。

- 相談する
- 今は保留
- 意図的な空白として残す
- 解決済みにする
- 作品設定で直接編集

`相談する` を押すと対象findingが選択され、会話上部に相談テーマとして表示される。AIの返答は必ず中央の会話へ追加され、右側には表示しない。

`意図的な空白として残す` は単なる非表示ではない。後続scanで同趣旨のfindingが再出現しても、未処理件数へ戻さないための判断として保存する。

### 3.6 空状態と相談開始ボタン

会話が空のとき、AIが自動でモデル呼び出しを行わない。ローカルの案内文と開始ボタンを表示する。

- 今の設定の良さを整理
- 設定の弱いところを見つける
- 人物の背景を深掘り
- 関係性を強くする
- 意外な方向を提案
- 本文との食い違いを確認
- 自由に相談する

開始ボタンは定型メッセージを入力または送信する。送信する場合は必ず `responseMode: 'consult'` を指定し、開始操作から変更パッチを作らない。API呼び出しはユーザー操作後だけ行う。

---

## 4. 会話設計

### 4.1 AIの基本姿勢

AIを `設定編集アシスタント` ではなく `既存作品の設定を一緒に育てる相談相手` と定義する。

必須規則:

- 現在の設定を先に読み、作品固有の言葉で返す。
- ユーザーの発話を言い換えるだけで終わらない。
- 質問だけで返さず、少なくとも一つの具体案または見立てを添える。
- 方向が曖昧な場合は、違いの分かる2〜3案を短く提示する。
- 候補を混ぜられることを伝える。
- 作品の現在の良さと、変更した場合に失われる可能性も説明する。
- 一度に新しい論点を広げすぎず、最後に次の話題を一つ提案する。
- ユーザーが直接的な変更だけを求めた場合は、不要な相談を強制しない。

### 4.2 真意の読み取り

AIは、表面的な指示の背後にある可能性を次の層で検討する。

1. 直接の変更対象: 性格、口調、背景、関係など。
2. 求めている物語上の効果: 緊張、親密さ、危うさ、意外性など。
3. 守りたい既存の魅力: 優しさ、余白、テンポ、読後感など。

例:

```text
ユーザー: この人物をもう少し冷たくしたい

AI: もしかすると、性格そのものを冷酷にするより、
大切に思っていても言葉や態度に出さない人物にしたい感じでしょうか。
今の「家族思い」は残せるので、距離の取り方だけを変える方が合いそうです。
```

禁止事項:

- `あなたの本当の望みは〜です` と断定しない。
- AIの仮説をユーザー発の確定事項として保存しない。
- ユーザーの心理状態、性格、個人属性を推測しない。
- 低い確度の仮説を一案だけ提示して選択を迫らない。

確度が低い場合はA/B/C案を出す。確度が比較的高い場合も `もしかすると`、`〜に近いでしょうか` など仮説であることを明示し、具体案まで進める。確認質問だけでターンを消費しない。

### 4.3 確定・候補・未確定

相談上の内容を次に分類する。

- `confirmed`: ユーザーが明言または明示的に採用した内容。
- `candidate`: AIが提案した内容、ユーザーの真意に関する未確認の仮説。
- `undecided`: 今は決めない、本文で自然に決める、意図的に余白として残す内容。
- `preference-hypothesis`: この作品の相談内で見えてきた好みの傾向。

`preference-hypothesis` の例:

- 単純な悪人にはしたくない。
- 大事件より関係性のすれ違いを重視する。
- 説明より行動で見せたい。

これはアプリ全体の恒久的なユーザープロフィールへ自動昇格しない。AIは会話で役立つ場合だけ参照し、ユーザーの明言と食い違ったら更新または破棄する。

### 4.4 次の相談候補

assistant応答は0〜4件の `suggestedActions` を返せる。

例:

- この解釈が近い
- 少し違う
- AとBを混ぜる
- 別の案を見る
- この人物をさらに深掘り
- あえて未設定にする
- この方向で変更候補を作る

通常の候補は定型文を次のuserメッセージとして送る。`変更候補を作る` だけは `responseMode: 'prepare-patch'` を明示する。

### 4.5 パッチを作る条件

通常の相談で毎回パッチを作らない。一方、従来の「年齢を28歳に設定して」のような直接編集も維持する。

`responseMode` は次の3種類とする。

```ts
export type RefineResponseMode = 'auto' | 'consult' | 'prepare-patch';
```

- `auto`: 入力欄からの通常送信。モデルが `direct-edit` と判定した明示的変更依頼だけパッチを許可する。
- `consult`: 相談開始ボタン、真意確認、別案表示など。パッチを作らない。
- `prepare-patch`: ユーザーが変更候補作成を選んだ状態。合意内容からパッチを作る。

モデル出力の `turnIntent` は、会話表示と監査に使う補助情報として次とする。

```ts
export type RefineTurnIntent =
  | 'explore'
  | 'clarify'
  | 'direct-edit'
  | 'prepare-patch';
```

パッチ可否の一次境界はクライアントが送る `responseMode`、二次境界はモデルが返す `turnIntent` とする。`turnIntent` だけで作品設定が変わることはなく、生成されたpatchもユーザーが反映するまで `pending` に留まる。

サーバーは以下の場合だけモデル出力のpatchを採用する。

- requestの `responseMode === 'prepare-patch'`
- requestの `responseMode === 'auto'` かつ、出力の `turnIntent === 'direct-edit'`

`consult` でpatchが返っても破棄し、警告ログだけ残す。`auto` でモデルが誤って `direct-edit` と判定しても、patchカードが出るだけで自動反映はしない。ユーザーが相談だけを明示的に開始した導線はすべて `consult` を使い、`auto` は自由入力欄からの送信に限定する。

`prepare-patch` でpatchが0件だった場合は、無条件にモデルを再試行しない。安全な差分を作れない、合意内容が不足している、または変更済みで差分がない可能性があるため、assistantの `visibleReply` に理由と次の操作を表示する。JSON解析失敗または必須形式欠落の場合だけ、既存の再試行可能エラーとして扱う。

### 4.6 変更候補の操作

変更候補カードの操作を次にする。

- 反映する
- 調整を相談
- 見送る

`調整を相談` は現在のpatchの要約と差分を相談対象に設定し、`consult` モードで会話を続ける。新しいユーザー発話が保存された時点で従来どおり古いpending patchをstaleにする。

---

## 5. データ設計

### 5.1 共有型

`src/shared/types/refine.ts` に次を追加する。

```ts
export interface RefineSuggestedAction {
  label: string;
  message: string;
  responseMode?: 'consult' | 'prepare-patch';
}

export type RefineConsultationNoteKind =
  | 'confirmed'
  | 'candidate'
  | 'undecided'
  | 'preference-hypothesis';

export interface RefineConsultationNote {
  noteId: string;
  kind: RefineConsultationNoteKind;
  text: string;
  sourceMessageId: string;
  createdAt: string;
  status: 'active' | 'archived';
}

export interface RefineConsultationState {
  notes: RefineConsultationNote[];
  conversationSummary?: string;
  findingDispositions: RefineFindingDisposition[];
}

export interface RefineFindingDisposition {
  fingerprint: string;
  status: 'deferred' | 'intentional-gap' | 'resolved';
  note?: string;
  updatedAt: string;
}

export type RefineFindingTopic =
  | 'motivation'
  | 'past'
  | 'goal'
  | 'relationship'
  | 'secret'
  | 'speech'
  | 'world-rule'
  | 'timeline'
  | 'state'
  | 'other';

export type RefineConsultationTarget =
  | { kind: 'world'; section?: 'foundation' | 'initialSituation' }
  | { kind: 'character'; characterId: CharacterId; field?: string }
  | { kind: 'finding'; findingId: string; fingerprint: string }
  | { kind: 'patch'; patchId: string }
  | { kind: 'general' };
```

`RefineMessage` に次を追加する。

```ts
suggestedActions?: RefineSuggestedAction[];
target?: RefineConsultationTarget;
turnIntent?: RefineTurnIntent;
```

`suggestedActions` はレスポンスだけでなくmessageへ保存し、再読み込み後も表示できるようにする。ただし過去メッセージの候補は押せるままにしない。操作可能なのは、session内で最後のメッセージが当該assistantメッセージであり、`suggestedActions` が1件以上あり、送信・再試行・maintenance処理中でない場合だけとする。新しいuserメッセージが追加された時点で、それ以前の候補は履歴表示になる。再読み込み時もsessionのメッセージ順だけから同じ判定を再現する。

### 5.2 RefineSession

`RefineSession.schemaVersion` に `3` を追加し、次を任意フィールドとして追加する。

```ts
consultationState?: RefineConsultationState;
```

読み込み時のmigration:

- schema 1 / 2 は既存messages / patchesを維持する。
- `consultationState` がなければ空のnotes、空のfinding dispositionsで補完する。
- 既存assistantメッセージの `suggestedActions`、`turnIntent` は欠損のままでよい。
- migrationは現行の `migrateRefineSession` 内で行い、安全な1回の置換保存を使う。

migration保存に失敗した場合はリクエストをエラーにし、途中まで書き換えたsessionを返さない。`safeWriteJson` により旧ファイルを維持し、次回読み込み時に再試行する。

`resetRefineSession` は次の扱いとする。

- 手動相談messagesと相談notesは消す。
- `findingDispositions` は維持する。意図的な空白や解決済み判断を履歴リセットで失わない。
- 現行どおりauto-scan由来の監査message / patchは維持する。

### 5.3 finding topicとfingerprint

scanごとにfinding IDや説明文が変わっても判断を引き継げるよう、`RefineFinding` に任意の `topic` と `fingerprint` を追加する。

自然言語の `message` 全文はfingerprintへ使わない。モデルの言い換えだけで判断が失われるためである。scan出力のtopicを `RefineFindingTopic` へ正規化し、サーバーで次を連結してハッシュ化する。

- fingerprint schema version
- finding kind
- target kindとcharacterId等の安定識別子
- 管理されたtopic

AIがfingerprintを生成しない。topicが未知または欠落した場合は `other` へ正規化する。既存キャッシュでfingerprintがない場合は読み込み時にサーバーが計算する。

同じ対象・kind・topicに複数findingがある場合は、scan正規化時に一つへ統合する。`intentional-gap` を選べるのは `undefined` または `suggestion` かつtopicが `other` でないfindingだけとする。`contradiction` は将来状況が変わり得るため、永続的なintentional-gapにはできない。

dispositionの扱い:

- `intentional-gap`: 同じfingerprintの後続scanでも維持する。
- `deferred`: 現在のscanでは未処理件数から外すが、次回scanでは再表示してよい。
- `resolved`: 対応するscanの `reviewedStaticInputHash` が同じ間だけ未処理件数から外す。設定変更後のscanでは再評価する。

この安定fingerprintを、`resetRefineSession` がdispositionを維持する前提とする。fingerprint schemaを将来変更する場合は、旧dispositionを無言で誤適用せず、schema versionを変えて再確認対象に戻す。

### 5.4 会話要約

現行のプロンプト投入履歴は直近10件、保存上限は24件である。長い相談で採用・却下した方向を失わないよう、assistant応答が12件を超えた後は `conversationSummary` を最大1,200字で更新する。

要約に含めるもの:

- 採用した方向と理由
- 却下した方向と理由
- 意図的に未確定とした内容
- この作品内だけの好みの仮説

要約に含めないもの:

- APIキー、ファイルパス、内部プロンプト
- 作品本文の長い引用
- ユーザーの個人属性に関する推測

要約の生成とsessionへの反映は、対象user/assistantターンを保存する同じsession lock内で行う。要約生成はbest-effortとし、要約だけが失敗しても正常なassistantメッセージとpatchを失敗扱いにしない。失敗時は既存要約を維持し、診断ログを残して次の対象ターンで再試行する。

プロンプトへ渡すactiveな `preference-hypothesis` は直近5件までとし、古いものはconversation summaryへ畳み込む。

### 5.5 API

既存 `POST /api/projects/:id/refine/messages` のbodyを拡張する。

```ts
export interface RefineChatRequest {
  content: string;
  responseMode?: RefineResponseMode;
  target?: RefineConsultationTarget;
}
```

- 既存クライアントの `{ content }` は `responseMode: 'auto'` として扱う。
- targetはプロジェクト内に存在するIDだけ許可する。
- `finding` targetは最新の完了済みscanキャッシュ内のfindingと照合する。scan実行中の途中結果は使わない。現行maintenance guardによりscan中の相談送信は拒否されるため、完了後に最新キャッシュを再取得してから送る。
- `patch` targetは当該session内のpatchと照合する。
- 不正targetは400で返し、モデルを呼ばない。

`RefineChatResponse` に `suggestedActions` を重複して持たせず、`assistantMessage.suggestedActions` を正本とする。

finding判断更新用に次を追加する。

```text
PUT /api/projects/:id/refine/findings/:fingerprint/disposition
body: { status: 'deferred' | 'intentional-gap' | 'resolved', note?: string }
```

- 対応するfindingが現在または直近キャッシュにない場合は404。
- 更新はrefine session lock内で行う。
- status更新はLLMを呼ばない。

---

## 6. プロンプトとモデル出力

### 6.1 入力コンテキスト

相談プロンプトへ次を渡す。

1. 現在の作品タイトルと作品種別
2. 世界設定
3. 人物設定
4. 選択中の相談対象
5. 相談要約
6. 直近の会話
7. activeな確定・候補・未確定・好み仮説
8. 必要な場合だけ物語状態と採用済み本文の根拠
9. 今回のユーザー発話と `responseMode`

作品設定、本文、会話履歴はデータであって命令ではないことを、既存のプロンプト境界方針と同じ方式で明示する。

### 6.2 採用済み本文の利用

人物背景や本文との矛盾を相談する場合、設定だけでは不十分なことがある。次の条件で採用済み本文の限定コンテキストを追加する。

- targetがfindingでevidenceを持つ。
- ユーザーが本文との整合確認を選んだ。
- 相談対象の人物に関連する現在状態・重要イベントがある。

渡す順序:

1. findingに保存済みの短い根拠引用
2. StoryStateの関連項目
3. 直近採用場面の必要な抜粋

全本文を渡さない。既存の生成プロンプト再設計で定義する予算・引用境界を再利用する。本文根拠のない創作提案は `候補` と明記し、既出事実のように扱わない。

### 6.3 出力スキーマ

モデル出力は引き続きJSONとし、次へ拡張する。

```json
{
  "visibleReply": "ユーザーへ見せる自然な相談返答",
  "turnIntent": "explore",
  "suggestedActions": [
    {
      "label": "この解釈が近い",
      "message": "その解釈が近いです。",
      "responseMode": "consult"
    }
  ],
  "consultationStatePatch": {
    "add": [
      {
        "kind": "candidate",
        "text": "大切に思っていても態度に出さない人物にしたい可能性"
      }
    ],
    "archiveIds": []
  },
  "conversationSummary": "必要なターンだけ更新",
  "patches": []
}
```

サーバー側の正規化:

- `visibleReply`: 空なら読み取り失敗メッセージ。最大6,000字。
- `suggestedActions`: 最大4件。label最大40字、message最大1,000字。
- `consultationStatePatch.add`: 最大8件。ID・時刻・sourceMessageIdはサーバー採番。
- `archiveIds`: session lock内で、読み直した現在sessionに存在するactiveなnote IDだけ許可する。存在しないID、重複ID、すでにarchivedのIDは無視して警告ログを残し、ターン全体は失敗させない。
- `conversationSummary`: 最大1,200字。
- `patches`: 現行の最大6件とoperation検証を維持し、4.5の条件で採用可否を決める。

モデルが自然文だけを返した場合は、setup相談と同様に壊れたJSON断片でないことを確認したうえで `visibleReply` として表示する。自然文フォールバックではstate、suggestedActions、patchesを更新しない。

### 6.4 変更候補の説明

`prepare-patch` では、assistant返答に次を含める。

- 何を変更候補にしたか
- なぜ現在の作品に合うか
- まだ未確定として残した点
- 変更で失われる可能性がある要素

パッチのsummaryとoperationだけを返して説明を省略しない。

---

## 7. 状態・競合・安全性

### 7.1 直列化

手動相談、設定走査、自動レビューは同じ `RefineSession` を更新する。現行のproject maintenance guardとsession lockを維持し、新しいfinding disposition更新も同じlockへ入れる。

### 7.2 staleパッチ

- 新しいuserメッセージが保存された時点で、既存pending patchはstaleにする現行仕様を維持する。
- `調整を相談` も新しい相談ターンなので元patchはstaleになる。
- 設定が直接編集された場合、apply時のanchor・static hash検証で不一致を拒否する現行仕様を維持する。
- staleカードは履歴として表示するが、反映ボタンは無効化する。

### 7.3 真意推測の安全境界

- 真意仮説は `candidate` または `preference-hypothesis` 以外へ自動登録しない。
- モデルが仮説を `confirmed` で返しても、ユーザーの当該ターンに明示的採用表現がない場合はサーバーでcandidateへ降格する。
- 人物の重大な過去、秘密、事件の真相、人物削除は、`prepare-patch` または明示的なdirect editなしにpatch化しない。
- AIの相談返答には「断定ではない」ことを自然に示す。UI上で常時警告を出して会話を硬くしない。

### 7.4 プロンプトインジェクション境界

作品設定、人物説明、本文、finding引用、過去の会話はすべて作品・会話データとして引用する。これらに含まれる命令形式の文章をsystem指示として扱わない。相談対象ラベルは改行・制御文字を除去する。

---

## 8. 通知と画面遷移

`SettingsFocusTarget` を次へ拡張する。

```ts
export interface SettingsFocusTarget {
  section: 'ai-consultation';
  automationRunId?: string;
  patchId?: string;
  findingId?: string;
}
```

通知クリック時:

1. `SettingPanel` を開く。
2. `AI相談` タブを選択する。
3. 対象run、patch、findingを中央へスクロールまたは右欄で選択する。
4. 2秒程度の既存ハイライトを表示する。
5. focus targetを消費する。

旧 `section: 'refine-history'` を生成するクライアントコードは同じリリースで更新する。現状のfocus targetはクライアント内stateで運ばれるため、生成側と消費側を同時に変更する。将来または既存変更により保存イベントから復元する経路が存在する場合は、クライアント境界で旧値を `ai-consultation` へ正規化する互換処理をbeta.11の1リリースだけ残し、beta.12以降に旧値の利用がないことを検索・テストで確認して削除する。

---

## 9. アクセシビリティとレスポンシブ

- 上位タブは既存どおり `role="tablist"` / `role="tab"` / `aria-selected` を使う。
- 未処理件数は色だけで示さず、読み上げ名に `未確認の気づき3件` を含める。
- 会話の追加は `aria-live="polite"` とし、ストリーミング途中の全文を毎回読み上げない。
- suggested actionはbutton要素にし、キーボードで操作できるようにする。
- Enter送信は誤送信を避け、現行どおりCtrl/Cmd+Enterを維持する。送信ボタンも残す。
- 右欄をDOM上で会話より先に置かない。狭い画面で一列化した際も、会話→入力→補助情報の読み順を基本とする。
- 変更差分は色だけでなく `変更前` / `変更後` ラベルを持つ。
- ローディング、失敗、再試行、メンテナンス中の操作不可理由をテキストで表示する。

---

## 10. 対象ファイル

主な変更対象:

- `src/client/components/SettingPanel.tsx`
- `src/client/components/WorkSettingsTab.tsx`
- `src/client/components/RefineChatPanel.tsx`
- `src/client/components/RefineAutomationSettingsCard.tsx`
- `src/client/components/NotificationCenter.tsx`
- `src/client/App.tsx`
- `src/client/clientApi.ts`
- `src/client/styles/settings.css`
- `src/shared/types/refine.ts`
- `src/shared/types/notification.ts`
- `src/server/routes/refine.ts`
- `src/server/services/refineChatService.ts`
- `src/server/services/refineScanService.ts`
- `src/server/services/refineAutomationService.ts`
- `src/server/services/postGenerationMaintenanceService.ts`
- `tests/unit/refineChatService.test.ts`
- `tests/unit/RefineChatPanel.test.tsx`
- `tests/unit/WorkSettingsTab.test.tsx`
- `tests/unit/WorkSettingsWorld.test.tsx`
- 新規 `tests/unit/AIConsultationTab.test.tsx`
- 必要に応じて新規 `tests/e2e/aiConsultationUx.spec.ts`

実装時には `RefineChatPanel` を巨大化させず、少なくとも次へ分割する。

- `AIConsultationTab`: 画面状態とAPI接続
- `RefineConversation`: 会話タイムライン
- `RefineFindingsInbox`: 気づき一覧と判断
- `RefineSuggestedActions`: 次の相談候補
- `RefinePatchCard`: 既存カードを移動または再利用
- `RefineAutomationPanel`: 自動レビュー設定・監査表示

名前は実装時に既存命名との整合で調整してよいが、API状態管理と表示責務は分離する。

---

## 11. 実装順

### Phase 1: 画面分離と会話の一本化

1. `AI相談` 上位タブを追加する。
2. `RefineChatPanel` を `WorkSettingsTab` から移す。
3. 気づき・履歴の内側タブを廃止する。
4. 中央チャット + 右側気づきのレスポンシブレイアウトを作る。
5. 作品設定の各対象からAI相談へ移動できるようにする。
6. 通知focus targetをAI相談へ変更する。
7. `RefineAutomationSettingsCard` をAI相談タブの右側に移し、既存コンポーネントと保存APIを再利用する。

### Phase 2: 相談型応答

1. プロンプトを相談相手向けに再設計する。
2. 真意仮説、複数案、質問と提案のバランスを定義する。
3. `suggestedActions` と `responseMode` を追加する。
4. `LightMarkdown` でassistant返答を表示する。
5. 通常相談とパッチ作成条件を分離する。
6. 自然文フォールバックと出力正規化を追加する。

### Phase 3: 相談状態と気づき判断

1. `RefineSession` schema 3 migrationを追加する。
2. 確定・候補・未確定・好み仮説を保存する。
3. 会話要約を追加する。
4. finding fingerprintとdispositionを追加する。
5. `意図的な空白` を後続scanへ引き継ぐ。
6. `調整を相談` を追加する。

### Phase 4: 本文根拠の強化

1. finding evidenceを相談プロンプトへ渡す。
2. 関連するStoryStateを選択する。
3. 必要な採用済み本文だけを予算内で追加する。
4. 本文根拠と創作候補を返答内で区別する。

各Phaseは単独でテスト可能にする。Phase 1完了時点でも従来の直接編集チャットとパッチ適用は壊さない。Phase 2以降で相談体験を段階的に切り替える。

---

## 12. テスト計画

### 12.1 サービス・型

- schema 1 / 2のsessionがschema 3へ移行し、messages / patchesを失わない。
- resetで手動相談notesは消え、finding dispositionsとauto-scan監査は残る。
- `consult` でモデルがpatchを返しても保存されない。
- `prepare-patch` では正常なpatchがpendingで保存される。
- `auto + direct-edit` では従来どおりpatchを作れる。
- 真意仮説がユーザー確認なしにconfirmedへ昇格しない。
- suggestedActionsの件数・文字数・responseModeを正規化する。
- 自然文だけのモデル応答を会話へ表示し、stateとpatchを更新しない。
- conversation summaryが上限内で更新される。
- finding fingerprintがscanをまたいで安定する。
- intentional-gapが未処理件数へ戻らない。
- 存在しないcharacter / finding / patch targetを400で拒否する。
- finding disposition更新と自動scanがlost updateを起こさない。

### 12.2 UI

- `作品設定 / AI相談 / 記憶 / 生成設定` の4タブを操作できる。
- 作品設定タブに相談チャット本体が表示されない。
- 人物の相談ボタンからAI相談へ移動し、対象チップが表示される。
- AI返答が中央チャットへ表示される。
- findingを相談しても返答が右欄へ混入しない。
- 末尾assistantのsuggestedActionsだけ操作できる。
- `変更候補を作る` が `prepare-patch` で送信される。
- patchカードの `反映 / 調整を相談 / 見送る` が動作する。
- notification focusでAI相談タブと対象run/patch/findingが開く。
- 狭い画面で右欄が一列化し、入力欄と操作が横にはみ出さない。
- ローディング・エラー・メンテナンス中の表示が残る。
- AI相談から作品設定へ移動して直接編集し、戻った後に古いpatchを反映しようとするとstaleまたは競合エラーとして安全に拒否される。
- `prepare-patch` 送信中は他のsuggested action、送信、patch操作が無効になる。
- 送信中にタブを切り替えて戻っても、重複送信せず最新sessionを再取得できる。

### 12.3 プロンプト品質の固定ケース

プロンプト構築テストではsystem指示とuser promptに必要な規則・境界・responseModeが含まれることを文字列アサーションする。サービス統合テストではモックadapterのJSON応答を使い、turnIntent、suggestedActions、state patch、patch採用・破棄を決定的に検証する。実モデルの非決定的な文面一致をCIの合否条件にはしない。

1. `もっと冷たくしたい` に対し、真意を断定しない規則を含む。
2. 人物背景が空でも、すべて埋めるよう要求しない。
3. 方向不明時に2〜3案を求める。
4. 質問だけで返さず具体案を添える。
5. ユーザーの明言とAI仮説を区別する。
6. `consult` ではpatchを返さない。
7. 本文根拠と創作候補を区別する。
8. 直接変更依頼では不要な相談を強制しない。

---

## 13. 受け入れ条件

- `AI相談` が作品設定と同列のタブとして表示される。
- 作品設定の直接編集とAI相談が別画面になり、相互に対象付きで移動できる。
- AIの返答は一つの中央チャットへ表示される。
- `AIからの気づき` と `相談履歴` の内側タブがなくなる。
- 気づきから相談を開始し、同じ会話内で往復できる。
- AIは現在設定を踏まえ、真意の仮説を断定せず提示できる。
- 曖昧な要望へ具体的な複数案を返し、質問だけで終わらない。
- 確定、候補、未確定、作品内の好み仮説が区別される。
- 通常相談では不要なpatchカードを出さない。
- 合意後または直接編集依頼時だけ変更候補を作れる。
- 変更候補はassistant返答の直下で確認・反映・調整相談・見送りできる。
- 意図的な空白として残したfindingが、同じ内容で未処理へ戻り続けない。
- 既存refine session、auto-scan監査、通知、自動レビュー取り消しを壊さない。
- AI相談タブを開いただけではモデルAPIを呼ばない。

---

## 14. リスクと対策

| リスク | 対策 |
|---|---|
| AIが真意を決めつける | 仮説表現をsystem規則化し、未確認はcandidateへ正規化する |
| 相談が長くなり結論に進まない | 一度の論点を絞り、次の一歩と変更候補作成ボタンを出す |
| 毎ターンpatchが出て画面が重い | responseModeとturnIntentでpatch条件を制限する |
| 気づきと会話の役割が再び混ざる | 気づきはテーマ受信箱、返答は中央タイムラインに固定する |
| 空欄をすべて欠陥扱いする | intentional-gapを保存し、埋めない選択を同格にする |
| 好み仮説がユーザー属性として固定される | 作品内sessionに限定し、明言と食い違えば破棄する |
| 長い相談で過去の採否を忘れる | 構造化notesとconversation summaryを併用する |
| 本文投入でプロンプトが肥大化する | finding evidence、StoryState、必要抜粋の順で予算選択する |
| 既存の自動レビューとlost updateが起きる | maintenance guardとsession lockを全更新経路で共用する |
| UI分割で直接編集後の表示が古くなる | タブ切替時またはpatch反映後にworld / charactersを再取得する |

---

## 15. 実装時の前提

- 既存の `RefinePatch` を変更候補の正本として再利用する。
- AI相談はユーザーが最終決定を行う補助機能であり、AI提案を自動適用しない。
- 真意の読み取りはユーザー発話の意味を狭めるためではなく、複数の可能性を言語化するために使う。
- 人物背景は、望み・恐れなどの固定フォームを全員へ要求せず、その作品を動かすのに必要な軸だけを提案する。
- `作品設定` は直接編集の正本、`AI相談` は相談と差分作成のワークスペースとする。
- 設定の事実が食い違う場合は、既存方針どおり採用済み本文、現在状態・重要イベント、作品設定の順を守る。ただし、今回のユーザー発話が明示する変更は変更候補として扱える。
