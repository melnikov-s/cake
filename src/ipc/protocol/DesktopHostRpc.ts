import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { DesktopHostError, DesktopHostSelection } from "../../contracts/desktop/desktop-host-data";

export const DesktopHostRpc = RpcGroup.make(
  Rpc.make("desktopHost.current", { success: DesktopHostSelection }),
  Rpc.make("desktopHost.select", {
    payload: DesktopHostSelection,
    success: Schema.Boolean,
    error: DesktopHostError,
  }),
);
