import { Cause, Effect, Exit, ManagedRuntime, Schema } from "effect";
import { app, nativeTheme } from "electron";
import { cakeEventSchema, type CakeEvent } from "../ipc/cake-rpc-contract";
import { AgentAvailability } from "../services/pi/AgentAvailability";
import { Electron } from "../services/electron/Electron";
import { registerInlineWidgetScheme } from "../services/widgets/inline-widget-protocol";
import { resolveCakePaths } from "../config/CakePaths";
import { MainApplication } from "./MainApplication";
import { makeMainLive } from "./MainLive";
import cakeIconPath from "../assets/cake.png?asset";
import annotationMenuIconPath from "../assets/menu-annotation.png?asset";
import chatMenuIconPath from "../assets/menu-chat.png?asset";
import companionManifest from "../assets/vscode-companion/companion-manifest.json";
import companionExtensionMain from "../assets/vscode-companion/extension.js?asset";
import cakeLightThemeSource from "../assets/vscode-companion/themes/cake-light-color-theme.json?raw";
import cakeDarkThemeSource from "../assets/vscode-companion/themes/cake-dark-color-theme.json?raw";

app.setName("Cake");
registerInlineWidgetScheme();
if (process.env.CAKE_ELECTRON_USER_DATA)
  app.setPath("userData", process.env.CAKE_ELECTRON_USER_DATA);

const MainLive = makeMainLive({
  application: app,
  paths: resolveCakePaths(),
  userData: app.getPath("userData"),
  cakeIconPath,
  annotationMenuIconPath,
  chatMenuIconPath,
  companionManifest,
  companionMain: companionExtensionMain,
  companionThemes: [
    { path: "./themes/cake-light-color-theme.json", content: cakeLightThemeSource },
    { path: "./themes/cake-dark-color-theme.json", content: cakeDarkThemeSource },
  ],
  preferredTheme: async () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"),
  onThemeUpdated: (listener) => {
    nativeTheme.on("updated", listener);
    return () => nativeTheme.off("updated", listener);
  },
});

const initializeDeveloperTools =
  process.env.ELECTRON_RENDERER_URL && process.env.CAKE_ELECTRON_SMOKE !== "1"
    ? async () => {
        const { installExtension, REACT_DEVELOPER_TOOLS } =
          await import("electron-devtools-installer");
        const extension = await installExtension(REACT_DEVELOPER_TOOLS, {
          loadExtensionOptions: { allowFileAccess: true },
        });
        console.info(`[cake.main] Added Electron extension: ${extension.name}`);
      }
    : undefined;

const mainRuntime = ManagedRuntime.make(MainLive);
const mainProgram = MainApplication({ application: app, initializeDeveloperTools });
void mainRuntime
  .runPromiseExit(
    mainProgram.pipe(
      Effect.tapCause((cause) =>
        Effect.logFatal(
          "Main application terminated with an unhandled defect",
          Cause.pretty(cause),
        ),
      ),
    ),
  )
  .then(async (exit) => {
    let exitCode = Exit.isFailure(exit) ? 1 : 0;
    try {
      await mainRuntime.dispose();
    } catch (defect) {
      exitCode = 1;
      console.error("[cake.main] ManagedRuntime finalization failed", defect);
    } finally {
      app.exit(exitCode);
    }
  });

if (process.env.CAKE_ELECTRON_SMOKE === "1") {
  const reportSmokeFailure = (operation: string, defect: Error) => {
    console.error(`[cake.smoke] ${operation} failed`, defect);
  };
  Object.assign(globalThis, {
    cakeSmokeEmitRendererEvent(input: CakeEvent) {
      void mainRuntime
        .runPromise(
          Effect.flatMap(Electron, (electron) =>
            Effect.sync(() => electron.broadcast(Schema.decodeUnknownSync(cakeEventSchema)(input))),
          ),
        )
        .catch((defect) => reportSmokeFailure("emit renderer event", defect));
    },
    cakeSmokeResetPi() {
      void mainRuntime
        .runPromise(
          Effect.flatMap(AgentAvailability, (availability) =>
            availability.setGlobal({ state: "unavailable", reason: "Pi runtime stopped" }),
          ),
        )
        .catch((defect) => reportSmokeFailure("reset Pi availability", defect));
    },
  });
}
