import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const selectVariants = cva(
  "flex w-full min-w-0 cursor-pointer rounded-md border border-border bg-card text-foreground shadow-2xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        default: "h-8 px-2.5 text-xs",
        sm: "h-7 px-2 text-xs",
        lg: "h-9 px-3 text-sm",
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
