# Electron化 設計書

> 注記: 本文中の「Yumeweaving」は開発時の旧称です。正式名称は「ChapterFlow」です。

## 0. 背景と目的

Yumeweaving を「Node.js のインストール不要・ダブルクリックで起動する Windows デスクトップアプリ」として配布できるようにする。前提として『配布準備_設計書.md』の D2(データ保存先既定値)・D3(ライセンス)・D5(LAN認証)は実施済みか、本作業と並行して実施する。

### 設計原則: HTTPサーバー構成を維持し、クライアントを素のWebアプリのまま保つ

最終目標が「スマホ単体で完結するアプリ(データ同期なし、Capacitor 等での実現を想定)」であるため、以下を原則とする。

1. **Express サーバーはそのまま Electron の main プロセス内で起動**し、`BrowserWindow` は `http://127.0.0.1:<port>` を読み込む。IPC(`ipcRenderer` / `contextBridge`)への移植は行わない。
2. **React クライアントは Electron 固有 API に一切依存させない**。`window.electron` 等のグローバル注入を作らず、通信は従来どおり相対パス `/api/...` への fetch のみ。これによりクライアントは「ブラウザでも / Electron でも / 将来 Capacitor でも」無改造で動く。
3. Electron 固有の挙動(終了、外部リンク、メニュー)は main プロセス側とサーバーの既存エンドポイントだけで完結させる。

この構成なら `file://` 配信に伴うパス問題・CORS 問題も発生しない(オリジンは常に `http://127.0.0.1`)。

対象コード:

- `src/server/index.ts`(起動処理の関数化 — 本設計の唯一のサーバー改修)
- `src/electron/main.ts`(新設)
- `tsconfig.electron.json`(新設)/ `tsconfig.server.json`
- `package.json`(scripts / electron-builder 設定 / devDependencies)
- `build/icon.ico`(新設)
- `open-app-window.js` / `/api/shutdown`(役割変更)

前提となる現状仕様:

- `npm run build` = `tsc -p tsconfig.server.json && vite build`。成果物は `dist/server`(CJS/ESM コンパイル済みJS)と `dist/client`(静的ファイル)。
- `src/server/index.ts` はモジュール読み込み時に `main()` を即時実行する。
- 静的配信は `PROJECT_ROOT/dist/client` を `existsSync` で検出して有効化。
- `/api/shutdown` は親プロセスへ SIGTERM を投げて自 exit する(dev の concurrently 連鎖終了用)。
- クライアントの API 呼び出しは `src/client/clientApi.ts` に集約されており、相対パスのみ。

---

## E1. サーバー起動の関数化(startServer)

**問題**: `index.ts` が import と同時に listen まで走るため、Electron main から「ポートを制御しつつ起動し、起動完了を待つ」ことができない。

**方針**: 起動ロジックを `startServer(options)` としてエクスポートし、CLI エントリを薄い別ファイルに分離する。既存の `npm start` / LAN モード / dev の挙動は変えない。

**実装**:

1. `src/server/app.ts` 新設(または `index.ts` 内で分割): Express アプリ組み立て(ミドルウェア・ルーター・静的配信・エラーハンドラ)を `createApp(options)` に切り出す。
2. `src/server/server.ts` 新設:
   ```ts
   export interface StartServerOptions {
     port?: number;        // 0 で空きポート自動割当
     host?: string;
     onShutdownRequest?: () => void; // /api/shutdown の挙動差し替え
   }
   export interface RunningServer {
     port: number;         // 実際に listen したポート
     close(): Promise<void>;
   }
   export async function startServer(options?: StartServerOptions): Promise<RunningServer>
   ```
   - `ensureDir(DATA_DIR)` → `app.listen` を Promise 化し、`server.address()` から実ポートを返す。
   - `EADDRINUSE` は reject(D7 の日本語メッセージは CLI エントリ側で表示)。
3. `src/server/index.ts` は CLI エントリとして残す: env から port/host を読み、`startServer` を呼び、従来のログ(LAN URL 表示等)を出す。**既存の bat / start:lan / dev の動線は無改修で動く**。
4. `/api/shutdown`(`routes/system.ts`): `onShutdownRequest` が渡されていればそれを呼ぶ。未指定時は現行挙動(親へ SIGTERM → exit)。ルーターがオプションを受け取れるよう、`createApp` からファクトリ関数 `createSystemRouter(options)` に変更する。
5. **CORS 許可リストの構築タイミング**: 現行の許可オリジンはモジュールスコープで `PORT` env から構築される(`index.ts:20-49`)が、`port: 0` では実ポートが listen 後まで確定しない。`createApp` 化にあわせて origin 判定を関数化し、「**オリジンの hostname が `127.0.0.1` / `localhost` / `[::1]` ならポート不問で許可**」に変更する(URL パースで判定)。LAN 用の許可オリジン(env 明示・LAN IPv4 自動追加)は現行ロジックを維持する。既存コードの NOTE は LAN で Origin 問題を実際に踏んだ形跡なので、この経路のテストを落とさないこと。

**受け入れ条件**:

- `npm run dev` / `npm start` / `npm run start:lan` の挙動が従来と同一。
- `startServer({ port: 0 })` が空きポートで起動し、実ポートを返す。
- ユニットテスト: port 0 起動 → fetch 疎通 → close。

## E2. Electron main プロセス

**問題**: なし(新設)。

**方針**: main は「サーバーを起動して、そのURLをウィンドウで開く」だけの薄い層に保つ。renderer への preload 注入はしない。

**実装** — `src/electron/main.ts`:

1. **単一インスタンスロック**: `app.requestSingleInstanceLock()` に失敗したら即 quit。二重起動で同一データディレクトリに2つのサーバーが書き込む事故を防ぐ。`second-instance` イベントでは既存ウィンドウをフォーカス。
2. **データディレクトリ**: `YUMEWEAVING_DATA_DIR` が未設定なら何もしない(D2 の既定 = `Documents\Yumeweaving` に任せる)。
   - NOTE: `app.getPath('userData')` ではなく D2 の既定に乗る。理由: (a) zip 配布版・LAN 単体起動と同じ場所を指し、移行が発生しない (b) 創作物はユーザー可視の場所に置く方針(D2)と一貫する。
3. **サーバー起動とポートの永続化**: `app.whenReady()` 後に `startServer({ host: '127.0.0.1', onShutdownRequest: () => app.quit() })` を呼ぶ。ポートは**初回のみ `port: 0` で空きポートを確保し、`{DATA_DIR}/config/server-port.json` に保存して次回以降は同じポートを再利用**する。保存ポートが取得できない場合(他プロセスが使用中)は `port: 0` で取り直して保存を更新する。
   - **毎回ランダムポートにしてはいけない理由**: `localStorage` と Service Worker キャッシュはオリジン(スキーム+ホスト+**ポート**)単位。クライアントは localStorage を実際に使っており(テーマ設定 `useTheme.ts:11`、セットアップセッションの復帰 `SetupWorkspace.tsx:2240`)、ポートが変わると毎起動でテーマがリセットされ、中断したセットアップが再開できなくなる。さらに `sw.js` は PROD ビルドで登録される(`127.0.0.1` は secure context)ため、起動ごとに別オリジンの SW キャッシュが Electron プロファイルへ蓄積する。
   - ポート固定はプロファイル汚染も防ぎつつ、初回自動割当により既存の 3001(zip版との併用や別アプリ)との衝突回避という狙いも保つ。
   - 起動失敗時は `dialog.showErrorBox` で日本語メッセージを出して quit。
4. **ウィンドウ生成**:
   ```ts
   new BrowserWindow({
     width: 1180, height: 860,           // 現 open-app-window.js と同値
     show: false,                        // ready-to-show まで隠して白画面フラッシュを回避
     icon: build/icon.ico,
     webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
   })
   ```
   preload なし。`win.loadURL('http://127.0.0.1:' + server.port)`、`ready-to-show` で `win.show()`。
   - ウィンドウ位置・サイズは閉じる時に `{DATA_DIR}/config/window-state.json` へ保存し、次回復元する自前実装とする。ただし**最大化状態の保存**と**画面外復元のガード**(保存座標がどのディスプレイにも含まれない場合は既定位置に戻す。`screen.getAllDisplays()` で判定)まで含めること。この2点を省くと「モニタ構成を変えたらウィンドウが行方不明」という典型不具合になる。
5. **外部リンク**: `win.webContents.setWindowOpenHandler` で `http(s)://127.0.0.1` 以外は `shell.openExternal` に流して `deny`(APIキー取得ページ等のリンクを既定ブラウザで開くため)。`will-navigate` も同様にガード。
6. **終了系**: `window-all-closed` で `app.quit()`(Windows 専用配布のため macOS 分岐は不要)。graceful close は **`before-quit` の async リスナーでは実現できない**(Electron はリスナーの Promise を待たない)。次のパターンを用いる:
   ```ts
   let closing = false;
   app.on('before-quit', (event) => {
     if (closing) return;          // 再入ガード(close 完了後の app.exit を素通し)
     event.preventDefault();
     closing = true;
     server.close().finally(() => app.exit(0));
   });
   ```
   `safeWrite` の書き込みを中断させないため、close を待ってから終了する価値がある。クライアントの「終了」ボタン → `/api/shutdown` → `onShutdownRequest` → `app.quit()` の経路が E1 で成立している。
7. **メニュー**: 既定メニューを削除(`Menu.setApplicationMenu(null)`)し、`Ctrl+Shift+I` で DevTools、`Ctrl+R` でリロードだけ `before-input-event` で残す(サポート用)。

**受け入れ条件**:

- exe 起動 → ウィンドウが開き、作品一覧が表示される。
- 二重起動すると2つ目は起動せず既存ウィンドウがフォーカスされる。
- 「終了」ボタンとウィンドウの×の両方でプロセスが完全終了する(タスクマネージャに node/electron が残らない)。
- 外部URLが既定ブラウザで開く。

## E3. ビルドパイプラインとパッケージング

**問題**: なし(新設)。

**方針**: electron-builder で NSIS インストーラ + ポータブル exe の2形態を生成。コード署名は行わない(SmartScreen 警告は利用ガイドで案内)。

**実装**:

1. **devDependencies 追加**: `electron`、`electron-builder`。あわせて既存 `dependencies` を見直す: **`react` / `react-dom` は vite がビルド時にバンドルするため実行時依存ではなく、devDependencies へ移動する**(現状のままだと zip 配布の `npm ci --omit=dev` と asar の両方に無駄に入る)。`express` / `cors` はサーバー実行時依存なので残す。`uuid` はサーバーコード(`utils/id.ts`)が実行時に使うため残す。
2. **tsconfig.electron.json 新設**: `src/electron/**` を `dist/electron/` へコンパイル。module 解決はサーバー側 tsconfig と揃える(`dist/server/server.js` を import するため、コンパイル後の相対パスに注意。`dist/` 直下で `electron/main.js` → `../server/server.js` となるよう rootDir/outDir を設計する)。
   - NOTE(ESM): package.json が `"type": "module"` のため main プロセスも ESM として動く。**ESM main は Electron 28+ が必須**(現行最新版なら問題なし)。tsconfig は `module: NodeNext` とし、import には `.js` 拡張子を明示すること(サーバー側コードと同じ流儀)。
3. **scripts**:
   - `"build:electron": "npm run build && tsc -p tsconfig.electron.json"`
   - `"dist:electron": "npm run build:electron && electron-builder --win"`
   - `"dev:electron": "npm run build:electron && electron dist/electron/main.js"`(E4 参照)
4. **electron-builder 設定**(package.json `"build"` セクション):
   ```jsonc
   {
     "appId": "com.yumeweaving.app",
     "productName": "Yumeweaving",
     "files": ["dist/**", "presets/**", "package.json"],
     "asar": true,
     "win": { "target": ["nsis", "portable"], "icon": "build/icon.ico" },
     "nsis": { "oneClick": true, "perMachine": false }
   }
   ```
   - `main` フィールド(package.json)を `dist/electron/main.js` に設定。
   - NOTE(asar): Electron は fs を asar 透過に差し替えるため、`express.static(dist/client)` と `presets` の `fs.readFile` は asar 内でも動くのが原則。ただし `res.sendFile` 系で問題が出た事例があるため、E6 の受け入れテストで確認し、不具合時は `"asarUnpack": ["dist/client/**", "presets/**"]` へ切り替える(設計上どちらでも PROJECT_ROOT 相対解決は維持される)。
   - NOTE(PROJECT_ROOT): `config.ts` の `PROJECT_ROOT` は `dist/server/config.js` から2階層上 = asar ルート直下を指し、`dist/client` / `presets` の解決はパッケージ内でそのまま成立する。DATA_DIR は D2 で既定が外部(Documents)になっているため asar 書き込み問題は発生しない。**D2 が未実施のまま Electron 化すると asar 内 `data/` への書き込みで即死するため、D2 は必須の先行作業**。
5. **アイコン**: `build/icon.ico`(256px まで多解像度)。未用意なら暫定でも必ず設定する(既定の Electron アイコンは配布物として不適)。
6. **バージョン表記**: package.json `version` をそのままアプリバージョンとして使用。タイトルバーまたは技術設定タブに表示(不具合報告との突き合わせ用。クライアントからは既存の `/api` に `GET /api/system/version` を足して取得 — Electron 固有APIに依存させない)。

**受け入れ条件**:

- `npm run dist:electron` でインストーラ(`Yumeweaving Setup x.y.z.exe`)とポータブル exe が生成される。
- Node.js がインストールされていない Windows 環境で、インストーラから起動して1話生成まで通る。
- インストール版のアンインストールで `Documents\Yumeweaving` が消えない。

## E4. 開発ワークフロー

**問題**: Electron 化後も、日常開発は HMR の効く現行 `npm run dev`(ブラウザ)で行いたい。

**方針**: 開発の主線は従来どおり `npm run dev`(vite + tsx watch + Chrome appモード)。Electron は「配布前の確認用」と割り切り、ホットリロード付き Electron 開発環境(electron-vite 等)は導入しない。

**実装**:

1. `npm run dev` は無改修で維持。`open-app-window.js` も dev 用として残す。
2. `npm run dev:electron` は E3 のとおりフルビルド後に Electron を起動する簡易版とする。Electron 固有挙動(ウィンドウ、終了、外部リンク)の確認にのみ使う。
3. README の開発セクションに两者の使い分けを1段落追記。

**受け入れ条件**: `npm run dev` の挙動・速度が従来と変わらない。

## E5. LAN モード(スマホ共有)の統合 — フェーズ後回し可

**問題**: Electron 配布版では bat が同梱されないため、LAN モードへの入口がなくなる。

**方針**: 技術設定タブに「スマホ共有」トグルを追加し、サーバーの再バインドで実現する。D5 のトークン認証を前提とする。**初回リリースには含めず、E1〜E4 安定後の追加フェーズとしてよい**(それまでは zip 版の LAN モードが代替)。

**実装(概要)**:

1. `POST /api/system/lan { enabled: boolean }` を新設。main 側で現サーバーを close → `startServer({ host: '0.0.0.0', port: 3001 })` で再起動(ウィンドウ側 URL は 127.0.0.1 のまま有効)。ポートは LAN 時のみ固定 3001(スマホから打ちやすいURLにするため)。
   - NOTE(ウィンドウ側オリジン): 再バインドでローカルの listen ポートも変わる場合、E2 で固定したポートを維持できるよう「0.0.0.0 で従来ポート + 3001 の両方を張る」か「0.0.0.0:従来ポートに一本化してスマホURLもそのポートにする」かを実装時に選ぶ。localStorage のオリジン安定(E2)を壊さないことが優先条件。
2. **エラーパス**: 3001 が他プロセスに使用されている場合、再バインドは失敗する。失敗時は**元の 127.0.0.1 バインドに戻して**トグルをOFF表示にし、エラーメッセージを返す(共有に失敗してアプリ全体が死ぬのは不可)。
3. **生成実行中のガード**: サーバー close は進行中の生成ストリーミングを切断する。生成中はトグルを無効化する(最低限、確認ダイアログで警告)。
4. レスポンスでトークン付きURLを返し、クライアントが QRコード表示(依存を1つ足すか、URL文字列表示だけでも可)。
5. 状態は `{DATA_DIR}/config/` に保存し、次回起動時に復元するかは作者判断(推奨: 復元しない。共有は明示操作の都度有効化)。

**受け入れ条件**: トグルONでスマホから接続でき、OFFで即座に接続不能になる。トークンなしアクセスは 401(D5)。3001 使用中のON操作が安全に失敗する。生成中にトグル操作できない。

## E6. 受け入れテスト(Electron 版)

D6(クリーン環境テスト)の Electron 版として、Node.js 未インストールの Windows で:

1. インストーラ実行 → 起動 → APIキー登録 → 1話生成 → 終了 → 再起動でデータ保持。
2. ポータブル exe 単体でも同様に動く。
3. SmartScreen 警告の突破手順(詳細情報 → 実行)が利用ガイドどおりである。
4. asar 内静的配信の全画面確認(リーダー・設定・相談モードの主要動線)。
5. 生成ストリーミング(SSE/チャンク応答)が Electron ウィンドウ内で正常動作する。
6. 「終了」後にタスクマネージャへプロセスが残らない。
7. **オリジン安定の検証**: 再起動をまたいでテーマ設定が保持され、中断したセットアップセッションが再開できる(E2 のポート永続化が効いている証拠)。

---

## 7. 決定事項(レビュー時に作者決定済み)

| # | 事項 | 決定 |
|---|---|---|
| 1 | 配布形態 | **NSIS インストーラ + ポータブル exe の両方** |
| 2 | アプリアイコン | 暫定でも独自アイコンを必ず設定(要作成) |
| 3 | E5(スマホ共有トグル) | **初回リリースには含めず後回し** |
| 4 | 自動更新 | **当面は手動更新**(公開リポジトリ化かサーバーが必要になるため) |

## 8. 実装順の推奨

1. **前提**: 配布準備 D2(データ保存先)完了 — E3 の NOTE のとおり必須。D5(LAN認証)は E5 まで不要。
2. **Phase 1**: E1(startServer 化) — 既存動線の非破壊を vitest で担保
3. **Phase 2**: E2(main プロセス)+ E4(dev:electron)で手元起動まで
4. **Phase 3**: E3(electron-builder)でインストーラ生成 → E6 のクリーン環境テスト
5. **Phase 4(任意)**: E5(スマホ共有トグル)、自動更新

## 9. 将来のスマホ単体アプリへの接続

本設計で守った不変条件が、そのまま Capacitor 移行の土台になる:

- クライアントは相対 `/api` fetch のみに依存 → Capacitor 移行時は `clientApi.ts` の1箇所で「ローカル実装(端末内ストレージ + 直接LLM呼び出し)」に差し替える設計余地が残る。
- サービス層(`src/server/services/`)は TypeScript のまま → ファイルI/O(`storageService` / `safeWrite`)を抽象化すれば端末ストレージへ移植可能。
- 逆に言えば、**今後の機能追加でも「クライアントに Electron 固有 API を混ぜない」「サービス層に Express 依存(req/res)を漏らさない」を守ること**が、スマホ化の工数を直接左右する。
