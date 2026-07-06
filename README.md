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

## ビルド

```bash
npm run build
```

## スマホから使う (Phase A: LAN配信)

同じ Wi-Fi 上のスマホから使う簡易モード。PCが起動している間だけ使えます。

```bash
npm run build:start:lan
```

または `start-yumeweaving-lan.bat` をダブルクリック。

起動ログに表示される `http://<PCのLAN IP>:3001` をスマホのブラウザで開いてください。

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

- 作品データ: `data/projects/`
- APIキーなど機密設定: `data/config/`（Git管理対象外）
