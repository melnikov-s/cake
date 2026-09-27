import { homedir, release } from "node:os";
import { join } from "node:path";
import type { App } from "electron";
import { Layer } from "effect";
import type { CakePaths } from "../config/CakePaths";
import * as cakeChatLocations from "../domain/cake-chats/cakeChatLocations";
import { makeCakeRpcServerLive } from "../ipc/server/CakeRpcServer";
import { ElectronRpcServerProtocolLive } from "../ipc/transport/ElectronRpcServerProtocol";
import { BrowserLive } from "../services/browser/BrowserLive";
import { makeDictationLive } from "../services/dictation/DictationLive";
import { makeElectronLive } from "../services/electron/ElectronLive";
import { makeDesktopHostLive } from "../services/electron/DesktopHostLive";
import { makeDesktopSharingLive } from "../services/electron/DesktopSharingLive";
import { NativeAttachmentsLive } from "../services/filesystem/NativeAttachmentsLive";
import { makeWindowStateStorageLive } from "../services/storage/WindowStateStorage";
import { makeVsCodeViewsLive } from "../services/vscode/VsCodeViewsLive";
import { RenderedWidgetCaptureLive } from "../services/widgets/RenderedWidgetCaptureLive";
import { makeBackendLive } from "../backend/BackendLive";

export interface MainLiveOptions {
  readonly application: App;
  readonly paths: CakePaths;
  readonly userData: string;
  readonly dictationHelperPath: string;
  readonly cakeIconPath: string;
  readonly annotationMenuIconPath: string;
  readonly chatMenuIconPath: string;
  readonly preferredTheme: () => Promise<"light" | "dark">;
  readonly onThemeUpdated: (listener: () => void) => () => void;
  readonly homeDirectory?: string;
}

/** One backend, native host capabilities, and the host-supplied IPC endpoint. */
export const makeMainLive = (options: MainLiveOptions) => {
  const homeDirectory = options.homeDirectory ?? homedir();
  const DictationLive = makeDictationLive(
    join(options.userData, "dictation"),
    process.platform === "darwin" &&
      process.arch === "arm64" &&
      Number.parseInt(release(), 10) >= 23,
    options.dictationHelperPath,
  );
  const BackendLive = makeBackendLive(options, (foundation) => {
    const ElectronLive = makeElectronLive({
      application: options.application,
      cakeIconPath: options.cakeIconPath,
      annotationMenuIconPath: options.annotationMenuIconPath,
      chatMenuIconPath: options.chatMenuIconPath,
      preloadPath: join(import.meta.dirname, "../preload/preload.cjs"),
      rendererPath: join(import.meta.dirname, "../renderer/index.html"),
    }).pipe(Layer.provide(foundation));
    const HostFoundationLive = Layer.merge(foundation, ElectronLive);
    const ViewsLive = makeVsCodeViewsLive(options).pipe(Layer.provide(HostFoundationLive));
    return Layer.mergeAll(
      ElectronLive,
      ViewsLive,
      DictationLive,
      makeWindowStateStorageLive(options.userData).pipe(Layer.provide(foundation)),
      Layer.mergeAll(BrowserLive, RenderedWidgetCaptureLive, NativeAttachmentsLive).pipe(
        Layer.provide(HostFoundationLive),
      ),
    );
  });
  const cakeChat = {
    location: cakeChatLocations.make({
      homeDirectory,
      sessionDirectory: options.paths.piGlobalChatSessions,
      resolvedSessionDirectory: options.paths.piGlobalChatResolvedSessions,
    }),
    agentDirectory: options.paths.piAgent,
  };
  const SharingLive = makeDesktopSharingLive(
    { homeDirectory, cakeChat },
    join(import.meta.dirname, "../browser"),
  ).pipe(Layer.provide(BackendLive));
  const HostLive = Layer.mergeAll(
    BackendLive,
    SharingLive,
    makeDesktopHostLive(options.application, options.userData, { kind: "local" }),
  );
  const ProtocolLive = ElectronRpcServerProtocolLive.pipe(Layer.provide(BackendLive));
  const RpcLive = makeCakeRpcServerLive(homeDirectory, cakeChat).pipe(
    Layer.provide(ProtocolLive),
    Layer.provide(HostLive),
  );
  return Layer.merge(HostLive, RpcLive);
};
