import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RefineChatPanel, {
  formatCharacterPatchValue,
} from '../../src/client/components/RefineChatPanel';
import type { RefineScanResult, RefineSession } from '../../src/shared/types';

const apiMock = vi.hoisted(() => ({
  getRefineSession: vi.fn(),
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));

const emptySession: RefineSession = {
  schemaVersion: 2,
  sessionId: 'refine-session',
  projectId: 'project-refine-ui',
  usedModel: { provider: 'gemini', modelName: 'gemini-test' },
  messages: [],
  patches: [],
  revision: 0,
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  lastError: null,
};

describe('formatCharacterPatchValue', () => {
  it('formats trait arrays and indents continuation lines', () => {
    expect(
      formatCharacterPatchValue([
        { label: 'こだわり', text: '一行目\n二行目' },
        { label: '動機', text: '故郷へ帰る' },
      ])
    ).toBe('こだわり: 一行目\n  二行目\n動機: 故郷へ帰る');
  });

  it('shows an explicit empty marker for clearing traits', () => {
    expect(formatCharacterPatchValue([])).toBe('（なし）');
  });
});

describe('RefineChatPanel evidence display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getRefineSession.mockResolvedValue(emptySession);
  });

  it('shows accepted-scene evidence and includes it in the consultation draft', async () => {
    render(
      <RefineChatPanel
        projectId="project-refine-ui"
        characters={[]}
        refineScan={scanWithEvidence()}
        scanning={false}
        scanError={null}
        onScanRefine={() => undefined}
        onSettingsChanged={() => undefined}
      />
    );

    expect(await screen.findByText('根拠（採用本文）')).toBeVisible();
    expect(screen.getByText('場面 scene-evidence: 「主人公は真実を知った。」')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'この気づきを相談' }));

    const input = screen.getByPlaceholderText('世界設定や人物設定について、変えたい点や足したい点を書いてください');
    expect((input as HTMLTextAreaElement).value).toContain('根拠（採用本文）:');
    expect((input as HTMLTextAreaElement).value).toContain('主人公は真実を知った。');
  });

  it('does not render a zero when evidence is an empty array', async () => {
    const scan = scanWithEvidence();
    scan.findings[0].evidence = [];
    const { container } = render(
      <RefineChatPanel
        projectId="project-refine-ui"
        characters={[]}
        refineScan={scan}
        scanning={false}
        scanError={null}
        onScanRefine={() => undefined}
        onSettingsChanged={() => undefined}
      />
    );

    await waitFor(() => expect(container.querySelector('.refine-finding')).not.toBeNull());
    const finding = container.querySelector('.refine-finding');
    expect(finding).not.toHaveTextContent('0');
    expect(container.querySelector('.refine-finding-evidence')).toBeNull();
  });
});

function scanWithEvidence(): RefineScanResult {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-22T00:00:00.000Z',
    usedModel: { provider: 'gemini', modelName: 'gemini-test' },
    coreConcept: '',
    lastError: null,
    findings: [
      {
        id: 'finding-evidence',
        kind: 'contradiction',
        target: { kind: 'storyState' },
        message: '人物の知識状態が食い違います。',
        evidence: [
          {
            generationId: 'gen-evidence',
            sceneId: 'scene-evidence',
            quote: '主人公は真実を知った。',
          },
        ],
      },
    ],
  };
}
