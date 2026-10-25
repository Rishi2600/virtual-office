import type { ReactNode } from "react";
import { create } from "zustand";

/**
 * Short, non-blocking notices ("Bob joined your huddle"). Kept in their own
 * tiny store; announced to screen readers through a polite live region.
 */
export interface Toast {
  id: number;
  text: ReactNode;
  icon?: ReactNode;
  tone?: "info" | "warn" | "success";
  /** A newer toast with the same key replaces this one (and dismissKey clears it). */
  key?: string;
}

interface ToastStore {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">, ms?: number) => void;
  dismiss: (id: number) => void;
  dismissKey: (key: string) => void;
}

let nextId = 1;
const MAX_VISIBLE = 3;

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (t, ms = 4000) => {
    const id = nextId++;
    set((s) => ({
      toasts: [...s.toasts.filter((x) => !t.key || x.key !== t.key), { ...t, id }].slice(-MAX_VISIBLE),
    }));
    setTimeout(() => get().dismiss(id), ms);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  dismissKey: (key) => set((s) => ({ toasts: s.toasts.filter((t) => t.key !== key) })),
}));

export const toast = (t: Omit<Toast, "id">, ms?: number) => useToasts.getState().push(t, ms);

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast tone-${t.tone ?? "info"}`}>
          {t.icon}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
