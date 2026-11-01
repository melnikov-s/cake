import type { ReactNode } from "react";

/** Read-only icon aligned with IconButton, without action or disabled-button semantics. */
export function IconIndicator({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="grid size-7 shrink-0 place-items-center text-muted-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
    >
      {children}
    </span>
  );
}
