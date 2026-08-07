/* Inspired by Vercel AI Elements code-block.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). No highlighter runtime. */
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function CodeBlock({ className, ...props }: ComponentProps<"pre">) {
  return <pre className={cn("my-3 max-w-full overflow-x-auto rounded-xl bg-foreground p-4 font-mono text-xs leading-6 text-background", className)} {...props} />;
}
