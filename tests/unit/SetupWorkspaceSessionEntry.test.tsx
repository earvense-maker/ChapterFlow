import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SetupWorkspace from '../../src/client/components/SetupWorkspace';
import { rememberSetupSession } from '../../src/client/components/setupWorkspace/sessionStorage';
import type { SetupSession } from '../../src/shared/types';

const apiMock = vi.hoisted(() => ({
  getNotificationSettings: vi.fn(),
  getPresets: vi.fn(),
  getModelProviders: vi.fn(),
  getDefaultModelSettings: vi.fn(),
  createSetupSession: vi.fn(),
  getSetupSession: vi.fn(),
  listSetupSessions: vi.fn(),
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));

const now = '2026-08-28T00:00:00.000Z';

function makeSession(sessionId: string): SetupSession {
  return {
    schemaVersion: 1,
    sessionId,
    projectId: null,
    status: 'active',
    revision: 0,
    purpose: 'roleplay',
    experienceMode: 'standard',
    model: { provider: 'gemini', modelName: 'gemini-test' },
    projectSettings: {
      title: '',
      outputLength: 3000,
      streamingEnabled: false,
      activePresetIds: {},
    },
    messages: [],
    draft: {
      coreConcept: '',
      confirmed: [],
      candidates: [],
      undecided: [],
      characters: [],
      relationshipSeeds: [],
      world: [],
      tone: [],
      ng: [],
      openingSeeds: [],
      scenarioSeeds: [],
      quickContracts: [],
    },
    locks: [],
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function renderWorkspace(resumeExistingSession: boolean) {
  return render(
    <SetupWorkspace
      purpose="roleplay"
      experienceMode="standard"
      resumeExistingSession={resumeExistingSession}
      onCreated={() => undefined}
      onCancel={() => undefined}
      onOpenSettings={() => undefined}
    />
  );
}

describe('SetupWorkspace initial session selection', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    apiMock.getNotificationSettings.mockResolvedValue(null);
    apiMock.getPresets.mockResolvedValue({ categories: {} });
    apiMock.getModelProviders.mockResolvedValue([]);
    apiMock.getDefaultModelSettings.mockResolvedValue(null);
    apiMock.listSetupSessions.mockResolvedValue([]);
  });

  it('starts a clean session from an explicit new-work entry even when an old session is stored', async () => {
    const oldSession = makeSession('setup-old-work');
    const newSession = makeSession('setup-new-work');
    rememberSetupSession(oldSession.sessionId, 'roleplay', 'standard');
    apiMock.getSetupSession.mockResolvedValue(oldSession);
    apiMock.createSetupSession.mockResolvedValue({
      sessionId: newSession.sessionId,
      session: newSession,
    });

    renderWorkspace(false);

    await waitFor(() => expect(apiMock.createSetupSession).toHaveBeenCalledTimes(1));
    expect(apiMock.getSetupSession).not.toHaveBeenCalled();
    expect(apiMock.listSetupSessions).not.toHaveBeenCalled();
    expect(apiMock.createSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'roleplay' })
    );
  });

  it('restores the current session when returning to an in-progress setup', async () => {
    const currentSession = makeSession('setup-current-work');
    rememberSetupSession(currentSession.sessionId, 'roleplay', 'standard');
    apiMock.getSetupSession.mockResolvedValue(currentSession);

    renderWorkspace(true);

    await waitFor(() =>
      expect(apiMock.getSetupSession).toHaveBeenCalledWith(currentSession.sessionId)
    );
    expect(apiMock.createSetupSession).not.toHaveBeenCalled();
  });
});
