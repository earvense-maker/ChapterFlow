# AI相談 JSON 出力時の思考モード制御 設計書

実 API 確認済み（2026-08-04、deepseek-v4-flash / deepseek-v4-pro）

作成日: 2026-08-04
対象: 既存作品の AI 相談（`refineChatService`）と DeepSeek アダプタ
状態: 実装済み・受け入れ確認済み
実装後の扱い: 実装と受け入れ確認が完了したため、アーカイブ済み。

## 1. 目的

既存作品の AI 相談は、利用者へ見せる返答だけでなく、相談意図、次の候補ボタン、相談メモ、要約、変更候補を一度に受け取るため、応答全体を JSON にしている。

現在の DeepSeek アダプタは `responseMimeType: 'application/json'` のリクエストで thinking を一律無効にする。このため、通常相談や変更候補作成のように、作品固有の設定を読み、利用者の意図を仮説化し、複数案や安全な差分を判断するタスクでも DeepSeek の推論を利用できない。

本改修では次を実現する。

1. 既存作品の AI 相談では、JSON 出力を維持したまま DeepSeek thinking を有効にする。
2. thinking によって本文出力枠を使い切った場合や JSON 形式を満たさなかった場合は、同じ入力を thinking 無効で一度だけ再試行する。
3. 草案抽出、物語状態抽出、保守処理など、構造化・抽出を主目的とする既存 JSON タスクは thinking 無効のまま維持する。
4. Gemini、OpenAI、xAI、OpenRouter、MiMo の現在の挙動は変えない。

## 2. 背景と判断

### 2.1 JSON と thinking は排他的ではない

2026-08-04 時点の DeepSeek 公式 API は、thinking の切り替えと JSON Output の両方を提供している。JSON と thinking の併用を一般に禁止・非推奨とはしていない。

一方、JSON Output では空の `content` が返る場合があることも公式に注意されている。ChapterFlow でも `deepseek-v4-flash` が `reasoning_content` だけで出力枠を消費し、本文が空になる事象を確認済みである。

参考:

- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)
- [DeepSeek Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion)

### 2.2 DeepSeek V4 の effort 制約

DeepSeek V4 の thinking は `high` / `max` を実質的な選択肢とし、互換性のために渡された `low` / `medium` は `high` に対応付けられる。したがって、ChapterFlow 側で `low` を指定しても「軽い思考」にはならない。

本設計では AI 相談の初回を `high` と明示し、出力失敗時の非 thinking 再試行で安定性を確保する。`max` は遅延・コスト・出力枠消費が大きいため採用しない。

### 2.3 通常相談で JSON を維持する理由

`refineChatService` の JSON は次の機械処理に使う。

| フィールド | 用途 |
|---|---|
| `visibleReply` | 利用者へ表示する自然文 |
| `turnIntent` | 探索、確認、直接編集、変更候補作成の判定 |
| `suggestedActions` | 次の相談候補ボタン |
| `consultationStatePatch` | 確定、候補、未決定、好み仮説の相談メモ |
| `conversationSummary` | 長期相談の要約 |
| `patches` | 利用者が確認して反映する変更候補 |

`responseMode: 'consult'` では `patches` は必ず空であるが、他のフィールドは引き続き UI と相談継続性に必要である。本改修では平文と内部メタデータを別 API 呼び出しへ分離せず、現在の一回呼び出しを維持する。

## 3. スコープ

### 3.1 対象

- `refineChatService` の `auto` / `consult` / `prepare-patch` 全モード
- DeepSeek V4 Flash / V4 Pro の JSON 応答
- thinking 有効の初回呼び出し
- thinking 無効の最大一回のフォールバック
- 空応答、出力上限終了、JSON 形式不成立の診断ログ
- 関連ユニットテスト

`auto` も対象とする理由は、自由入力欄から通常相談と直接編集の両方が入るためである。入力経路によって相談品質が変わらないよう、3モードを同じ生成方針にする。

### 3.2 対象外

- 作成前相談（setup）の平文チャット
- `generateSetupDraft` の草案抽出
- `refineScanService` の全体走査
- `storyStateService` の物語状態抽出
- `postGenerationMaintenanceService` の生成後保守
- `styleVariationService` の文体分析
- JSON 出力を平文返答と別の LLM 呼び出しへ分離する改修
- Responses API、tool calling、JSON Schema strict mode への移行
- UI、保存スキーマ、API レスポンス型の変更
- DeepSeek 以外のプロバイダーの reasoning 制御変更

対象外の JSON タスクは `reasoningMode` を指定しない。これにより、DeepSeek の JSON リクエストでは現在どおり thinking 無効になる。

## 4. 現行動作

1. `refineChatService` はすべての相談モードで `responseMimeType: 'application/json'` を指定する。
2. `deepseekAdapter.extraBodyFields` は JSON 指定を検出すると、モデル名やタスクに関係なく `{ thinking: { type: 'disabled' } }` を送る。
3. 相談応答は `parseChatResult` で解析し、自然文しか返らなかった場合は表示用返答として許容するが、候補ボタン、相談メモ、要約、変更候補は更新しない。
4. 空応答や JSON 破損は `lastError` に記録されるが、thinking 無効での自動再試行はない。

## 5. 設計方針

### 5.1 呼び出し側が reasoning の有効・無効を明示する

`AdapterGenerateRequest` に次を追加する。

```ts
reasoningMode?: 'enabled' | 'disabled';
```

意味:

- `enabled`: 対応アダプタへ thinking 有効を明示する。
- `disabled`: 対応アダプタへ thinking 無効を明示する。
- 未指定: 後方互換のため、アダプタの現在の既定動作を維持する。

`reasoningEffort` は熟考量、`reasoningMode` は有効・無効を表す。二つを混同しない。

本改修で `reasoningMode` を解釈するのは `DeepSeekAdapter` だけとする。他のアダプタへ分岐を追加しない。

### 5.2 DeepSeek アダプタの優先順位

`DeepSeekAdapter.extraBodyFields` は次の順で判定する。

1. `reasoningMode === 'disabled'`
   - `{ thinking: { type: 'disabled' } }`
2. `reasoningMode === 'enabled'` かつモデルが `deepseek-v4-flash` または `deepseek-v4-pro`
   - `{ thinking: { type: 'enabled' }, reasoning_effort: 'high' }`
   - 本改修の明示 enabled 経路では `reasoningEffort` の `low` / `medium` をそのまま送らず、`high` に正規化する。DeepSeek V4 がどちらも `high` として扱うため、リクエストと実効値を一致させる。
3. `reasoningMode === 'enabled'` だが V4 以外
   - 未知・旧モデルへ未確認パラメータを強制しない。JSON リクエストなら従来どおり disabled、非 JSON なら従来どおりプロバイダー既定に任せる。
4. `reasoningMode` 未指定かつ `responseMimeType === 'application/json'`
   - 従来どおり disabled
5. `reasoningMode` 未指定かつ `deepseek-v4-flash` の非 JSON
   - 従来どおり enabled / `reasoning_effort: high`
6. それ以外
   - 従来どおり追加フィールドなし

V4 Pro は現在の標準 DeepSeek モデルである。JSON 相談で明示的に thinking を有効化できるよう、V4 Flash と同じく対象に含める。ただし非 JSON の既定動作までは本改修で変更しない。

既存の非 JSON 呼び出しで `reasoningMode` を省略し、`reasoningEffort: low | medium` を渡している経路の送信値は、本改修では変更しない。DeepSeek V4 側では実効値が `high` になるため、該当コメントは事実に合わせて更新するが、作成前相談の再設計は別課題とする。

### 5.3 AI 相談の初回リクエスト

DeepSeek V4 の場合だけ、`refineChatService` の初回リクエストへ次を追加する。

```ts
reasoningMode: 'enabled',
reasoningEffort: 'high',
maxOutputTokens: JSON_TASK_MAX_OUTPUT_TOKENS,
```

加えて従来どおり次を維持する。

```ts
responseMimeType: 'application/json'
```

`JSON_TASK_MAX_OUTPUT_TOKENS` は現在 40,000 トークンであり、相談本文と内部 JSON に加えて thinking の余地を確保する。プロバイダー上限は既存の `resolveMaxOutputTokens` が clamp する。

DeepSeek V4 以外と他プロバイダーでは、現在の出力上限とリクエスト項目を変更しない。プロバイダー条件を `refineChatService` 内に散らさず、リクエスト構築用の小さな関数へ閉じ込める。

推奨関数名:

```ts
buildRefineChatAdapterRequest(...)
```

または既存オブジェクトを受け取って DeepSeek V4 用フィールドだけを加える関数でもよい。新しい共通サービスや抽象化層は作らない。

### 5.4 再試行の責務

再試行は `DeepSeekAdapter` ではなく `refineChatService` が行う。

理由:

- アダプタは一回の HTTP 呼び出しとプロバイダー応答の正規化だけを担当する。
- JSON がこの機能のスキーマを満たすか、自然文フォールバックかは `parseChatResult` だけが判断できる。
- アダプタで再試行すると、他の JSON 抽出タスクまで意図せず二回呼び出す危険がある。

初回と再試行の両方が完了するまで、assistant message、相談メモ、要約、patch を session へ反映してはならない。ユーザーメッセージを保存する現在の位置は変えず、LLM 応答の適用だけを最終採用結果の後に一度行う。

### 5.5 再試行条件

本設計における「利用可能な構造化応答」は、`parseChatResult(text)` が次をすべて満たす結果とする。

- `null` ではない
- `freeText !== true`
- `visibleReply.trim()` が空ではない

この判定を再試行条件と結果選択で共有し、別々の条件式を実装しない。JSON 自体が解析できても `visibleReply` が空なら、利用者へ相談返答を出せていないため成功扱いにしない。

次をすべて満たす場合だけ、thinking 無効で一度再試行する。

1. `project.activeModelProvider === 'deepseek'`
2. 初回リクエストが `reasoningMode: 'enabled'`
3. 初回結果が `error` / `timeout` / `content_filter` ではない
4. 次のいずれかに該当する
   - `finishReason === 'length'`
   - `text.trim()` が空
   - `parseChatResult(text)` が `null`
   - `parseChatResult(text)` が `freeText: true` で、要求した構造化 JSON を満たしていない
   - 構造化 JSON として解析できたが、`visibleReply.trim()` が空

`finishReason === 'length'` は、偶然 `JSON.parse` できる形で終わっていても再試行する。出力上限終了時は要約や配列の一部が欠けた可能性を排除できないためである。

初回が API エラー、タイムアウト、安全フィルタの場合は本フォールバックの対象にしない。thinking を切ることで回復すると断定できず、待ち時間や二重課金だけを増やすためである。API エラーとタイムアウトは現在の例外処理へ流し、`content_filter` は現在どおり parse failure と `lastError` 保存の経路へ流す。

### 5.6 再試行リクエスト

再試行は初回と同一の system prompt、user prompt、temperature、JSON 指定、モデル名を使い、次だけを変える。

```ts
reasoningMode: 'disabled'
```

`reasoningEffort` は削除する。`maxOutputTokens` は 40,000 のままでよい。非 thinking のため通常は大部分を使わないが、長い変更候補や要約更新ターンが途中で切れることを避けられる。

再試行は最大一回とし、再帰やアダプタ内の追加再試行を行わない。

### 5.7 採用結果の選択

初回と再試行を次の優先順位で評価する。

1. `finishReason !== 'length'` かつ利用可能な構造化応答
   - 初回が該当すれば再試行しない。
   - 再試行が該当すれば再試行結果を採用する。
2. #1 に該当しないが、初回または再試行の `finishReason === 'length'` の結果に利用可能な構造化応答がある場合
   - 現行動作からの回帰を避けるため、その構造化応答を縮退採用する。
   - 両方が該当する場合は、thinking 無効で構造化契約の回復を試みた再試行結果を優先する。
   - 再試行が空、壊れた JSON、空の `visibleReply` のいずれかなら、初回の parse 済み構造化応答を採用する。
   - 出力上限終了の診断ログを残す。
   - 既存の `shouldAcceptPatches`、正規化、件数上限は通常どおり適用する。
3. 利用可能な構造化応答を得られなかったが、`finishReason !== 'length'` かつ `freeText: true` の自然文を得られた結果
   - 初回の thinking あり自然文を優先する。
   - 現行と同じく表示だけを保存し、候補ボタン、相談メモ、要約、patch は更新しない。
4. どちらにも利用可能な返答がない場合
   - 再試行結果を既存の parse failure 処理へ渡し、`lastError` と診断を保存する。

この選択により、JSON 形式回復のために再試行しつつ、初回の質の高い自然文まで失わない。

### 5.8 ログと診断

フォールバック開始時に `console.warn` を一回出す。

含める項目:

- `projectId`
- `provider`
- `modelName`
- `responseMode`
- 再試行理由: `length` / `empty` / `invalid-json` / `free-text`
- 初回の `finishReason`
- 初回の `debugInfo`（存在する場合）

新しいログ項目として含めないもの:

- system prompt / user prompt
- 作品本文や設定本文
- `reasoning_content` の実体
- API キー

`debugInfo` は文字数や finish reason など既存の短い診断だけを扱う。chain-of-thought を session、API レスポンス、通常ログへ保存しない。

現行の parse failure ログにある `textPreview` は例外として維持してよい。ただし解析前応答の先頭最大 400 字までとし、上限を増やさず、system prompt / user prompt / `reasoning_content` を追加しない。`textPreview` には本文引用が含まれる可能性があるため、完全な作品データを記録する診断手段として使わない。

再試行が成功した場合、session の `lastError` は `null` のままとする。再試行が発生した事実は診断ログにだけ残し、利用者へ警告を出さない。

## 6. 処理フロー

```text
ユーザー発言を session へ保存
  ↓
DeepSeek V4 か？
  ├─ いいえ → 現行どおり1回生成 → 現行解析・保存
  └─ はい
       ↓
     JSON + thinking high で生成
       ↓
     構造化JSONかつ length以外？
       ├─ はい → 初回結果を採用
       └─ いいえ
            ↓
          API error / timeout？
            ├─ はい → 現行の例外処理
            └─ いいえ
                 ↓
               content_filter？
                 ├─ はい → 現行のparse failure処理
                 └─ いいえ → 同一入力を thinking disabled で1回再生成
                 ↓
               利用可能な構造化JSONかつ length以外？
                 ├─ はい → 再試行結果を採用
                 └─ いいえ
                      ↓
                    lengthだが利用可能な構造化JSONがある？
                      ├─ はい → 再試行、次に初回の順で縮退採用
                      └─ いいえ → 利用可能な自然文があれば初回優先で表示のみ保存
                                   無ければ既存parse failure処理
```

## 7. 変更対象ファイル

### 7.1 `src/shared/types/model.ts`

- `AdapterGenerateRequest` に `reasoningMode?: 'enabled' | 'disabled'` を追加する。
- 省略時は後方互換であること、`reasoningEffort` と責務が異なることをコメントする。

### 7.2 `src/server/adapters/deepseekAdapter.ts`

- 5.2 の優先順位で `extraBodyFields` を変更する。
- DeepSeek V4 Flash / Pro の判定を小さな関数へ切り出してよい。
- JSON なら常に disabled という現在のコメントを、呼び出し側の明示指定を優先する説明へ更新する。
- 既存の非 JSON 動作を変更しない。

### 7.3 `src/server/services/refineChatService.ts`

- DeepSeek V4 の初回相談リクエストへ `reasoningMode: enabled`、`reasoningEffort: high`、40,000 token 上限を加える。
- `parseChatResult` を用いて初回結果を評価する。
- 条件成立時だけ thinking disabled で一度再試行する。
- 最終採用結果に対してだけ既存の message、相談 state、patch 更新を行う。
- `JSON_TASK_MAX_OUTPUT_TOKENS` を利用する。
- provider/model 分岐、再試行判定、結果選択はテスト可能な小関数へ分離する。ただし別サービスファイルは新設しない。
- `buildChatParseFailureMessage` またはその呼び出しを調整し、thinking 無効の再試行まで `length` で失敗した場合は「思考モードだけが原因」と断定しない。例: 「出力上限に達し、思考なしの再試行でも完全な構造化応答を得られませんでした。」

### 7.4 `tests/unit/deepseekAdapter.test.ts`

- JSON + `reasoningMode: enabled` で thinking enabled / effort high になる。
- JSON + `reasoningMode: disabled` で thinking disabled になる。
- JSON + mode 未指定は後方互換で thinking disabled のまま。
- V4 Pro も明示 enabled の対象になる。
- JSON + `reasoningMode: enabled` では、`reasoningEffort: low | medium` が渡されても送信値を high に正規化する。
- V4 以外へ未確認の thinking パラメータを強制しない。
- 現在の非 JSON 経路の「low へ下げられる」テストは後方互換として残してよいが、V4 では実効値が high になる公式仕様に合わせてテスト名とコメントを修正する。AI 相談の期待値として low を使わない。

### 7.5 `tests/unit/refineConsultation.test.ts` または `tests/unit/refineChatService.test.ts`

既存の相談テスト配置に合わせ、次のケースを追加する。

1. DeepSeek V4 の `consult` で初回が thinking enabled / high / JSON / 40,000 tokens。
2. `auto` と `prepare-patch` も同じ初回方針。
3. 初回が有効な構造化 JSON なら一回だけ呼ばれる。
4. 初回が空なら、二回目が thinking disabled で呼ばれる。
5. 初回が `finishReason: length` なら、JSON が読めても再試行する。
6. 初回が構造化 JSON でも `visibleReply` が空なら再試行する。
7. 初回が壊れた JSON なら再試行する。
8. 初回が自然文だけなら再試行し、二回目の構造化 JSON を採用する。
9. 二回目も失敗したが初回に自然文がある場合、初回自然文を表示し state / actions / patches は更新しない。
10. 初回が `length` だが利用可能な構造化応答で、二回目が失敗した場合、初回結果を縮退採用する。
11. 初回と二回目がともに `length` かつ利用可能な構造化応答の場合、二回目を縮退採用する。
12. 初回が空の `visibleReply`、二回目も利用不能の場合、空の構造化応答を採用しない。
13. 二回とも空または壊れた JSON の場合、既存どおり `lastError` を保存する。
14. 初回が timeout / error / content_filter の場合、本フォールバックを行わない。
15. `content_filter` は既存どおり parse failure と `lastError` 保存へ流れる。
16. Gemini、OpenAI、xAI の呼び出し回数と request が従来どおり。
17. 再試行しても user message、assistant message、consultation notes、patch が重複しない。

### 7.6 変更しないファイル

以下は本設計の実装では変更しない。

- `src/server/services/setupSessionService.ts`
- `src/server/services/refineScanService.ts`
- `src/server/services/storyStateService.ts`
- `src/server/services/postGenerationMaintenanceService.ts`
- `src/server/services/styleVariationService.ts`
- クライアントコンポーネントと CSS
- refine session の共有保存型

## 8. エラー処理と整合性

### 8.1 セッション更新

- 初回失敗時点では assistant message、notes、summary、patch を保存しない。
- 再試行中も working session の user message と revision を再追加しない。
- 最終採用結果だけを一度、既存の正規化・上限検証を通して保存する。
- retry 中も既存の session mutex を保持し、同一 session の別送信を割り込ませない。

### 8.2 パッチ安全境界

- `shouldAcceptPatches(responseMode, turnIntent)` を変更しない。
- `consult` の patch は引き続き破棄する。
- `auto` では `direct-edit` のときだけ patch を受け入れる。
- `prepare-patch` でも既存の `normalizePatch` と最大件数を通す。
- 初回と再試行の patch を混ぜない。採用した一方だけを処理する。

### 8.3 コストと待ち時間

- 通常成功時は従来どおり一回の API 呼び出し。
- フォーマット不成立時だけ最大二回になる。
- 初回が自然文だけの場合も、構造化契約の回復を試すため二回呼び出す。再試行でも構造化応答を得られなければ、5.7 の優先順位に従って初回の thinking あり自然文を保持する。
- 二回目は thinking disabled のため、通常は初回より短く安価になる。
- timeout は二回実行しないため、最大待ち時間が無条件に倍増することはない。

## 9. テスト実行

実装担当は少なくとも次を実行する。

```powershell
npm test -- tests/unit/deepseekAdapter.test.ts tests/unit/refineConsultation.test.ts
npm test -- tests/unit/refineScanService.test.ts tests/unit/setupSessionService.test.ts
npm run typecheck
```

実際の script 名が異なる場合は `package.json` の既存 script を正本とし、同等の対象テストと TypeScript 型検査を実行する。

実装完了の受け入れには、DeepSeek V4 Pro と V4 Flash の実 API スモークテストを必須とする。公式資料上のパラメータ仕様だけでなく、JSON + thinking の同時指定が実際のエンドポイントで受理されることをそれぞれ確認する。

- `thinking: { type: 'enabled' }` と `reasoning_effort: 'high'` を `response_format: { type: 'json_object' }` と同時に送って HTTP 400 にならない。
- 通常相談が JSON として解析される。
- `visibleReply` が空にならない。
- suggested actions が表示される。
- 「変更候補を作る」で patch card が一つだけ表示される。
- サーバーログへ reasoning 本文や作品本文が出ない。

API キーが必要なため CI の自動テスト条件にはしないが、実 API 確認が未実施なら実装を完全受け入れ済み・設計完了として扱わない。資格情報を利用できない実装担当は、結果を「実 API 確認待ち」として引き継ぐ。

## 10. 受け入れ条件

- [ ] DeepSeek V4 の既存作品 AI 相談が JSON + thinking high で実行される。
- [ ] 通常相談、自由入力、変更候補作成の3モードで同じ方針になる。
- [ ] 有効な構造化 JSON が返れば再試行しない。
- [ ] length、空応答、壊れた JSON、空の `visibleReply`、自然文のみの場合、thinking disabled で最大一回だけ再試行する。
- [ ] 再試行成功時は利用者にエラーを見せず、構造化された返答を一度だけ保存する。
- [ ] 再試行が失敗しても、初回の parse 済み構造化 JSON または利用可能な自然文を失わない。
- [ ] 二回の結果から message、notes、summary、patch が重複しない。
- [ ] 抽出・整形系 JSON タスクは thinking disabled のまま。
- [ ] DeepSeek 以外のプロバイダーの request、呼び出し回数、出力処理が変わらない。
- [ ] reasoning 内容、作品本文、API キーを新しいログへ出さない。
- [ ] 既存の `textPreview` は最大 400 字のままで、プロンプトや reasoning を追加しない。
- [ ] DeepSeek V4 Pro / Flash の実 API で JSON + thinking high の同時指定が受理される。
- [ ] 既存テスト、新規テスト、型検査が通る。

## 11. 実装順序

1. `AdapterGenerateRequest` に `reasoningMode` を追加する。
2. DeepSeek アダプタの明示 enabled / disabled と後方互換を実装し、アダプタテストを通す。
3. `refineChatService` で初回 request、再試行判定、結果選択を小関数として追加する。
4. session 更新が最終結果に対して一回だけ行われることを確認する。
5. 相談サービスの失敗・再試行・重複防止テストを追加する。
6. 抽出系と他プロバイダーの回帰テストを実行する。
7. DeepSeek V4 Pro / Flash の実 API スモークテストを行い、JSON + thinking high の互換性を確認する。

## 12. 実装時の注意

- 作業ツリーには、setup 相談の平文化や出力枠調整を含む未コミット変更が存在する。実装担当はそれらを巻き戻さず、現在の作業ツリーを基準に差分を追加する。
- `reasoningEffort: low` を DeepSeek V4 の軽量思考として扱わない。
- 再試行判定のために素の `JSON.parse` だけを新設せず、既存の `parseChatResult` を正本にする。
- 解析前のモデル出力をログへ丸ごと出さない。既存の `textPreview` だけは先頭最大 400 字の境界を維持する。
- フォールバックは品質向上の再生成ではなく、構造化契約を回復する安全弁である。成功した応答を理由なく二回生成しない。
