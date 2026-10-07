import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type ToastTone = "success" | "error";

type ToastItem = { id: number; message: string; tone: ToastTone };

const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => undefined);

const DISMISS_MS = 2500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, tone: ToastTone = "success") => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { id, message: trimmed, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((row) => row.id !== id));
    }, DISMISS_MS);
  }, []);

  const value = useMemo(() => showToast, [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="app-toast-stack pointer-events-none fixed inset-x-0 z-[110] flex flex-col items-center gap-2 px-4"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-auto max-w-md rounded-2xl border px-4 py-3 text-sm font-medium shadow-[0_12px_40px_rgba(15,23,42,0.12)] ${
              toast.tone === "success"
                ? "border-moss/30 bg-white text-ink"
                : "border-clay/30 bg-white text-clay"
            }`}
          >
            <span className="flex items-start justify-center gap-2 text-center">
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold ${
                  toast.tone === "success" ? "bg-moss text-white" : "bg-clay text-white"
                }`}
                aria-hidden
              >
                {toast.tone === "success" ? "✓" : "!"}
              </span>
              <span>{toast.message}</span>
            </span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
