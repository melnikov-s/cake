import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const calloutVariants = cva(
  "grid gap-1.5 rounded-lg border-l-3 p-3.5 text-xs leading-relaxed transition-colors",
  {
    variants: {
      variant: {
        default: "border-l-border bg-muted/65 text-foreground",
        info: "border-l-accent bg-accent/10 text-foreground",
        warning: "border-l-accent bg-accent/15 text-foreground",
        error: "border-l-destructive bg-destructive/15 text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface CalloutProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof calloutVariants> {}

export const Callout = forwardRef<HTMLDivElement, CalloutProps>(function Callout(
  { className, variant, children, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn(calloutVariants({ variant }), className)} {...props}>
      {children}
    </div>
  );
});
