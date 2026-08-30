import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "centered" | "bordered" | "inline";
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { className, variant = "centered", children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        variant === "centered" && "grid place-items-center content-center p-8 text-center",
        variant === "bordered" &&
          "rounded-xl border border-dashed border-border p-5 text-xs text-muted-foreground leading-relaxed",
        variant === "inline" && "p-2 text-xs text-muted-foreground leading-relaxed",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
});

export const EmptyStateTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function EmptyStateTitle({ className, ...props }, ref) {
    return (
      <h3
        ref={ref}
        className={cn(
          "font-display text-2xl font-semibold tracking-tight text-foreground",
          className,
        )}
        {...props}
      />
    );
  },
);

export const EmptyStateDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(function EmptyStateDescription({ className, ...props }, ref) {
  return (
    <p
      ref={ref}
      className={cn("mt-2 max-w-[470px] text-sm text-muted-foreground leading-relaxed", className)}
      {...props}
    />
  );
});
