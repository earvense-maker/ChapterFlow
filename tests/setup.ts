import path from 'node:path';
import os from 'node:os';

// NOTE: サービス層のテストが実データ(data/ や CHAPTERFLOW_DATA_DIR の実行値)を
// 汚染しないよう、src/server/config.ts が import される前に一時ディレクトリへ向ける。
// ??= ではなく無条件代入にしているのは、シェルに実データを指す CHAPTERFLOW_DATA_DIR が
// 残っていた場合にテストが本物の執筆データを書き換える事故を防ぐため。
// setupFiles は各テストファイルの import より先に実行されるので、ここで代入すれば
// config.ts のモジュール初期化に間に合う。ディレクトリの掃除は tests/globalSetup.ts。
// ワーカーごとに分けることで、並列テストが同じ projects/ をコピー/削除する競合を避ける。
const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 'main';
process.env.CHAPTERFLOW_DATA_DIR = path.join(os.tmpdir(), 'chapterflow-vitest', workerId);

// NOTE: 開発診断は既定オフがリリース版の前提。シェルに残った値でテストが
// 「オフのはずの経路」を検証できなくなるのを防ぐため、明示的に消してから始める。
// 有効時の挙動を見るテストは自分で立てて afterEach で戻す。
delete process.env.CHAPTERFLOW_DEV_DIAGNOSTICS;

import '@testing-library/jest-dom';

// NOTE: Reader のスクロール復元を検証するテストで、jsdom 未実装の警告だけが
// 出続けないようにする。実ブラウザでの挙動は E2E テスト側で確認する。
Object.defineProperty(window, 'scrollTo', {
  configurable: true,
  value: () => undefined,
});
