import { createContext, useContext, type ReactNode } from "react";
import type { DesktopEvent } from "../ipc/desktop-ipc";
import type { RendererClient } from "./client/RendererClient";

export interface RendererInfrastructure {
  readonly client: RendererClient;
  readonly subscribe: (listener: (event: DesktopEvent) => void) => () => void;
}

const Context = createContext<RendererInfrastructure | undefined>(undefined);

export function RendererInfrastructureProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: RendererInfrastructure;
}) {
  return <Context value={value}>{children}</Context>;
}

export function useRendererInfrastructure(): RendererInfrastructure {
  const infrastructure = useContext(Context);
  if (!infrastructure)
    throw new Error("RendererInfrastructureProvider is required for privileged renderer access");
  return infrastructure;
}
