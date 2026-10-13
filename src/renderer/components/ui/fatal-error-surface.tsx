import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Chromium's top layer keeps fatal diagnostics above portals and ordinary stacking contexts. */
export function FatalErrorSurface({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const surface = dialog.current;
    surface?.showModal();
    return () => surface?.close();
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      aria-label="Cake encountered an error"
      onCancel={(event) => event.preventDefault()}
      className="fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none overflow-auto border-0 bg-background p-0 text-foreground backdrop:bg-background"
    >
      {children}
    </dialog>,
    document.body,
  );
}
