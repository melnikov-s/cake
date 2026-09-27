import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  DesktopSharingError,
  DesktopSharingInput,
  DesktopSharingState,
} from "../../domain/application/desktop-sharing-data";

export const DesktopSharingRpc = RpcGroup.make(
  Rpc.make("desktopSharing.configure", {
    payload: DesktopSharingInput,
    success: DesktopSharingState,
    error: DesktopSharingError,
  }),
  Rpc.make("desktopSharing.observe", { success: DesktopSharingState, stream: true }),
);
