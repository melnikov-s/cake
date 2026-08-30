import { cva, type VariantProps } from "class-variance-authority";
import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors select-none",
  {
    variants: {
      variant: {
        default: "border border-border bg-muted text-muted-foreground",
        accent: "border border-accent/30 bg-accent/15 text-accent font-semibold",
        secondary: "bg-muted text-foreground",
        outline: "border border-border text-foreground",
        destructive:
          "border border-destructive/30 bg-destructive/15 text-destructive font-semibold",
        success: "border border-success/30 bg-success/15 text-success font-semibold",
        mono: "font-mono border border-border/70 text-muted-foreground",
      },
      size: {
        default: "px-2 py-0.5 text-[10px]",
        sm: "px-1.5 py-0.5 text-[10px]",
        xs: "px-1.5 py-0 text-[10px] leading-tight",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}
