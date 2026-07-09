import path from 'node:path';
import os from 'node:os';

// NOTE: サービス層のテストが実データ(data/ や YUMEWEAVING_DATA_DIR の実行値)を
// 汚染しないよう、src/server/config.ts が import される前に一時ディレクトリへ向ける。
// ??= ではなく無条件代入にしているのは、シェルに実データを指す YUMEWEAVING_DATA_DIR が
// 残っていた場合にテストが本物の執筆データを書き換える事故を防ぐため。
// setupFiles は各テストファイルの import より先に実行されるので、ここで代入すれば
// config.ts のモジュール初期化に間に合う。ディレクトリの掃除は tests/globalSetup.ts。
// ワーカーごとに分けることで、並列テストが同じ projects/ をコピー/削除する競合を避ける。
const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 'main';
process.env.YUMEWEAVING_DATA_DIR = path.join(os.tmpdir(), 'yumeweaving-vitest', workerId);

import '@testing-library/jest-dom';
