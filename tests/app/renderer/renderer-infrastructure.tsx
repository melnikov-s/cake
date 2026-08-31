import type { ReactNode } from "react";
import type { RendererClient } from "../../../src/renderer/client/RendererClient";
import {
  RendererInfrastructureProvider,
  type RendererInfrastructure,
} from "../../../src/renderer/RendererInfrastructureContext";

export function RendererInfrastructureFixture({
  children,
  electronInvoke = async () => ({ type: "accepted", requestId: crypto.randomUUID() }),
  pluginInvoke = async () => ({ type: "accepted", requestId: crypto.randomUUID() }),
}: {
  children: ReactNode;
  electronInvoke?: RendererClient["electron"]["invoke"];
  pluginInvoke?: RendererClient["plugins"]["invoke"];
}) {
  const client = {
    electron: { invoke: electronInvoke },
    plugins: { invoke: pluginInvoke },
  } as unknown as RendererClient;
  const value: RendererInfrastructure = {
    client,
    subscribe: () => () => undefined,
  };
  return <RendererInfrastructureProvider value={value}>{children}</RendererInfrastructureProvider>;
}
