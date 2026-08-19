/* Adapted from Vercel AI Elements prompt-input.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Removed AI SDK and upload hooks. */
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Composer({ className, ...props }: ComponentProps<"form">) {
  return (
    <form
      className={cn(
        "rounded-2xl border border-border bg-card p-3 shadow-[0_18px_70px_-45px_rgba(18,22,27,0.65)]",
        className,
      )}
      {...props}
    />
  );
}

export function ComposerInput({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-24 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function ComposerToolbar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3",
        className,
      )}
      {...props}
    />
  );
}
