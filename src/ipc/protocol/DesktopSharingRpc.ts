import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  DesktopSharingError,
  DesktopSharingInput,
  DesktopSharingPreferences,
  DesktopSharingState,
} from "../../contracts/desktop/desktop-sharing-data";

export const DesktopSharingRpc = RpcGroup.make(
  Rpc.make("desktopSharing.configure", {
    payload: DesktopSharingInput,
    success: DesktopSharingState,
    error: DesktopSharingError,
  }),
  Rpc.make("desktopSharing.updatePreferences", {
    payload: DesktopSharingPreferences,
    success: DesktopSharingState,
    error: DesktopSharingError,
  }),
  Rpc.make("desktopSharing.observe", { success: DesktopSharingState, stream: true }),
);
