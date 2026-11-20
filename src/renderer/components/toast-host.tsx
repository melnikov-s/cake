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
  maxWidth,
}: {
  store: ToastStore;
  children?: ReactNode;
  maxWidth?: number;
}) {
  if (store.toasts.length === 0 && !children) return null;
  return (
    <div
      className="fixed right-4 top-[60px] z-50 flex max-w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      style={maxWidth === undefined ? undefined : { maxWidth: Math.max(0, maxWidth) }}
      aria-live="polite"
    >
      {store.toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} store={store} />
      ))}
      {children}
    </div>
  );
});
