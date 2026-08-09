import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CanonSettingsSection, {
  reapplyContractDraft,
} from '../../src/client/components/CanonSettingsSection';
import { api, ApiError } from '../../src/client/clientApi';

vi.mock('../../src/client/clientApi', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public readonly code?: string,
      public readonly retryable = false,
      public readonly status = 0,
      _options?: ErrorOptions,
      public readonly body?: Record<string, unknown>
    ) {
      super(message);
    }
  },
  api: {
    getCreativeContract: vi.fn(),
    getCanonSummary: vi.fn(),
    updateState: vi.fn(),
    resolveCanonConflict: vi.fn(),
  },
}));

const contract = {
  schemaVersion: 1,
  projectId: 'project-1',
  revision: 1,
  items: [],
  exceptions: [],
  verificationMode: 'strict',
  updatedAt: '2026-08-08T00:00:00.000Z',
};

const shieldedSummary = {
  revision: 1,
  spoilerMode: 'shielded' as const,
  latentSeedStatus: 'ok' as const,
  revealed: [],
  pendingConflicts: [],
  hidden: {
    total: 1,
    byScope: { world: 1, character: 0, relationship: 0, history: 0, plot: 0, other: 0 },
  },
  retired: {
    total: 0,
    byScope: { world: 0, character: 0, relationship: 0, history: 0, plot: 0, other: 0 },
    items: [],
  },
};

const visibleSummary = {
  ...shieldedSummary,
  spoilerMode: 'visible' as const,
  items: [
    {
      canonId: 'canon-1',
      scope: 'world' as const,
      statement: 'A hidden world detail.',
      status: 'provisional' as const,
      baseStatusWithoutEvidence: 'provisional' as const,
      epistemicStatus: 'fact' as const,
      source: 'setup' as const,
      manualLock: false,
      evidence: [],
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    },
  ],
};

const pendingConflict = {
  conflictId: 'conflict-1',
  kind: 'revealed-canon' as const,
  summary: 'A conflict needs a decision.',
  evidenceExcerpt: 'Evidence.',
  status: 'pending' as const,
  generationId: 'generation-1',
  createdAt: '2026-08-08T00:00:00.000Z',
};

describe('CanonSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCreativeContract).mockResolvedValue(contract as never);
    vi.mocked(api.getCanonSummary)
      .mockResolvedValueOnce(shieldedSummary as never)
      .mockResolvedValueOnce(visibleSummary as never);
    vi.mocked(api.updateState).mockResolvedValue({} as never);
    vi.mocked(api.resolveCanonConflict).mockResolvedValue(shieldedSummary as never);
  });

  it('switches to visible mode before opening shielded hidden canon', async () => {
    render(
      <CanonSettingsSection
        projectId="project-1"
        onError={vi.fn()}
        onFlashMessage={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: '内容を見る' }));

    await waitFor(() =>
      expect(api.updateState).toHaveBeenCalledWith('project-1', {
        uiState: { canonSpoilerMode: 'visible' },
      })
    );
    expect(await screen.findByRole('button', { name: '内容を表示' })).toBeInTheDocument();
  });

  it('refetches and reapplies a canon conflict action after a revision conflict', async () => {
    const staleSummary = { ...shieldedSummary, pendingConflicts: [pendingConflict] };
    const freshSummary = { ...staleSummary, revision: 2 };
    const resolvedSummary = { ...freshSummary, pendingConflicts: [] };
    vi.mocked(api.getCanonSummary)
      .mockReset()
      .mockResolvedValueOnce(staleSummary as never)
      .mockResolvedValueOnce(freshSummary as never);
    vi.mocked(api.resolveCanonConflict)
      .mockRejectedValueOnce(
        new ApiError('The canon has changed.', 'canon_revision_conflict', true, 409, undefined, {
          code: 'canon_revision_conflict',
        })
      )
      .mockResolvedValueOnce(resolvedSummary as never);

    render(
      <CanonSettingsSection
        projectId="project-1"
        onError={vi.fn()}
        onFlashMessage={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: '解決方法を選ぶ' }));
    fireEvent.click(screen.getByRole('button', { name: '誤検出として解決済みにする' }));

    await waitFor(() =>
      expect(api.resolveCanonConflict).toHaveBeenNthCalledWith(2, 'project-1', 'conflict-1', {
        revision: 2,
        status: 'resolved',
      })
    );
  });

  it('rebases non-overlapping contract edits onto the latest contract', () => {
    const baseItem = {
      contractId: 'contract-1',
      kind: 'promise' as const,
      strength: 'hard' as const,
      text: 'Original text',
      source: 'user' as const,
      status: 'active' as const,
    };
    const latestItem = { ...baseItem, status: 'disabled' as const };
    const rebased = reapplyContractDraft({
      baseItems: [baseItem],
      draftItems: [
        { ...baseItem, text: 'Edited locally' },
        { ...baseItem, contractId: 'contract-2', text: 'Added locally' },
      ],
      latestItems: [
        latestItem,
        { ...baseItem, contractId: 'contract-3', text: 'Added elsewhere' },
      ],
      baseMode: 'strict',
      draftMode: 'fast',
      latestMode: 'strict',
    });

    expect(rebased).toMatchObject({
      hasConflicts: false,
      verificationMode: 'fast',
      items: [
        { contractId: 'contract-1', text: 'Edited locally', status: 'disabled' },
        { contractId: 'contract-3', text: 'Added elsewhere' },
        { contractId: 'contract-2', text: 'Added locally' },
      ],
    });
  });

  it('keeps a concurrent contract field change for explicit review', () => {
    const baseItem = {
      contractId: 'contract-1',
      kind: 'promise' as const,
      strength: 'hard' as const,
      text: 'Original text',
      source: 'user' as const,
      status: 'active' as const,
    };
    const rebased = reapplyContractDraft({
      baseItems: [baseItem],
      draftItems: [{ ...baseItem, text: 'Edited locally' }],
      latestItems: [{ ...baseItem, text: 'Edited elsewhere' }],
      baseMode: 'strict',
      draftMode: 'strict',
      latestMode: 'strict',
    });

    expect(rebased.hasConflicts).toBe(true);
    expect(rebased.items[0].text).toBe('Edited elsewhere');
  });

  it('flags a local edit when the latest contract removed its item', () => {
    const baseItem = {
      contractId: 'contract-1',
      kind: 'promise' as const,
      strength: 'hard' as const,
      text: 'Original text',
      source: 'user' as const,
      status: 'active' as const,
    };
    const rebased = reapplyContractDraft({
      baseItems: [baseItem],
      draftItems: [{ ...baseItem, text: 'Edited locally' }],
      latestItems: [],
      baseMode: 'strict',
      draftMode: 'strict',
      latestMode: 'strict',
    });

    expect(rebased).toMatchObject({ hasConflicts: true, items: [] });
  });
});
