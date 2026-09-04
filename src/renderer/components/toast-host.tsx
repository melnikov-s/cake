import { observer } from "r-state-tree/react";
import type { ReactNode } from "react";
import type { ToastStore } from "../stores/ToastStore";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";

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
        <Callout
          key={toast.id}
          variant={
            toast.tone === "error" ? "error" : toast.tone === "warning" ? "warning" : "default"
          }
          className="shadow-lg"
          onClick={toast.action ? undefined : () => store.dismiss(toast.id)}
        >
          <strong>{toast.title}</strong>
          <span>{toast.message}</span>
          {toast.action && (
            <Button size="sm" variant="ghost" onClick={() => store.runAction(toast.id)}>
              {toast.action.label}
            </Button>
          )}
        </Callout>
      ))}
      {children}
    </div>
  );
});
