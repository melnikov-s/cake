import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const selectVariants = cva(
  "flex w-full min-w-0 cursor-pointer rounded-lg border border-border bg-background text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        default: "h-9 px-2.5 text-xs",
        sm: "h-7.5 px-2 text-[11px]",
        lg: "h-10 px-3 text-sm",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

export interface SelectProps
  extends
    Omit<SelectHTMLAttributes<HTMLSelectElement>, "size">,
    VariantProps<typeof selectVariants> {}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, size, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn(selectVariants({ size }), className)} {...props}>
      {children}
    </select>
  );
});
