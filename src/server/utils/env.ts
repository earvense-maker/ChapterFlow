// NOTE: リネーム移行期間中は CHAPTERFLOW_* を優先しつつ旧 YUMEWEAVING_* も読む。
// 空白のみの値は「未設定」として次の候補へ倒す（?? と || の混在で挙動が
// エントリポイントごとに割れていたのを一本化）。移行期間終了時はこのヘルパーの
// 呼び出し箇所を検索すれば旧変数対応を一括除去できる。
export function readEnvWithLegacyFallback(
  newName: string,
  legacyName: string
): string | undefined {
  for (const name of [newName, legacyName]) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
