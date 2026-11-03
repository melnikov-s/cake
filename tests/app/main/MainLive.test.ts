import { homedir } from "node:os";
import { Layer } from "effect";
import { expect, it, vi } from "vitest";
import { resolveCakePaths } from "../../../src/config/CakePaths";
import * as cakeChatLocations from "../../../src/domain/cake-chats/cakeChatLocations";
import type { BackendLiveOptions } from "../../../src/backend/BackendLive";
import type { CakeChatRuntimeConfiguration } from "../../../src/services/pi-durable/CakeChatConfiguration";

const wiring = vi.hoisted(() => ({
  backend: undefined as BackendLiveOptions | undefined,
  window: undefined as
    | { homeDirectory: string; cakeChat: CakeChatRuntimeConfiguration }
    | undefined,
  sharing: undefined as
    | { homeDirectory: string; cakeChat: CakeChatRuntimeConfiguration }
    | undefined,
}));

// Only the composition is under test; native and backend graphs are not constructed.
vi.mock("electron", () => ({ safeStorage: {} }));
vi.mock("../../../src/backend/BackendLive", () => ({
  makeBackendLive: vi.fn((options: BackendLiveOptions) => {
    wiring.backend = options;
    return Layer.empty;
  }),
}));
vi.mock("../../../src/ipc/server/CakeRpcServer", () => ({
  makeCakeRpcServerLive: vi.fn((homeDirectory: string, cakeChat: CakeChatRuntimeConfiguration) => {
    wiring.window = { homeDirectory, cakeChat };
    return Layer.empty;
  }),
}));
vi.mock("../../../src/layers/DesktopSharingLive", () => ({
  makeDesktopSharingLive: vi.fn(
    (options: { homeDirectory: string; cakeChat: CakeChatRuntimeConfiguration }) => {
      wiring.sharing = options;
      return Layer.empty;
    },
  ),
}));
vi.mock("../../../src/ipc/transport/ElectronRpcServerProtocol", () => ({
  ElectronRpcServerProtocolLive: Layer.empty,
}));
vi.mock("../../../src/services/dictation/DictationLive", () => ({
  makeDictationLive: vi.fn(() => Layer.empty),
}));
vi.mock("../../../src/services/electron/DesktopHostLive", () => ({
  makeDesktopHostLive: vi.fn(() => Layer.empty),
}));
for (const path of [
  "../../../src/services/speech/PocketTtsLive",
  "../../../src/services/speech/ElevenLabsSpeechLive",
  "../../../src/services/speech/SpeechOutputDiagnosticsLive",
  "../../../src/services/speech/SpeechOutputStorageLive",
  "../../../src/services/browser/BrowserLive",
  "../../../src/services/electron/ElectronLive",
  "../../../src/services/filesystem/NativeAttachmentsLive",
  "../../../src/services/storage/WindowStateStorage",
  "../../../src/services/vscode/VsCodeViewsLive",
  "../../../src/services/widgets/RenderedWidgetCaptureLive",
])
  vi.doMock(path, () => ({}));

it("gives the backend and window endpoints the same Cake Chat working directory", async () => {
  const { makeMainLive } = await import("../../../src/main/MainLive");
  const paths = resolveCakePaths({
    env: { CAKE_HOME: "/isolated/.cake" },
    piAgentDirectory: "/isolated/pi",
  });
  makeMainLive({
    application: {} as never,
    paths,
    userData: "/isolated/user-data",
    dictationHelperPath: "/isolated/native/cake-dictation",
    cakeIconPath: "",
    annotationMenuIconPath: "",
    chatMenuIconPath: "",
  });

  // The headless server uses the user's home directory too; Cake metadata is not a chat cwd.
  if (!wiring.backend) throw new Error("The desktop host did not build a backend");
  expect(wiring.backend.homeDirectory).toBe(homedir());
  const backendChat = cakeChatLocations.configuration(wiring.backend);
  expect(backendChat.location.workingDirectory).toBe(homedir());
  expect(wiring.window).toEqual({ homeDirectory: homedir(), cakeChat: backendChat });
  expect(wiring.sharing).toMatchObject({ homeDirectory: homedir(), cakeChat: backendChat });
});
