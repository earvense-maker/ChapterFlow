import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuickSetupWorkspace from '../../src/client/components/QuickSetupWorkspace';
import type { SetupCommitPlan, SetupSession } from '../../src/shared/types';

const apiMock = vi.hoisted(() => ({
  createSetupSession: vi.fn(),
  createQuickSetupPlan: vi.fn(),
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));

const now = '2026-08-28T00:00:00.000Z';

function makeSession(): SetupSession {
  return {
    schemaVersion: 1,
    sessionId: 'setup-quick-current',
    projectId: null,
    status: 'active',
    revision: 1,
    purpose: 'roleplay',
    setupMode: 'quick',
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

function renderWorkspace(onOpenFullSetup = vi.fn()) {
  render(
    <QuickSetupWorkspace
      purpose="roleplay"
      experienceMode="standard"
      onCreated={() => undefined}
      onCancel={() => undefined}
      onOpenFullSetup={onOpenFullSetup}
    />
  );
  return onOpenFullSetup;
}

describe('QuickSetupWorkspace full-setup handoff', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('requests a fresh full setup before a quick session has been created', () => {
    const onOpenFullSetup = renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: '詳細を自分で決める' }));

    expect(onOpenFullSetup).toHaveBeenCalledWith(false);
  });

  it('requests resuming the quick session after its plan has been created', async () => {
    const session = makeSession();
    const plan = { world: {} } as SetupCommitPlan;
    apiMock.createSetupSession.mockResolvedValue({ sessionId: session.sessionId, session });
    apiMock.createQuickSetupPlan.mockResolvedValue({ session, plan, revision: session.revision });
    const onOpenFullSetup = renderWorkspace();

    fireEvent.change(screen.getByLabelText('見たいキャラクター・関係・雰囲気'), {
      target: { value: '静かな図書館で話すキャラクター' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'この一文で作品を作る' }));
    await screen.findByRole('heading', { name: '作品の約束（確認）' });
    fireEvent.click(screen.getByRole('button', { name: '詳細を自分で決める' }));

    await waitFor(() => expect(onOpenFullSetup).toHaveBeenCalledWith(true));
  });
});
