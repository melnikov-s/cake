import type { ReactNode } from "react";
import type { RendererClient } from "../../../src/renderer/client/RendererClient";
import {
  RendererInfrastructureProvider,
  type RendererInfrastructure,
} from "../../../src/renderer/RendererInfrastructureContext";

export function RendererInfrastructureFixture({ children }: { children: ReactNode }) {
  const client = {
    electron: { setFullscreenSurfaceOpen: async () => undefined },
  } as unknown as RendererClient;
  const value: RendererInfrastructure = {
    client,
    subscribe: () => () => undefined,
  };
  return <RendererInfrastructureProvider value={value}>{children}</RendererInfrastructureProvider>;
}
