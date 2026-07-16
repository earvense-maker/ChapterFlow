import { useEffect, useState } from 'react';

// NOTE: 'auto' = OS の prefers-color-scheme に追従。'light'/'dark' はユーザーの明示選択。
export type ThemeChoice = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'chapterflow:theme';
const LEGACY_STORAGE_KEY = 'yumeweaving:theme';

function readStoredChoice(): ThemeChoice {
  if (typeof window === 'undefined') return 'auto';
  const v = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}

function detectOs(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  return choice === 'auto' ? detectOs() : choice;
}

export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readStoredChoice()));

  // choice → localStorage + data-theme を反映
  useEffect(() => {
    const applied = resolve(choice);
    setResolved(applied);
    document.documentElement.setAttribute('data-theme', applied);
    if (choice === 'auto') {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, choice);
    }
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  }, [choice]);

  // auto の間は OS 設定変更を監視
  useEffect(() => {
    if (choice !== 'auto' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => {
      const next = detectOs();
      setResolved(next);
      document.documentElement.setAttribute('data-theme', next);
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [choice]);

  return { choice, setChoice: setChoiceState, resolved };
}
