import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { ConfirmProvider } from './components/ConfirmDialog';
import { NotificationProvider } from './components/NotificationCenter';
import './styles.css';

// NOTE: App 本体（通知フックなど）が落ちた場合の最後の砦。App 内の境界では
// 捕捉できない App 自身のエラーをここで受け止め、少なくとも再読み込み導線を残す。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ConfirmProvider>
        <NotificationProvider>
          <App />
        </NotificationProvider>
      </ConfirmProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
