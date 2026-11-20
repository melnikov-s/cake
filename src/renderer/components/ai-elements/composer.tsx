/* Adapted from Vercel AI Elements prompt-input.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Removed AI SDK and upload hooks. */
import type { ComponentProps } from "react";
import { Textarea } from "../ui/textarea";
import { cn } from "@/lib/utils";

export function Composer({ className, ...props }: ComponentProps<"form">) {
  return (
    <form
      className={cn(
        "rounded-[14px] border border-hairline bg-card p-3 shadow-[inset_0_1px_0_var(--surface-rim),0_18px_50px_-24px_hsl(var(--shadow)/0.5),0_2px_10px_hsl(var(--shadow)/0.1)] transition-[border-color,box-shadow] focus-within:border-accent/35 focus-within:ring-3 focus-within:ring-accent/15",
        className,
      )}
      {...props}
    />
  );
}

export function ComposerInput({
  className,
  dictation = true,
  ...props
}: ComponentProps<typeof Textarea>) {
  return (
    <Textarea
      dictation={dictation}
      rows={1}
      className={cn(
        "min-h-10 max-h-80 [@media(pointer:coarse)]:max-h-[30dvh] [@media(pointer:coarse)]:text-base w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent px-2 py-2 text-sm leading-6 outline-none focus-visible:ring-0 [field-sizing:content] placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function ComposerToolbar({
  className,
  separated = true,
  ...props
}: ComponentProps<"div"> & { separated?: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2",
        separated && "border-t border-hairline-subtle pt-2.5",
        className,
      )}
      {...props}
    />
  );
}
