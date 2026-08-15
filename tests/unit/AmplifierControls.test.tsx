import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AmplifierControls from '../../src/client/components/AmplifierControls';
import { api } from '../../src/client/clientApi';
import type { AmplifierTurn } from '@shared/types';

const anchor = {
  kind: 'novel' as const,
  generationId: 'gen-amplifier-test',
  textRevisionNumber: 0,
};

function turn(status: 'failed' | 'ready'): AmplifierTurn {
  return {
    schemaVersion: 1,
    turnId: 'amp-turn-test',
    projectId: 'proj-amplifier-test',
    contextKey: 'novel:main',
    anchor,
    anchorTextHash: 'hash',
    anchorExcerpt: '本文',
    status,
    choices:
      status === 'ready'
        ? [
            {
              choiceId: 'choice-1',
              strategy: 'exploit',
              label: 'もう少し近づく',
              description: '相手の本音が少しだけ漏れる。',
            },
            {
              choiceId: 'choice-2',
              strategy: 'variation',
              label: '別の表情を見る',
              description: '意外な弱さを覗かせる。',
            },
            {
              choiceId: 'choice-3',
              strategy: 'explore',
              label: '空気を少し崩す',
              description: '小さな予想外が起こる。',
            },
          ]
        : [],
    revision: status === 'ready' ? 2 : 1,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    ...(status === 'failed' ? { errorCode: 'amplifier_choices_invalid' } : {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AmplifierControls', () => {
  it('同じアンカーで親が再描画されても入力欄とフォーカスを維持する', async () => {
    const getState = vi.spyOn(api, 'getAmplifierState').mockResolvedValue({
      turn: turn('ready'),
      preferences: { current: [], project: [], corrections: [] },
    });
    const onAdvance = vi.fn();
    const onError = vi.fn();
    const { rerender } = render(
      <AmplifierControls
        projectId="proj-amplifier-test"
        mode="novel"
        anchor={{ ...anchor }}
        anchorExcerpt="本文（親側の表示更新）"
        onAdvance={onAdvance}
        onError={onError}
      />
    );
    const input = await screen.findByPlaceholderText('こんな方向も見たい…（自由記述）');
    fireEvent.change(input, { target: { value: 'このまま静かに話したい' } });
    input.focus();
    expect(input).toHaveFocus();

    rerender(
      <AmplifierControls
        projectId="proj-amplifier-test"
        mode="novel"
        anchor={{ ...anchor }}
        anchorExcerpt="本文"
        onAdvance={onAdvance}
        onError={onError}
      />
    );

    await waitFor(() => expect(getState).toHaveBeenCalledTimes(1));
    expect(screen.getByDisplayValue('このまま静かに話したい')).toBe(input);
    expect(input).toHaveFocus();
  });

  it('ロールプレイの同じ発言アンカーでも再描画後の入力とフォーカスを維持する', async () => {
    const roleplayAnchor = {
      kind: 'roleplay' as const,
      sessionId: 'session-amplifier-test',
      messageId: 'message-amplifier-test',
      contentRevision: 0,
    };
    const roleplayTurn: AmplifierTurn = {
      ...turn('ready'),
      contextKey: `roleplay:${roleplayAnchor.sessionId}`,
      anchor: roleplayAnchor,
    };
    const getState = vi.spyOn(api, 'getAmplifierState').mockResolvedValue({
      turn: roleplayTurn,
      preferences: { current: [], project: [], corrections: [] },
    });
    const onAdvance = vi.fn();
    const onError = vi.fn();
    const { rerender } = render(
      <AmplifierControls
        projectId="proj-amplifier-test"
        mode="roleplay"
        anchor={{ ...roleplayAnchor }}
        anchorExcerpt="最初の発言"
        onAdvance={onAdvance}
        onError={onError}
      />
    );
    const input = await screen.findByPlaceholderText('こんな方向も見たい…（自由記述）');
    fireEvent.change(input, { target: { value: 'もう少し本音を聞きたい' } });
    input.focus();

    rerender(
      <AmplifierControls
        projectId="proj-amplifier-test"
        mode="roleplay"
        anchor={{ ...roleplayAnchor }}
        anchorExcerpt="ポーリング後の発言表示"
        onAdvance={onAdvance}
        onError={onError}
      />
    );

    await waitFor(() => expect(getState).toHaveBeenCalledTimes(1));
    expect(getState).toHaveBeenCalledWith('proj-amplifier-test', {
      kind: 'roleplay',
      sessionId: roleplayAnchor.sessionId,
    });
    expect(screen.getByDisplayValue('もう少し本音を聞きたい')).toBe(input);
    expect(input).toHaveFocus();
  });

  it('failed ターンの再取得ボタンから生成 API を再実行する', async () => {
    vi.spyOn(api, 'getAmplifierState').mockResolvedValue({
      turn: turn('failed'),
      preferences: { current: [], project: [], corrections: [] },
    });
    const createTurn = vi.spyOn(api, 'createAmplifierTurn').mockResolvedValue({
      turn: turn('ready'),
      stale: false,
    });

    render(
      <AmplifierControls
        projectId="proj-amplifier-test"
        mode="novel"
        anchor={anchor}
        anchorExcerpt="本文"
        onAdvance={vi.fn()}
        onError={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: '方向を再取得' }));

    await waitFor(() => expect(createTurn).toHaveBeenCalledWith('proj-amplifier-test', { anchor }));
    expect(await screen.findByRole('button', { name: /もう少し近づく/ })).toBeVisible();
  });
});
