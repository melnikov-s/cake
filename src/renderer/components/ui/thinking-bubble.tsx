import { cn } from "@/lib/utils";

/** A quiet, compact indication that a conversational response is being prepared. */
export function ThinkingBubble({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Session assistant is thinking"
      className={cn(
        "relative inline-flex h-6 w-9 items-center justify-center gap-1 rounded-full border border-border bg-card shadow-sm",
        className,
      )}
    >
      <span className="size-1 rounded-full bg-muted-foreground/70 motion-safe:animate-pulse [animation-delay:-400ms]" />
      <span className="size-1 rounded-full bg-muted-foreground/70 motion-safe:animate-pulse [animation-delay:-200ms]" />
      <span className="size-1 rounded-full bg-muted-foreground/70 motion-safe:animate-pulse" />
      <span className="absolute -bottom-1 right-1.5 size-1.5 rounded-full border border-border bg-card" />
    </span>
  );
}
