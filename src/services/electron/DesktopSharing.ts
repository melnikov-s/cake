import { Context, type Effect, type Stream } from "effect";
import type {
  DesktopSharingError,
  DesktopSharingInput,
  DesktopSharingState,
} from "../../domain/application/desktop-sharing-data";

/** Desktop-local host capability. Never exposed by BackendRpc. No persisted opt-in. */
export class DesktopSharing extends Context.Service<
  DesktopSharing,
  {
    readonly configure: (
      input: DesktopSharingInput,
    ) => Effect.Effect<DesktopSharingState, DesktopSharingError>;
    readonly changes: () => Stream.Stream<DesktopSharingState>;
    readonly keepsProcessAlive: () => boolean;
  }
>()("cake/services/electron/DesktopSharing") {}
