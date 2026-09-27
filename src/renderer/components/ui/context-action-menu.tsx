import { useEffect } from "react";
import { observer } from "r-state-tree/react";
import type { BrowserMenuStore } from "../../stores/BrowserMenuStore";
import { Button } from "./button";
import { DialogBackdrop, DialogContent, DialogTitle } from "./dialog";

/** Shared accessible action menu for device integrations without a native context menu. */
export const ContextActionMenu = observer(function ContextActionMenu({
  store,
}: {
  store: BrowserMenuStore;
}) {
  useEffect(() => {
    if (!store.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") store.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, store.open]);
  if (!store.open) return null;
  return (
    <DialogBackdrop onClose={() => store.close()} aria-label={store.title}>
      <DialogContent className="max-w-xs p-3">
        <DialogTitle className="px-2 pb-2">{store.title}</DialogTitle>
        {store.error && (
          <p role="alert" className="px-2 text-xs text-destructive">
            {store.error}
          </p>
        )}
        <div className="flex flex-col gap-1">
          {store.items.map((item) => (
            <Button
              key={item.label}
              variant="ghost"
              className="justify-start"
              disabled={item.disabled}
              onClick={() => store.choose(item)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </DialogContent>
    </DialogBackdrop>
  );
});
