import { Effect, Stream } from "effect";
import { DesktopSharing } from "../../services/electron/DesktopSharing";
import { DesktopSharingRpc } from "../protocol/DesktopSharingRpc";

export const desktopSharingHandlers = DesktopSharingRpc.of({
  "desktopSharing.configure": (input) =>
    Effect.flatMap(DesktopSharing, (sharing) => sharing.configure(input)),
  "desktopSharing.observe": () =>
    Stream.unwrap(Effect.map(DesktopSharing, (sharing) => sharing.changes())),
});
