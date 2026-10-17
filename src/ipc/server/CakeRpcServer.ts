import { Layer } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import type { CakeChatRuntimeConfiguration } from "../../services/pi-durable/CakeChatConfiguration";
import { CakeRpc, DesktopRpc } from "../protocol/CakeRpc";
import { RendererConnectionMiddlewareLive } from "../protocol/RendererConnectionMiddleware";
import { makeBackendRpcHandlersLive } from "./BackendRpcServer";
import { browserHandlers } from "./BrowserHandlers";
import { desktopHostHandlers } from "./DesktopHostHandlers";
import { desktopSharingHandlers } from "./DesktopSharingHandlers";
import { dictationHandlers } from "./DictationHandlers";
import { electronHandlers } from "./ElectronHandlers";
import { nativeAttachmentsHandlers } from "./FilesystemHandlers";
import { speechOutputHandlers } from "./SpeechOutputHandlers";
import { vscodeViewHandlers } from "./VsCodeHandlers";
import { nativeWidgetCaptureHandlers } from "./WidgetCaptureHandlers";
import { windowStateHandlers } from "./WindowStateHandlers";

/**
 * One RPC endpoint over a host-supplied Protocol and already-acquired backend capabilities.
 * This Layer owns only handler/transport request fibers, never backend acquisition. Hosts may
 * build it in independent endpoint Scopes with the same backend Context; closing an endpoint
 * releases its requests and observations without closing that Context's owning Scope.
 */
export const makeCakeRpcServerLive = (
  homeDirectory: string,
  cakeChatConfiguration: CakeChatRuntimeConfiguration,
) => {
  // Keep backend and desktop handler inference separate without enumerating operation names.
  const desktopHandlers = DesktopRpc.toLayer({
    ...dictationHandlers,
    ...speechOutputHandlers,
    ...desktopHostHandlers,
    ...browserHandlers,
    ...electronHandlers,
    ...desktopSharingHandlers,
    ...nativeAttachmentsHandlers,
    ...windowStateHandlers,
    ...nativeWidgetCaptureHandlers,
    ...vscodeViewHandlers,
  });

  return RpcServer.layer(CakeRpc, {
    spanPrefix: "CakeRpcServer",
    // A defect in one request must remain correlated with that request. Sending
    // it as a connection-wide fatal defect tears down every renderer Stream.
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        makeBackendRpcHandlersLive(homeDirectory, cakeChatConfiguration),
        desktopHandlers,
        RendererConnectionMiddlewareLive,
      ),
    ),
  );
};
