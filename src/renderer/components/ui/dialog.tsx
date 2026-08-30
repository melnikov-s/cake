import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface DialogBackdropProps extends HTMLAttributes<HTMLDivElement> {
  onClose?: () => void;
}

export const DialogBackdrop = forwardRef<HTMLDivElement, DialogBackdropProps>(
  function DialogBackdrop({ className, onClose, children, ...props }, ref) {
    return (
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose?.();
        }}
        className={cn(
          "fixed inset-0 z-50 grid place-items-center bg-foreground/28 p-6 backdrop-blur-md",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);

export const DialogContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogContent({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "w-full max-w-[34rem] rounded-xl border border-border bg-card p-6 text-card-foreground shadow-2xl animate-in fade-in zoom-in-95 duration-150",
          className,
        )}
        {...props}
      />
    );
  },
);

export const DialogHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogHeader({ className, ...props }, ref) {
    return <div ref={ref} className={cn("flex flex-col gap-1.5", className)} {...props} />;
  },
);

export const DialogTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function DialogTitle({ className, ...props }, ref) {
    return (
      <h2
        ref={ref}
        className={cn(
          "font-display text-base font-semibold tracking-tight leading-none",
          className,
        )}
        {...props}
      />
    );
  },
);

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(function DialogDescription({ className, ...props }, ref) {
  return <p ref={ref} className={cn("text-xs text-muted-foreground", className)} {...props} />;
});

export const DialogFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogFooter({ className, ...props }, ref) {
    return <div ref={ref} className={cn("mt-6 flex justify-end gap-2.5", className)} {...props} />;
  },
);
