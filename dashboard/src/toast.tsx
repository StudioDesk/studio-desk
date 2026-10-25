// One short message after an action, read out by screen readers (the design system's Toast).
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

const ToastContext = createContext<(message: string) => void>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; at: number } | null>(null);
  const show = useCallback((text: string) => setMessage({ text, at: Date.now() }), []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 4500);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="sd-toast" role="status" hidden={!message}>
        {message?.text}
      </div>
    </ToastContext.Provider>
  );
}
