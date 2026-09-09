import { observer } from "r-state-tree/react";
import type { ReactNode } from "react";
import type { ToastStore } from "../stores/ToastStore";
import { ToastItem } from "./toast-item";

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
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm" aria-live="polite">
      {store.toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onAction={() => store.runAction(toast.id)}
          onDismiss={() => store.dismiss(toast.id)}
        />
      ))}
      {children}
    </div>
  );
});
