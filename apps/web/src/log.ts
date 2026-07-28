import crypto from 'node:crypto';

export interface RequestLogFields {
  requestId: string;
  method: string;
  /** ルート定義のパス。クエリ文字列は秘密情報が載り得るので入れない。 */
  route: string;
  status: number;
  durationMs: number;
  /** 利用者を特定できない形の識別子。未ログイン時は null。 */
  userHash?: string | null;
  /** 例外の分類のみ。メッセージ本文は入れない。 */
  errorCode?: string;
}

/**
 * 運用ログ（設計書 5.1）。
 *
 * NOTE: 本文・プロンプト・APIキー・メールアドレスを絶対に入れない。ここを通さない
 * `console.log` を足すと方針が崩れるので、Web版のリクエストログはこの関数に集約する。
 */
export function logRequest(fields: RequestLogFields): void {
  process.stdout.write(`${JSON.stringify({ type: 'request', ...fields })}\n`);
}

/**
 * ログ用のパス。
 *
 * NOTE: `req.path` は `app.use('/api', ...)` のマウント中にマウント接頭辞が外れた値になり、
 * 障害調査でどのAPIか分からなくなる。接頭辞を保つ `originalUrl` から、秘密情報が
 * 載り得るクエリ文字列だけを落として使う（設計書 プライバシー方針）。
 */
export function stripQuery(originalUrl: string): string {
  const queryIndex = originalUrl.indexOf('?');
  return queryIndex === -1 ? originalUrl : originalUrl.slice(0, queryIndex);
}

export function logError(requestId: string, errorCode: string, error: unknown): void {
  // NOTE: スタックは出すが message は出さない。外部API由来の例外メッセージに、
  // 送信したプロンプトやキーの断片が含まれることがある。
  const stack = error instanceof Error ? sanitizeStack(error) : undefined;
  process.stderr.write(
    `${JSON.stringify({ type: 'error', requestId, errorCode, name: errorName(error), stack })}\n`
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function sanitizeStack(error: Error): string | undefined {
  if (!error.stack) return undefined;
  // NOTE: stack の1行目は "Name: message" なので落とす。
  return error.stack.split('\n').slice(1).join('\n');
}

/**
 * ログ用のユーザー識別子。
 *
 * NOTE: salt なしの生ハッシュは、認証事業者のIDやメールアドレスのように候補集合が
 * 推測できる値だと総当たりで戻せてしまう。salt が設定されていない環境では
 * ハッシュを出さず null を返し、「弱い匿名化のまま出力する」状態を作らない。
 */
export function hashUserId(userId: string, salt: string | null): string | null {
  if (!salt) return null;
  return crypto.createHmac('sha256', salt).update(userId).digest('hex').slice(0, 16);
}
