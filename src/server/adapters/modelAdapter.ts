import type {
  AdapterGenerateRequest,
  AdapterGenerateResult,
  AdapterGenerateStreamEvent,
  ConnectionStatus,
  ModelConfig,
} from '../types/index.js';

export interface ModelAdapter {
  readonly providerName: string;
  generateText(request: AdapterGenerateRequest): Promise<AdapterGenerateResult>;
  generateTextStream?(request: AdapterGenerateRequest): AsyncGenerator<AdapterGenerateStreamEvent>;
  validateConnection(config: ModelConfig): Promise<ConnectionStatus>;
}

export class ModelAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'ModelAdapterError';
  }
}
