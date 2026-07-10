import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import LightMarkdown from '../../src/client/components/LightMarkdown';

describe('LightMarkdown', () => {
  it('renders common assistant Markdown without inserting raw markers', () => {
    const { container } = render(
      <LightMarkdown text={'**確定していること**\n---\n- 静かな町\n- 二人の旅'} />
    );

    expect(screen.getByText('確定していること').tagName).toBe('STRONG');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.textContent).not.toContain('**');
  });
});
