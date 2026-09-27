import { join } from "node:path";
import { loadDesktopHost, installDesktopSocketOrigin } from "../services/electron/DesktopHostLive";
import { makeRemoteMainLive } from "./RemoteMainLive";
import { Cause, Effect, Exit, ManagedRuntime, Schema } from "effect";
import { app, nativeTheme } from "electron";
import { cakeEventSchema, type CakeEvent } from "../ipc/cake-rpc-contract";
import type { JsonValue } from "../ipc/json-contract";
import { AgentAvailability } from "../services/pi/AgentAvailability";
import { DrawControlInvocation } from "../domain/draw/draw-control";
import { RendererRequestCoordinator } from "../services/renderer-requests/RendererRequestCoordinator";
import { ClientEvents } from "../services/clients/ClientEvents";
import {
  registerInlineWidgetScheme,
  handleInlineWidgetScheme,
} from "../services/electron/inline-widget-protocol";
import { revokeInlineWidget } from "../services/widgets/inline-widget-document-registry";
import { InlineWidgets } from "../services/widgets/InlineWidgets";
import { RenderedWidgetCapture } from "../services/widgets/RenderedWidgetCapture";
import { ArtifactLineageId } from "../domain/artifacts/artifact-lineage";
import { ArtifactStorage } from "../services/storage/ArtifactStorage";
import {
  registerExtensionCompanionScheme,
  handleExtensionCompanionScheme,
} from "../services/electron/extension-companion-protocol";
import { resolveCakePaths } from "../config/CakePaths";
import { MainApplication } from "./MainApplication";
import { makeMainLive } from "./MainLive";
import cakeIconPath from "../assets/cake.png?asset";
import annotationMenuIconPath from "../assets/menu-annotation.png?asset";
import chatMenuIconPath from "../assets/menu-chat.png?asset";

app.setName("Cake");
registerInlineWidgetScheme();
registerExtensionCompanionScheme();
if (process.env.CAKE_ELECTRON_USER_DATA)
  app.setPath("userData", process.env.CAKE_ELECTRON_USER_DATA);

const paths = resolveCakePaths();
const selectedHost = loadDesktopHost(app.getPath("userData"));
const mainOptions = {
  application: app,
  paths,
  userData: app.getPath("userData"),
  dictationHelperPath:
    process.env.CAKE_ELECTRON_SMOKE === "1" && process.env.CAKE_SMOKE_DICTATION_HELPER
      ? process.env.CAKE_SMOKE_DICTATION_HELPER
      : join(import.meta.dirname, "native", "cake-dictation"),
  cakeIconPath,
  annotationMenuIconPath,
  chatMenuIconPath,
  preferredTheme: async (): Promise<"light" | "dark"> =>
    nativeTheme.shouldUseDarkColors ? "dark" : "light",
  onThemeUpdated: (listener: () => void) => {
    nativeTheme.on("updated", listener);
    return () => nativeTheme.off("updated", listener);
  },
};
const MainLive =
  selectedHost.kind === "remote"
    ? makeRemoteMainLive(mainOptions, selectedHost)
    : makeMainLive(mainOptions);

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
const mainProgram = Effect.promise(() => app.whenReady()).pipe(
  Effect.tap(() => Effect.sync(() => installDesktopSocketOrigin(selectedHost))),
  Effect.andThen(
    MainApplication({
      application: app,
      initializeDeveloperTools,
      initializeNativeProtocols: () => {
        const endpoint = selectedHost.kind === "remote" ? selectedHost.url : undefined;
        handleInlineWidgetScheme(endpoint);
        handleExtensionCompanionScheme(endpoint);
      },
    }),
  ),
);
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

if (process.env.CAKE_ELECTRON_SMOKE === "1" && selectedHost.kind === "remote") {
  Object.assign(globalThis, {
    cakeSmokeRemoteCaptureWidget(widget: { token: string; url: string }) {
      return mainRuntime.runPromise(
        Effect.flatMap(RenderedWidgetCapture, (capture) =>
          capture.capture("remote-smoke", widget, new AbortController().signal),
        ),
      );
    },
  });
}

if (process.env.CAKE_ELECTRON_SMOKE === "1" && selectedHost.kind === "local") {
  const reportSmokeFailure = (operation: string, defect: Error) => {
    console.error(`[cake.smoke] ${operation} failed`, defect);
  };
  Object.assign(globalThis, {
    cakeSmokeDrawControl(sessionId: string, invocation: DrawControlInvocation) {
      return mainRuntime.runPromise(
        Effect.gen(function* () {
          const request = yield* Schema.decodeUnknownEffect(DrawControlInvocation)(invocation);
          const coordinator = yield* Effect.serviceOption(RendererRequestCoordinator).pipe(
            Effect.flatMap((service) =>
              service._tag === "Some"
                ? Effect.succeed(service.value)
                : Effect.die("Local-only smoke hook"),
            ),
          );
          return yield* coordinator.requestDrawControl(
            sessionId,
            request,
            new AbortController().signal,
          );
        }),
      );
    },
    cakeSmokeEmitRendererEvent(input: CakeEvent) {
      void mainRuntime
        .runPromise(
          Effect.flatMap(ClientEvents, (clientEvents) =>
            Effect.sync(() =>
              clientEvents.broadcast(Schema.decodeUnknownSync(cakeEventSchema)(input)),
            ),
          ),
        )
        .catch((defect) => reportSmokeFailure("emit renderer event", defect));
    },
    async cakeSmokeCaptureInlineWidget(input: {
      sessionId: string;
      workingDirectory: string;
      artifactId: string;
      source: string;
      pluginState?: JsonValue;
      cancelAfterMs?: number;
    }) {
      return mainRuntime.runPromise(
        Effect.gen(function* () {
          const widgets = yield* Effect.serviceOption(InlineWidgets).pipe(
            Effect.flatMap((service) =>
              service._tag === "Some"
                ? Effect.succeed(service.value)
                : Effect.die("Local-only smoke hook"),
            ),
          );
          const captures = yield* Effect.serviceOption(RenderedWidgetCapture).pipe(
            Effect.flatMap((service) =>
              service._tag === "Some"
                ? Effect.succeed(service.value)
                : Effect.die("Local-only smoke hook"),
            ),
          );
          const artifacts = yield* Effect.serviceOption(ArtifactStorage).pipe(
            Effect.flatMap((service) =>
              service._tag === "Some"
                ? Effect.succeed(service.value)
                : Effect.die("Local-only smoke hook"),
            ),
          );
          const lineageId = yield* Schema.decodeUnknownEffect(ArtifactLineageId)(input.artifactId);
          const before = yield* artifacts.read(lineageId);
          const compiled = yield* widgets.compile({
            language: "react",
            capability: input.pluginState === undefined ? "display" : "session-plugin",
            source: input.source,
          });
          const controller = new AbortController();
          const cancelTimer =
            input.cancelAfterMs === undefined
              ? undefined
              : setTimeout(() => controller.abort(), input.cancelAfterMs);
          const capture = yield* captures
            .capture(input.sessionId, compiled.widget, controller.signal, input.pluginState)
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (cancelTimer) clearTimeout(cancelTimer);
                  revokeInlineWidget(compiled.widget.token);
                }),
              ),
            );
          const record = yield* artifacts.publish({
            lineageId,
            expectedLatestRevision: 0,
            workingDirectory: input.workingDirectory,
            snapshot: {
              protocol: "cake.artifact/v1",
              id: input.artifactId,
              sessionId: input.sessionId,
              revision: 1,
              kind: "widget",
              title: "Captured widget fixture",
              payload: {
                language: "react",
                source: input.source,
                brief: "Electron rendered-review fixture",
                generationSessionId: "smoke-review",
              },
              fallback: { markdown: "Captured widget fixture." },
              interaction: { mode: "present" },
            },
          });
          return {
            pngBase64: capture.pngBase64,
            diagnostics: capture.diagnostics,
            persistedBeforeCapture: before !== undefined,
            persistedAfterCapture:
              record.snapshot.kind === "widget" && record.snapshot.payload.source === input.source,
          };
        }),
      );
    },
    cakeSmokeResetPi() {
      void mainRuntime
        .runPromise(
          Effect.flatMap(Effect.serviceOption(AgentAvailability), (service) =>
            service._tag === "None"
              ? Effect.die("Local-only smoke hook")
              : service.value.setGlobal({ state: "unavailable", reason: "Pi runtime stopped" }),
          ),
        )
        .catch((defect) => reportSmokeFailure("reset Pi availability", defect));
    },
  });
}
