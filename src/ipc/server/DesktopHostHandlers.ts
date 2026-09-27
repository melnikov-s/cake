import { Effect } from "effect";
import { DesktopHost } from "../../services/electron/DesktopHost";
import { DesktopHostRpc } from "../protocol/DesktopHostRpc";
export const desktopHostHandlers = DesktopHostRpc.of({
  "desktopHost.current": () => Effect.map(DesktopHost, (host) => host.current()),
  "desktopHost.select": (input) => Effect.flatMap(DesktopHost, (host) => host.select(input)),
});
