# ChapterFlow 公開Web版

`docs/design/公開Web版_設計書.md` の実装。**Phase 0（境界固定と回帰防止）まで完了**。

## 現在の状態

認証前の「空の起動系」であり、作品データを一切扱わない。設計書 17 の
「認証だけを追加して、既存の共有 `DATA_DIR` をそのまま公開しない」に従い、
認証と所有者付き保存が揃うまで `/api` は 501 を返す。

| 経路 | 応答 |
| --- | --- |
| `GET /healthz` | 200 |
| `GET /api/system/version` | 200 `{ version, runtime: "web" }` |
| `GET /api/_probe/sse` | SSE検証プローブ（トークン設定時のみ） |
| データディレクトリ／終了／再起動／ショートカット系 | 恒久的に 404 |
| その他の `/api/*` | 501 `not_implemented` |
| それ以外 | 404 |

## コマンド

```bash
npm run web:dev        # tsx で起動
npm run web:typecheck  # 型検査
npm run web:test       # tests/web を実行
npm run web:build      # dist-web へ出力
npm run web:start      # ビルド済みを起動
```

## 環境変数

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `PORT` | `3100` | 待ち受けポート |
| `CHAPTERFLOW_WEB_HOST` | `0.0.0.0` | 待ち受けホスト |
| `CHAPTERFLOW_WEB_TRUST_PROXY` | `0` | プロキシ段数。**ホスティング確定時に必ず設定する**（設計書 10.1） |
| `CHAPTERFLOW_WEB_REQUIRE_HTTPS` | 未設定 | `1` で HTTPS 強制と HSTS |
| `CHAPTERFLOW_WEB_JSON_LIMIT` | `1mb` | ボディ上限（実値は設計書 15-7 の未決定事項） |
| `CHAPTERFLOW_WEB_SSE_PROBE_TOKEN` | 未設定 | SSE検証プローブの有効化トークン |

## Electron 版との境界

- ルートの既存ビルド・保存方式は一切変更していない。出力先も `dist/` と `dist-web/` で分離。
- `apps/web` は `src/` 配下を import しない。共有したい純粋ロジックは `packages/core` へ
  抽出してから使う（設計書 4.1）。この制約は `tests/unit/webPortability.test.ts` が守る。
- Electron 版の `createApp` は再利用していない。CORS 自動許可と LAN トークン認証を
  前提にしているため（設計書 10.1）。
- npm workspaces はまだ使っていないので、依存はルートの `node_modules` を使う。
  `apps/web/package.json` はバージョン識別のためだけに置いてある。

## Phase 0 で入れたもの

- 空の Web 起動系（このディレクトリ）と別CIジョブ（`.github/workflows/ci.yml` の `web`）
- ストレージ契約 `src/server/storage/`（`ProjectStorage` / `FileStorage` / 注入レジストリ）
- 移行インベントリ `docs/design/公開Web版_移行インベントリ.md`（`npm run web:inventory` で再生成）
- API応答の契約テスト `tests/integration/apiResponseContract.test.ts`
- SSE 耐久検証 `npm run sse:endurance`（下記）

## SSE 耐久検証（Phase 0 のホスティング判定）

設計書 5.2 のとおり、**この検証を通らないホスティングは採用しない**。通らない場合は
Phase 1 開始前に非同期生成方式へ設計を切り替える。

```bash
CHAPTERFLOW_WEB_SSE_PROBE_TOKEN=<token> npm run sse:endurance -- --url https://<候補ホスト> --seconds 600
```

exit 0 なら採用可。早期切断・バッファリング・タイムアウトのいずれかを検出すると
exit 1 と判定理由を出す。プローブは検証専用なので、**一般公開前にトークンを外して無効化する**。

## Phase 1 でやること

設計書 13 Phase 1 のとおり。実装前に設計書 15 の未決定事項（認証事業者、PostgreSQL、
Secret Manager、ホスティング、メール送信事業者）を決める必要がある。

- マネージド認証、Cookie セッション、ログイン／ログアウト画面
- 認証事業者の失効機能を正本にするか `sessions` テーブルを持つかの決定
- `UserContext` を Web API の入口からストレージ層まで必須で渡す
  - 現状 Electron 側は `localProjectStorage()` で固定コンテキストを束縛している。
    `localProjectStorage(` を grep すると、リクエスト由来のコンテキストへ
    差し替える必要がある箇所が一覧できる。
- PostgreSQL スキーマとマイグレーション
- 所有権テスト（2ユーザーでの負の認可テスト）
