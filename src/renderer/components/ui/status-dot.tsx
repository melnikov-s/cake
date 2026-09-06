import { cva, type VariantProps } from "class-variance-authority";
import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const statusDotVariants = cva("inline-block shrink-0 rounded-full", {
  variants: {
    status: {
      default: "bg-muted-foreground",
      pending: "bg-muted-foreground",
      ready: "bg-success",
      success: "bg-success",
      complete: "bg-success",
      running: "bg-accent animate-pulse",
      failed: "bg-destructive",
      error: "bg-destructive",
      stopped: "bg-destructive",
      interrupted: "bg-[oklch(0.6_0.09_70)]",
      accent: "bg-accent",
      attention: "bg-attention",
    },
    size: {
      default: "size-[7px]",
      sm: "size-[6px]",
      lg: "size-[9px]",
    },
    halo: {
      true: "ring-3 ring-current/10",
      false: "",
    },
  },
  defaultVariants: {
    status: "default",
    size: "default",
    halo: false,
  },
});

export interface StatusDotProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof statusDotVariants> {}

export function StatusDot({ status, size, halo, className, ...props }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(statusDotVariants({ status, size, halo }), className)}
      {...props}
    />
  );
}
