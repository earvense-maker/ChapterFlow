# Yumeweaving

自分専用の連載小説を、その場の気分で進めるローカルWebアプリ。

## 必要環境

- Node.js 20+
- Gemini / DeepSeek / OpenAI のAPIキー（生成を利用する場合）

## セットアップ

```bash
npm install
```

## 開発サーバー起動

```bash
npm run dev
```

http://localhost:5173 をChrome/Edgeの独立したアプリ風ウィンドウで開きます。

通常のブラウザで確認したい場合は、手動で http://localhost:5173 を開いてください。

Electron版の挙動確認は、フルビルド後にデスクトップウィンドウを起動します。日常開発はHMRが効く `npm run dev` を使い、配布前の終了処理・ウィンドウ復元・外部リンク確認にこちらを使います。

```bash
npm run dev:electron
```

## ビルド

```bash
npm run build
```

Electron配布物を作る場合は、NSISインストーラとポータブルexeを生成します。

```bash
npm run dist:electron
```

## 配布 zip 作成

配布前に `package.json` の `version` を上げてから実行します。不具合報告と配布物を突き合わせるため、配布ごとにバージョンを更新してください。

```bash
npm run package
```

成果物は `release/yumeweaving-v<version>.zip` に作成されます。
配布 zip 内の起動ファイルは `Start-Yumeweaving.bat`、スマホ共有用は `Start-Yumeweaving-LAN.bat` です。

## スマホから使う (Phase A: LAN配信)

同じ Wi-Fi 上のスマホから使う簡易モード。PCが起動している間だけ使えます。

```bash
npm run build:start:lan
```

または `start-yumeweaving-lan.bat` をダブルクリック。

起動ログに表示される `http://<PCのLAN IP>:3001/?token=...` をスマホのブラウザで開いてください。トークン付きURLを一度開くと、以後はCookieで認証されます。

初回起動時に Windows ファイアウォールのダイアログが出たら **プライベートネットワーク** を許可してください(パブリックは不要)。

環境変数:
- `YUMEWEAVING_HOST` — バインドアドレス(既定 `127.0.0.1`、LANモードでは `0.0.0.0`)
- `YUMEWEAVING_ALLOWED_ORIGINS` — CORS 許可オリジンをカンマ区切りで明示指定(未指定時は localhost + 自分のLAN IPv4 を自動許可)

## テスト

```bash
npm test
npm run test:e2e
```

## 設定

初回起動後、作品設定画面または `data/config/credentials.json` にGemini / DeepSeek / OpenAI のAPIキーを保存してください。APIキーは作品データとは別に管理されます。

## データ保存場所

- 通常起動・配布起動の作品データ: `%USERPROFILE%\Documents\Yumeweaving\projects\`
- 通常起動・配布起動のAPIキーなど機密設定: `%USERPROFILE%\Documents\Yumeweaving\config\`
- 素の `npm run dev` の開発用データ: `data/`

APIキーは `config/credentials.json` に平文で保存されます。バックアップや共有時は扱いに注意してください。
