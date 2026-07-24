import { Component, type ErrorInfo, type ReactNode } from 'react';

// NOTE: 目的は「画面の一部で例外が起きても、アプリ全体が白画面にならない」こと。
// React のエラー境界はクラスコンポーネントでしか実装できないため、ここだけクラス。
// フォールバックには常に「再読み込み」を、onReset があれば「安全な場所へ戻る」導線を出し、
// 生成中などに描画エラーが出ても利用者が手詰まりにならないようにする。

interface Props {
  children: ReactNode;
  // 例：作品一覧へ戻すハンドラ。フォールバックに「戻る」ボタンを出す。
  onReset?: () => void;
  resetLabel?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // NOTE: 独自テレメトリは持たない方針なので、調査用にコンソールへ残すだけ。
    console.error('UI の描画中にエラーが発生しました', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-card">
          <h2>表示中に問題が発生しました</h2>
          <p>
            この画面の描画でエラーが起きました。作品データは保存先に残っています。
            下のボタンでやり直せます。
          </p>
          <div className="error-boundary-actions">
            {this.props.onReset && (
              <button type="button" onClick={this.handleReset}>
                {this.props.resetLabel ?? '一覧に戻る'}
              </button>
            )}
            <button type="button" className="primary" onClick={() => window.location.reload()}>
              アプリを再読み込み
            </button>
          </div>
          <details className="error-boundary-detail">
            <summary>エラーの詳細</summary>
            <pre>{this.state.error.message}</pre>
          </details>
        </div>
      </div>
    );
  }
}
