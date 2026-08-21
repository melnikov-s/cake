import { observer } from "r-state-tree/react";
import type { ReactNode } from "react";
import type { ToastStore } from "../stores/ToastStore";

/**
 * Renders transient app-level toasts from the ToastStore, plus any extra
 * notices passed as children, in a single corner toast stack.
 */
export const ToastHost = observer(function ToastHost({
  store,
  children,
}: {
  store: ToastStore;
  children?: ReactNode;
}) {
  if (store.toasts.length === 0 && !children) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {store.toasts.map((toast) => (
        <button
          key={toast.id}
          className={`notice notice-${toast.tone}`}
          onClick={() => store.dismiss(toast.id)}
        >
          <strong>{toast.title}</strong>
          <span>{toast.message}</span>
        </button>
      ))}
      {children}
    </div>
  );
});
