import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ConfirmFunction = (message: string, options?: ConfirmOptions) => Promise<boolean>;

interface ConfirmRequest {
  id: number;
  message: string;
  options: ConfirmOptions;
  restoreTarget: HTMLElement | null;
  resolve: (confirmed: boolean) => void;
}

const ConfirmContext = createContext<ConfirmFunction | null>(null);
const QUEUED_DIALOG_DELAY_MS = 500;

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState<ConfirmRequest | null>(null);
  const [isSettling, setIsSettling] = useState(false);
  const currentRef = useRef<ConfirmRequest | null>(null);
  const queueRef = useRef<ConfirmRequest[]>([]);
  const nextRequestIdRef = useRef(1);
  const settlingRef = useRef(false);
  const queueTimerRef = useRef<number | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const showRequest = useCallback((request: ConfirmRequest) => {
    currentRef.current = request;
    setCurrent(request);
  }, []);

  const confirm = useCallback<ConfirmFunction>(
    (message, options = {}) =>
      new Promise<boolean>((resolve) => {
        const activeElement = document.activeElement;
        const request: ConfirmRequest = {
          id: nextRequestIdRef.current++,
          message,
          options,
          restoreTarget: activeElement instanceof HTMLElement ? activeElement : null,
          resolve,
        };

        if (currentRef.current || settlingRef.current) {
          queueRef.current.push(request);
        } else {
          showRequest(request);
        }
      }),
    [showRequest]
  );

  const finish = useCallback(
    (requestId: number, confirmed: boolean) => {
      const request = currentRef.current;
      // NOTE: ダブルクリックなどで古いダイアログのイベントが遅れて届いても、
      // 待機中の次ダイアログを確定しないよう、表示時の ID と照合する。
      if (!request || request.id !== requestId) return;

      settlingRef.current = true;
      setIsSettling(true);
      currentRef.current = null;
      setCurrent(null);
      request.resolve(confirmed);

      window.requestAnimationFrame(() => {
        if (
          !currentRef.current &&
          !settlingRef.current &&
          request.restoreTarget?.isConnected
        ) {
          request.restoreTarget.focus();
        }
      });

      queueMicrotask(() => {
        if (queueRef.current.length === 0) {
          settlingRef.current = false;
          setIsSettling(false);
          return;
        }

        // NOTE: 次の確認を同じ位置へ即表示すると、直前の二重クリックの2回目が
        // 次の破壊的操作まで確定し得る。短い空白を挟み、新しい操作として扱う。
        queueTimerRef.current = window.setTimeout(() => {
          queueTimerRef.current = null;
          settlingRef.current = false;
          setIsSettling(false);
          const next = queueRef.current.shift();
          if (next) showRequest(next);
        }, QUEUED_DIALOG_DELAY_MS);
      });
    },
    [showRequest]
  );

  useEffect(() => {
    if (!current) return;
    const frameId = window.requestAnimationFrame(() => {
      cancelButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [current]);

  useEffect(
    () => () => {
      if (queueTimerRef.current !== null) {
        window.clearTimeout(queueTimerRef.current);
      }
      currentRef.current?.resolve(false);
      for (const request of queueRef.current.splice(0)) request.resolve(false);
    },
    []
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {(current || isSettling) && (
        <div
          className="confirm-dialog-backdrop"
          aria-hidden={current ? undefined : 'true'}
        >
          {current && (
            <div
              className="confirm-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-dialog-title"
              aria-describedby="confirm-dialog-message"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  finish(current.id, false);
                  return;
                }
                if (event.key !== 'Tab') return;

                const first = cancelButtonRef.current;
                const last = confirmButtonRef.current;
                if (!first || !last) return;
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first.focus();
                }
              }}
            >
              <h2 id="confirm-dialog-title">{current.options.title ?? '確認'}</h2>
              <p id="confirm-dialog-message">{current.message}</p>
              <div className="confirm-dialog-actions">
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={() => finish(current.id, false)}
                >
                  {current.options.cancelLabel ?? 'キャンセル'}
                </button>
                <button
                  ref={confirmButtonRef}
                  type="button"
                  className={current.options.danger ? 'danger' : 'primary'}
                  onClick={() => finish(current.id, true)}
                >
                  {current.options.confirmLabel ?? 'OK'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFunction {
  const confirm = useContext(ConfirmContext);
  return useCallback(
    async (message, options) => {
      if (!confirm) {
        throw new Error('useConfirm must be used inside ConfirmProvider');
      }
      return confirm(message, options);
    },
    [confirm]
  );
}
