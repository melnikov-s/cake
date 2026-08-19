/* Adapted from Vercel AI Elements reasoning.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Cake controls visibility. */
import type { ReactNode } from "react";

export function Reasoning({
  open,
  onToggle,
  children,
  streaming,
  hasContent = true,
}: {
  open: boolean;
  onToggle(): void;
  children: ReactNode;
  streaming?: boolean;
  hasContent?: boolean;
}) {
  const state = streaming ? "running" : "success";
  const label = streaming
    ? "Thinking…"
    : hasContent
      ? "Reasoning"
      : "Reasoning details not exposed";
  return (
    <div className="reasoning-block rounded-xl border border-border/80 bg-muted/45 px-4 py-3">
      {hasContent ? (
        <>
          <button
            type="button"
            className="reasoning-summary cursor-pointer font-mono text-xs font-semibold"
            onClick={onToggle}
            aria-expanded={open}
          >
            <span className={`tool-state tool-${state}`} aria-label={state} />
            <span className="reasoning-title">{label}</span>
          </button>
          {open && (
            <div className="reasoning-content mt-3 text-sm leading-6 text-muted-foreground">
              {children}
            </div>
          )}
        </>
      ) : (
        <div className="reasoning-summary font-mono text-xs font-semibold" role="status">
          <span className={`tool-state tool-${state}`} aria-label={state} />
          <span className="reasoning-title">{label}</span>
        </div>
      )}
    </div>
  );
}
