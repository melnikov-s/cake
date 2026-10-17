import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Attached supporting controls above the shared chat composer. */
export function ComposerCap({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "@container/worktree mx-4 -mb-5 flex min-w-0 flex-col rounded-t-[1.75rem] border border-b-0 border-border/85 bg-card px-5 pt-3 pb-8 empty:hidden",
        className,
      )}
    />
  );
}
