import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PresetSelector, { type PresetCategory } from '../../src/client/components/PresetSelector';

function category(label: string, ids: string[]): PresetCategory {
  return {
    label,
    items: Object.fromEntries(
      ids.map((id) => [id, { id, label: `${label}-${id}`, text: `${id}の説明全文。` }])
    ),
  };
}

const categories = {
  narration: category('語り', ['third-close']),
  aftertaste: category('読後感', ['poignant', 'searing', 'eerie']),
  emotionDisplay: category('感情の見せ方', ['restrained']),
  sceneProgression: category('場面の進み方', ['immersive']),
  chapterEnding: category('章の幕引き', ['hook']),
  painLevel: category('痛みの上限', ['safe']),
  intimacy: category('濡れ場の描写', ['fade-to-black']),
};

describe('PresetSelector', () => {
  it('shows all groups, categories, labels, and full descriptions', () => {
    render(
      <PresetSelector
        categories={categories}
        value={{ narration: 'third-close' }}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { name: '境界設定' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '語りと構成' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '読み味' })).toBeVisible();
    expect(screen.getAllByRole('group')).toHaveLength(7);
    expect(screen.getByText('poignantの説明全文。')).toBeVisible();
    expect(screen.getAllByText('指定しない')).toHaveLength(5);
  });

  it('limits aftertaste to two and lets optional selections be cleared', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PresetSelector
        categories={categories}
        value={{ narration: 'third-close', aftertaste: ['poignant', 'searing'] }}
        onChange={onChange}
      />
    );

    expect(screen.getByDisplayValue('eerie')).toBeDisabled();
    fireEvent.click(screen.getByDisplayValue('poignant'));
    expect(onChange).toHaveBeenCalledWith({ narration: 'third-close', aftertaste: ['searing'] });

    rerender(
      <PresetSelector
        categories={categories}
        value={{ narration: 'third-close', painLevel: 'safe' }}
        onChange={onChange}
      />
    );
    const painGroup = screen.getByRole('group', { name: '痛みの上限' });
    fireEvent.click(painGroup.querySelector('input[type="radio"]') as HTMLInputElement);
    expect(onChange).toHaveBeenLastCalledWith({ narration: 'third-close' });
  });
});
