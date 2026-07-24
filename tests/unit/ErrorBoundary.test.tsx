import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import ErrorBoundary from '../../src/client/components/ErrorBoundary';

// 描画時に投げる爆弾コンポーネント。shouldThrow で挙動を切り替える。
function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('描画中に壊れた');
  return <div>正常な内容</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // 境界が握りつぶす前に React が出す想定内のエラーログを抑制する。
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children unchanged when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>子の内容</div>
      </ErrorBoundary>
    );

    expect(screen.getByText('子の内容')).toBeInTheDocument();
    expect(screen.queryByText('表示中に問題が発生しました')).not.toBeInTheDocument();
  });

  it('shows the fallback instead of a blank screen when a child throws', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('表示中に問題が発生しました')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'アプリを再読み込み' })).toBeInTheDocument();
  });

  it('offers a reset button that clears the error and runs onReset', () => {
    const onReset = vi.fn();

    // reset 後に爆弾を無害化する親。onReset で shouldThrow を false にする。
    function Harness() {
      const [throwing, setThrowing] = useState(true);
      return (
        <ErrorBoundary
          onReset={() => {
            onReset();
            setThrowing(false);
          }}
          resetLabel="一覧に戻る"
        >
          <Bomb shouldThrow={throwing} />
        </ErrorBoundary>
      );
    }

    render(<Harness />);
    expect(screen.getByText('表示中に問題が発生しました')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '一覧に戻る' }));

    expect(onReset).toHaveBeenCalledTimes(1);
    // 境界の error state がクリアされ、無害化した子が再描画される。
    expect(screen.getByText('正常な内容')).toBeInTheDocument();
    expect(screen.queryByText('表示中に問題が発生しました')).not.toBeInTheDocument();
  });

  it('does not render a reset button when onReset is not provided', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>
    );

    expect(screen.queryByRole('button', { name: '一覧に戻る' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'アプリを再読み込み' })).toBeInTheDocument();
  });
});
