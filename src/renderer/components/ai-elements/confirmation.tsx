/*
 * Adapted from Vercel AI Elements:
 * packages/elements/src/confirmation.tsx
 * https://github.com/vercel/ai-elements/tree/0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b
 *
 * Copyright 2025 Vercel, Inc.
 * Licensed under the Apache License, Version 2.0.
 *
 * Modified by Cake: replaced AI SDK ToolUIPart state with a Cake-owned
 * confirmation state, removed Next.js and repository-local dependencies, and
 * adapted semantics and styling for an Electron dialog surface.
 */
import { createContext, useContext, useMemo } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConfirmationState = "requested" | "accepted" | "declined";

interface ConfirmationContextValue {
  state: ConfirmationState;
}

const ConfirmationContext = createContext<ConfirmationContextValue | null>(null);

function useConfirmation() {
  const context = useContext(ConfirmationContext);
  if (!context) throw new Error("Confirmation components must be used within Confirmation");
  return context;
}

export interface ConfirmationProps extends ComponentProps<"div"> {
  state: ConfirmationState;
}

export function Confirmation({ className, state, ...props }: ConfirmationProps) {
  const contextValue = useMemo(() => ({ state }), [state]);

  return (
    <ConfirmationContext.Provider value={contextValue}>
      <div
        className={cn(
          "rounded-xl border border-border bg-card p-5 text-card-foreground shadow-[0_18px_60px_-32px_rgba(18,22,27,0.55)]",
          className,
        )}
        {...props}
      />
    </ConfirmationContext.Provider>
  );
}

interface ConfirmationStateSlotProps {
  children?: ReactNode;
}

export function ConfirmationRequest({ children }: ConfirmationStateSlotProps) {
  return useConfirmation().state === "requested" ? children : null;
}

export function ConfirmationAccepted({ children }: ConfirmationStateSlotProps) {
  return useConfirmation().state === "accepted" ? children : null;
}

export function ConfirmationDeclined({ children }: ConfirmationStateSlotProps) {
  return useConfirmation().state === "declined" ? children : null;
}

export function ConfirmationTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-base font-semibold tracking-[-0.01em]", className)} {...props} />;
}

export function ConfirmationDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("mt-2 text-sm leading-6 text-muted-foreground", className)} {...props} />;
}

export function ConfirmationActions({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-5 flex items-center justify-end gap-2", className)} {...props} />;
}

export type ConfirmationActionProps = ComponentProps<typeof Button>;

export function ConfirmationAction({ size = "sm", ...props }: ConfirmationActionProps) {
  return <Button size={size} {...props} />;
}
