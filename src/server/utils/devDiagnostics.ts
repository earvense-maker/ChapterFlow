// NOTE: 生成の詳細診断（タイミング計測 telemetry と推論本文スナップショット）は
// 開発時の切り分け専用。配布する Electron 版に載せないため既定は「無効」にし、
// 明示的に環境変数を立てたときだけ有効化する。
// 「本番だけ無効」ではなく「既定で無効」にしているのは、electron-builder で
// 固めた exe は NODE_ENV も app.isPackaged もサーバー側コードから見えず、
// 判定漏れがそのまま利用者の保存先へ推論ログを書く事故になるため。
// 開発ループでは scripts/dev-server.mjs がこの変数を自動で立てる。
export const DEV_DIAGNOSTICS_ENV = 'CHAPTERFLOW_DEV_DIAGNOSTICS';

const ENABLED_VALUES = new Set(['1', 'true', 'on', 'yes']);

// NOTE: モジュール初期化時ではなく毎回 process.env を読む。テストが個別に
// 切り替えられるようにするためで、呼び出し頻度は生成1回につき数回しかない。
export function isDevDiagnosticsEnabled(): boolean {
  const raw = process.env[DEV_DIAGNOSTICS_ENV]?.trim().toLowerCase();
  return raw ? ENABLED_VALUES.has(raw) : false;
}
