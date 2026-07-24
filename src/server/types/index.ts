export * from '../../shared/types/index.js';
export * from '../../shared/defaults.js';

export interface SaveCredentialsBody {
  provider: string;
  apiKey: string;
}
