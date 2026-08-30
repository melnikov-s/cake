import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const inputVariants = cva(
  "flex w-full min-w-0 rounded-lg border border-border bg-background text-foreground transition-colors placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        default: "h-9 px-2.5 text-xs",
        sm: "h-7.5 px-2 text-[11px]",
        lg: "h-10 px-3 text-sm",
      },
      variant: {
        default: "bg-background",
        ghost:
          "border-transparent bg-transparent hover:bg-muted focus-visible:border-border focus-visible:bg-background",
      },
    },
    defaultVariants: {
      size: "default",
      variant: "default",
    },
  },
);

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">, VariantProps<typeof inputVariants> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = "text", size, variant, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(inputVariants({ size, variant }), className)}
      {...props}
    />
  );
});
