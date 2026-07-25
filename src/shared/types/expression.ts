export type NgExpressionSource = 'manual' | 'report' | 'selection';
export type NgExpressionStatus = 'active' | 'archived';

export interface NgExpression {
  id: string;
  text: string;
  // NOTE: 局所リライト時に「代わりにどう書くか」として渡す。禁止だけを伝えると
  // モデルは着地先が無く、語を保ったまま否定形に逃げる。未設定でもリライトは
  // 動くが、指定があるほど一発で通りやすい。
  alternatives?: string[];
  source: NgExpressionSource;
  status: NgExpressionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ExpressionsFile {
  schemaVersion: 1;
  ngExpressions: NgExpression[];
}

export interface NgExpressionsResponse {
  ngExpressions: NgExpression[];
}

// NOTE: アプリ全体設定。書き換えはトークンを使い本文も変わるので、既定は無効にして
// 明示的に有効化させる。上限を設定項目にしているのは、1回の生成で何件まで自動で
// 直すかがそのまま課金額の上限になるため（ユーザーが握れるようにしておく）。
export interface NgAutoRewriteSettings {
  enabled: boolean;
  maxRewritesPerGeneration: number;
}

export const NG_AUTO_REWRITE_MIN_LIMIT = 1;
export const NG_AUTO_REWRITE_MAX_LIMIT = 10;

export interface NgRewriteRequestBody {
  expressionId: string;
  /** 本文上の開始位置。サーバー側で中身を検算するので、ずれていれば 409 になる。 */
  start: number;
  end: number;
}

export interface NgRewriteResult {
  generationId: string;
  /** 書き換え後の本文全体 */
  text: string;
  expressionText: string;
  /** 書き換え対象になった一文（書き換え前） */
  before: string;
  /** 書き換え後の一文 */
  after: string;
  /** 再チェックで弾いてやり直した回数を含む、モデル呼び出し回数 */
  attempts: number;
}
