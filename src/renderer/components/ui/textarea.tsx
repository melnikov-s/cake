import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const textareaVariants = cva(
  "flex w-full min-w-0 rounded-lg border border-border bg-background text-foreground transition-colors placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        default: "p-2.5 text-xs leading-relaxed",
        sm: "p-2 text-[11px] leading-relaxed",
        lg: "p-3 text-sm leading-relaxed",
      },
      font: {
        sans: "font-sans",
        mono: "font-mono text-[12px] leading-[1.45]",
      },
    },
    defaultVariants: {
      size: "default",
      font: "sans",
    },
  },
);

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement>, VariantProps<typeof textareaVariants> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, size, font, ...props },
  ref,
) {
  return (
    <textarea ref={ref} className={cn(textareaVariants({ size, font }), className)} {...props} />
  );
});
