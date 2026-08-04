# ChapterFlow

**API-Powered Narrative Studio**

自分専用の連載小説を、その場の気分で進めるWindows向けローカルアプリです。
作品設定、これまでの流れ、設定草案をもとに、Gemini / DeepSeek / OpenAI / xAI / OpenRouterのAPIで続きを生成できます。
初回ベータではGemini / DeepSeek / xAIを実機確認済み、OpenAI / OpenRouterは実装・自動テスト済みですが実APIでは未検証です。

> 現在は初回公開に向けたベータ段階です。大切な作品データは定期的にバックアップしてください。

## ダウンロードと利用

[GitHub Releases](https://github.com/earvense-maker/ChapterFlow/releases)から最新版を入手します。

- `ChapterFlow Setup <version>.exe`: 通常はこちらを使用します。
- `ChapterFlow <version>.exe`: インストールしないポータブル版です。

利用者側でNode.jsをインストールする必要はありません。対応環境、APIキーの取得、バックアップ、
SmartScreen警告への対応は[利用ガイド](docs/利用ガイド.md)を確認してください。

## データ、プライバシー、料金

- 作品データの既定の保存先はPC内の `Documents\ChapterFlow` です。
- 生成、相談、接続確認では、作品設定、本文、会話履歴、入力した指示のうち必要な部分を、選択したLLM事業者へ送信します。
- OpenRouterでは生成内容がOpenRouterと、選択されたモデルの提供事業者の双方へ送信されます。既定は無料の `google/gemma-4-31b-it:free` で、利用できない場合はモデル名を変更できます。`openrouter/free`を指定した場合は、選択モデルが呼び出しごとに変わる場合があります。利用前に[OpenRouterのPrivacy設定](https://openrouter.ai/settings/privacy)を確認してください。
- APIキーはデータ保存先の `config\credentials.json` に平文で保存されます。
- 生成は利用者自身のAPIキーで行われ、各社の料金体系に応じて費用が発生する場合があります。
- ChapterFlow独自のクラウド保存、アクセス解析、テレメトリー送信はありません。

バックアップや作品データを人へ渡すときは、APIキーを含む `config` フォルダを除外してください。

## ソースから開発する

必要環境はNode.js 22.12以上です。

```bash
npm ci
npm run dev
```

開発画面は `http://localhost:5173` で開きます。Electron版の挙動確認には次を使います。

```bash
npm run dev:electron
```

### 生成の詳細診断（開発版限定）

`npm run dev` では生成ごとに次の診断情報を記録します。配布するElectron版では既定で無効で、
記録も保存も行いません。

- `GenerationRecord.telemetry`: リクエスト受付からモデル応答までの時刻、初回チャンクまでの
  待ち時間、推論／本文の文字数とチャンク数、プロバイダー申告のトークン使用量。
- `<generationId>.reasoning.txt`: 思考モードのモデルが返した推論本文（生成ログと同じ
  `generations` フォルダ）。本文には混ぜず、`GenerationRecord` にも入れません。
- `promptBudgetReport`: プロンプトを上限内へ収めるための縮小結果。どのセクションを何字から
  何字へ削ったか、トークン数が実測か推定かの内訳です。生成レコードとロールプレイの各ターン、
  およびロールプレイのセッション作成時スナップショットに記録します。
  縮小の判定自体はこのフラグに関係なく常に行われ、記録するかどうかだけが変わります。
- `logs/prompts/cf-prompt-<時刻>-<連番>-<ラベル>-<プロバイダー>.txt`: モデルへ実際に送った
  指示文。`systemInstructions`（不変契約・ベース指示・カスタム指示・プリセット）と
  `userPrompt` の両方を原文のまま、送信直前に書き出します。指示文そのものを推敲するための
  出力です。ラベルで呼び出し元が分かります（`novel.generate.continue`、`roleplay.turn.stream`、
  `refine.scan`、`setup.chat`、`maintenance.scan` など）。直近200件を保持し、古い分から
  自動で消えます。

`npm run dev` 以外の起動方法（`npm start`、`npm run dev:electron`、配布版exe）で一時的に
有効化するときは環境変数を立てます。無効に戻すには `0` を指定するか変数を削除します。

- `CHAPTERFLOW_DEV_DIAGNOSTICS`: `1` / `true` / `on` / `yes` で有効。既定は無効。
- `CHAPTERFLOW_DEV_PROMPT_DUMP`: `0` / `false` / `off` / `no` で指示文ダンプだけを止めます。
  上を有効にしたときの既定は有効。
- `CHAPTERFLOW_DEV_PROMPT_DUMP_DIR`: 指示文ダンプの出力先。既定は起動ディレクトリの
  `logs/prompts`。件数上限の削除対象は `cf-prompt-` で始まる自分の出力だけなので、
  既存ファイルのあるフォルダを指しても巻き添えにはなりません。

推論本文と指示文ダンプには、作品本文・人物設定・記憶がほぼそのまま含まれます（`logs/` は
git 管理外ですが、内容は平文です）。有効にしたまま作品データやログを人へ渡さないでください。

なお、小説生成の `userPrompt` だけは診断フラグと関係なく
`<generationId>.prompt.txt` として作品データ側にも保存され続けます（前の文脈を復元するための
スナップショットで、`systemInstructions` は含みません）。上のダンプとは別物です。

## テストとビルド

```bash
npm test
npm run test:e2e
npm run build:electron
```

## Electron配布物を作る

配布前に `package.json` の `version` を更新してから実行します。

```bash
npm run dist:electron
```

`release/electron/` にインストーラ版、ポータブル版、`LICENSE`、利用ガイド、
`SHA256SUMS.txt` が作成されます。`win-unpacked/` は動作確認用の中間成果物で、配布対象ではありません。

## スマホから使う（開発・作者用LAN配信）

同じWi-Fi上のスマホから使う簡易モードです。Electron配布物には含まれません。

```bash
npm run build:start:lan
```

または `start-chapterflow-lan.bat` を実行し、起動ログの
`http://<PCのLAN IP>:3001/?token=...` をスマホで開きます。信頼できるプライベートネットワークでのみ使用してください。

環境変数:

- `CHAPTERFLOW_HOST`: バインドアドレス。既定は `127.0.0.1`、LANモードは `0.0.0.0`。
- `CHAPTERFLOW_ALLOWED_ORIGINS`: CORS許可オリジンをカンマ区切りで指定。

旧 `YUMEWEAVING_*` 環境変数も移行期間中は互換用に読み込みます。

## 開発資料

実装時の設計書とレビュー記録は[設計資料アーカイブ](docs/design/README.md)にまとめています。これらは履歴資料であり、現行仕様はコードと利用ガイドを優先します。

## 不具合報告とセキュリティ

通常の不具合は[Issues](https://github.com/earvense-maker/ChapterFlow/issues)へ報告してください。
脆弱性の可能性がある問題は[SECURITY.md](SECURITY.md)の非公開窓口を使用してください。

## ライセンス

[MIT License](LICENSE)
