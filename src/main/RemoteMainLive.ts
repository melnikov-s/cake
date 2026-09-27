import { release } from "node:os";
import { join } from "node:path";
import { DictationRpc } from "../ipc/protocol/DictationRpc";
import { dictationHandlers } from "../ipc/server/DictationHandlers";
import { makeDictationLive } from "../services/dictation/DictationLive";
import { VsCodeViewRpc } from "../ipc/protocol/VsCodeRpc";
import { NativeAttachmentsRpc } from "../ipc/protocol/NativeAttachmentsRpc";
import { nativeAttachmentsHandlers } from "../ipc/server/FilesystemHandlers";
import { NativeAttachmentsLive } from "../services/filesystem/NativeAttachmentsLive";
import { makeBrowserLive } from "../services/browser/BrowserLive";
import { BrowserRpc } from "../ipc/protocol/BrowserRpc";
import { NativePreviewTunnelRpc } from "../ipc/protocol/NativePreviewTunnelRpc";
import { nativePreviewTunnelHandlers } from "../ipc/server/NativePreviewTunnelHandlers";
import { makeNativePreviewTunnelsLive } from "../services/browser/NativePreviewTunnelsLive";
import { browserHandlers } from "../ipc/server/BrowserHandlers";
import { RenderedWidgetCaptureLive } from "../services/widgets/RenderedWidgetCaptureLive";
import { NativeWidgetCaptureRpc } from "../ipc/protocol/WidgetCaptureRpc";
import { nativeWidgetCaptureHandlers } from "../ipc/server/WidgetCaptureHandlers";
import { vscodeViewHandlers } from "../ipc/server/VsCodeHandlers";
import { makeVsCodeViewsLive } from "../services/vscode/VsCodeViewsLive";
import { Layer } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { ElectronRpc } from "../ipc/protocol/ElectronRpc";
import { WindowStateRpc } from "../ipc/protocol/WindowStateRpc";
import { DesktopHostRpc } from "../ipc/protocol/DesktopHostRpc";
import { ApplicationEventsRpc } from "../ipc/protocol/FoundationRpc";
import { TerminalEventsRpc } from "../ipc/protocol/TerminalRpc";
import {
  RendererConnectionMiddleware,
  RendererConnectionMiddlewareLive,
} from "../ipc/protocol/RendererConnectionMiddleware";
import { electronHandlers } from "../ipc/server/ElectronHandlers";
import { windowStateHandlers } from "../ipc/server/WindowStateHandlers";
import { desktopHostHandlers } from "../ipc/server/DesktopHostHandlers";
import { makeFoundationHandlers } from "../ipc/server/FoundationHandlers";
import { nativeTerminalEvents } from "../ipc/server/ClientEventHandlers";
import { ElectronRpcServerProtocolLive } from "../ipc/transport/ElectronRpcServerProtocol";
import { ClientConnectionsLive } from "../services/clients/ClientConnections";
import { ClientEventsLive } from "../services/clients/ClientEventsLive";
import { ClientWorkspacesLive } from "../services/clients/ClientWorkspacesLive";
import { makeElectronLive } from "../services/electron/ElectronLive";
import {
  makeDesktopHostLive,
  desktopPresentationDirectory,
} from "../services/electron/DesktopHostLive";
import { makeWindowStateStorageLive } from "../services/storage/WindowStateStorage";
import type { DesktopHostSelection } from "../domain/application/desktop-host-data";
import type { MainLiveOptions } from "./MainLive";
import { BootstrapLive } from "./BootstrapLive";

/** A native desktop, deliberately without BackendLive, Pi, project storage or workers. */
export const makeRemoteMainLive = (
  options: MainLiveOptions,
  host: Extract<DesktopHostSelection, { kind: "remote" }>,
) => {
  const Clients = Layer.mergeAll(ClientConnectionsLive, ClientEventsLive, ClientWorkspacesLive);
  const Native = makeElectronLive({
    ...options,
    preloadPath: join(import.meta.dirname, "../preload/preload.cjs"),
    rendererPath: join(import.meta.dirname, "../renderer/index.html"),
  }).pipe(Layer.provide(Clients));
  const BrowserHost = makeBrowserLive(true).pipe(Layer.provide(Layer.merge(Clients, Native)));
  const PreviewTunnels = makeNativePreviewTunnelsLive(host.url).pipe(
    Layer.provide(Layer.merge(Native, BrowserHost)),
  );
  const Host = Layer.mergeAll(
    Clients,
    Native,
    makeDictationLive(
      join(options.userData, "dictation"),
      process.platform === "darwin" &&
        process.arch === "arm64" &&
        Number.parseInt(release(), 10) >= 23,
      options.dictationHelperPath,
    ),
    makeVsCodeViewsLive(options).pipe(Layer.provide(Layer.merge(Clients, Native))),
    makeDesktopHostLive(options.application, options.userData, host),
    NativeAttachmentsLive.pipe(Layer.provide(Native)),
    BrowserHost,
    RenderedWidgetCaptureLive,
    makeWindowStateStorageLive(desktopPresentationDirectory(options.userData, host)).pipe(
      Layer.provide(BootstrapLive),
    ),
  );
  const Rpc = ElectronRpc.merge(
    DictationRpc,
    WindowStateRpc,
    DesktopHostRpc,
    ApplicationEventsRpc,
    TerminalEventsRpc,
    VsCodeViewRpc,
    NativeAttachmentsRpc,
    NativeWidgetCaptureRpc,
    BrowserRpc,
    NativePreviewTunnelRpc,
  ).middleware(RendererConnectionMiddleware);
  const handlers = Rpc.toLayer({
    ...dictationHandlers,
    ...electronHandlers,
    ...windowStateHandlers,
    ...desktopHostHandlers,
    ...vscodeViewHandlers,
    ...nativeAttachmentsHandlers,
    ...browserHandlers,
    ...nativePreviewTunnelHandlers,
    ...nativeWidgetCaptureHandlers,
    "application.observeEvents": makeFoundationHandlers("")["application.observeEvents"],
    "terminals.observeEvents": nativeTerminalEvents,
  });
  const Endpoint = RpcServer.layer(Rpc, { disableFatalDefects: true }).pipe(
    Layer.provide(
      Layer.merge(handlers.pipe(Layer.provide(PreviewTunnels)), RendererConnectionMiddlewareLive),
    ),
    Layer.provide(ElectronRpcServerProtocolLive.pipe(Layer.provide(Clients))),
    Layer.provide(Host),
  );
  return Layer.merge(Host, Endpoint);
};
