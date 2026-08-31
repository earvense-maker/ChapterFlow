import { JSON_TASK_MAX_OUTPUT_TOKENS } from '../utils/outputLength.js';
import type { AdapterGenerateRequest } from '../../shared/types/model.js';

export interface JsonTaskPolicyOptions {
  reasoningMode: 'enabled' | 'disabled';
  maxOutputTokens?: number;
}

export function applyJsonTaskPolicy(
  request: AdapterGenerateRequest,
  options: JsonTaskPolicyOptions
): AdapterGenerateRequest {
  return {
    ...request,
    responseMimeType: 'application/json',
    reasoningMode: options.reasoningMode,
    maxOutputTokens: options.maxOutputTokens ?? JSON_TASK_MAX_OUTPUT_TOKENS,
  };
}
