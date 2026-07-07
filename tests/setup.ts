import path from 'node:path';
import os from 'node:os';

// NOTE: サービス層のテストが実データ(data/ や YUMEWEAVING_DATA_DIR の実行値)を
// 汚染しないよう、src/server/config.ts が import される前に一時ディレクトリへ向ける。
// ??= ではなく無条件代入にしているのは、シェルに実データを指す YUMEWEAVING_DATA_DIR が
// 残っていた場合にテストが本物の執筆データを書き換える事故を防ぐため。
// setupFiles は各テストファイルの import より先に実行されるので、ここで代入すれば
// config.ts のモジュール初期化に間に合う。ディレクトリの掃除は tests/globalSetup.ts。
process.env.YUMEWEAVING_DATA_DIR = path.join(os.tmpdir(), 'yumeweaving-vitest');

import '@testing-library/jest-dom';
