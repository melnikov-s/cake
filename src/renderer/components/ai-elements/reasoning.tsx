/* Adapted from Vercel AI Elements reasoning.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Cake controls visibility. */
import type { ReactNode } from "react";

export function Reasoning({ open, onToggle, children, streaming }: { open: boolean; onToggle(): void; children: ReactNode; streaming?: boolean }) {
  return (
    <div className="rounded-xl border border-border/80 bg-muted/45 px-4 py-3">
      <button className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground" onClick={onToggle} aria-expanded={open}>
        {streaming ? "Thinking…" : "Reasoning"} · {open ? "hide" : "show"}
      </button>
      {open && <div className="mt-3 text-sm leading-6 text-muted-foreground">{children}</div>}
    </div>
  );
}
