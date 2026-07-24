export type NgExpressionSource = 'manual' | 'report' | 'selection';
export type NgExpressionStatus = 'active' | 'archived';

export interface NgExpression {
  id: string;
  text: string;
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
