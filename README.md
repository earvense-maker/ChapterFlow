# Yumeweaving

自分専用の連載小説を、その場の気分で進めるローカルWebアプリ。

## 必要環境

- Node.js 20+
- OpenAI APIキー または Gemini APIキー（生成を利用する場合）

## セットアップ

```bash
npm install
```

## 開発サーバー起動

```bash
npm run dev
```

ブラウザで http://localhost:5173 を開く。

## ビルド

```bash
npm run build
```

## テスト

```bash
npm test
npm run test:e2e
```

## 設定

初回起動後、作品設定画面または `data/config/credentials.json` にOpenAI/Gemini APIキーを保存してください。APIキーは作品データとは別に管理されます。

## データ保存場所

- 作品データ: `data/projects/`
- APIキーなど機密設定: `data/config/`（Git管理対象外）
