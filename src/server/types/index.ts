export * from '../../shared/types.js';

import type { ActivePresets, ProjectId } from '../../shared/types.js';

export interface CreateProjectBody {
  title?: string;
  activePresetIds?: Partial<ActivePresets>;
  duplicateFrom?: ProjectId;
}

export interface UpdateProjectBody {
  title?: string;
  outputLength?: number;
  activeModelProvider?: string;
  activeModelName?: string;
  activePresetIds?: Partial<ActivePresets>;
}

export interface SaveCredentialsBody {
  provider: string;
  apiKey: string;
}
