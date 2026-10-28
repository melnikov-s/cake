import { join } from "node:path";
import { loadDesktopHost, installDesktopSocketOrigin } from "../services/electron/DesktopHostLive";
import { makeRemoteMainLive } from "./RemoteMainLive";
import { Cause, Context, Effect, Exit, ManagedRuntime, Schema } from "effect";
import { app } from "electron";
import { cakeEventSchema, type CakeEvent } from "../contracts/application/cake-rpc-contract";
import { BoardAppendInput } from "../contracts/artifacts/message-board";
import * as messageBoards from "../domain/artifacts/messageBoards";
import type { JsonValue } from "../contracts/serialization/json-contract";
import { AgentAvailability } from "../services/pi/AgentAvailability";
import { ProjectSessionRuntimeHost } from "../services/pi/ProjectSessionRuntimeHost";
import { createCakeArtifactOperations } from "../domain/artifacts/cake-artifact-operations";
import { CakeOperationRegistry } from "../services/pi/runtime/cake-operation-registry";
import { prepareSkillWidgetTemplates } from "../services/pi/runtime/skill-widget-templates";
import type { ResolveWidgetTemplate } from "../contracts/widgets/widget-template";
import { WorkflowSandbox } from "../services/pi/WorkflowSandbox";
import { WorkflowProgram } from "../contracts/workflows/workflow-data";
import { ClientEvents } from "../services/clients/ClientEvents";
import { handleInlineWidgetScheme } from "../services/electron/inline-widget-protocol";
import { registerRichContentSchemes } from "../services/electron/rich-content-protocols";
import {
  publishInlineWidget,
  revokeInlineWidget,
} from "../services/widgets/inline-widget-document-registry";
import { compileInlineWidget } from "../services/widgets/inline-widget-service";
import type { InlineWidgetGenerationResult } from "../contracts/widgets/widget-generation";
import { WidgetBrowserOutputs } from "../services/widgets/WidgetBrowserOutputs";
import { WidgetPackages } from "../services/widgets/WidgetPackages";
import { WidgetPackageName, WidgetPackageSpecifier } from "../contracts/widgets/widget-packages";
import { RenderedWidgetCapture } from "../services/widgets/RenderedWidgetCapture";
import { ArtifactLineageId } from "../contracts/artifacts/artifact-lineage";
import { ArtifactStorage } from "../services/storage/ArtifactStorage";
import { MessageBoardStorage } from "../services/storage/MessageBoardStorage";
import { SessionFamilyStorage } from "../services/storage/SessionFamilyStorage";
import { ArtifactProjection } from "../services/artifacts/ArtifactProjection";
import { handleExtensionCompanionScheme } from "../services/electron/extension-companion-protocol";
import { resolveCakePaths } from "../config/CakePaths";
import { piAgentDirectory } from "../services/pi/PiPaths";
import { MainApplication } from "./MainApplication";
import { makeMainLive } from "./MainLive";
import { installStdioErrorHandlers } from "./stdio-errors";
import { reportMainFailure } from "./report-main-failure";
import { installProcessErrorHandlers } from "./process-errors";
import { installParentProcessWatchdog } from "./parent-watchdog";
import cakeIconPath from "../assets/cake.png?asset";
import annotationMenuIconPath from "../assets/menu-annotation.png?asset";
import chatMenuIconPath from "../assets/menu-chat.png?asset";

installStdioErrorHandlers(process.stdout, process.stderr);
installProcessErrorHandlers(process, reportMainFailure, () => app.exit(1));

// Test-launched Cake must not outlive a killed test runner.
if (process.env.CAKE_ELECTRON_SMOKE === "1")
  installParentProcessWatchdog(process, () => {
    console.error("[cake.main] Test runner exited; quitting orphaned smoke instance");
    app.quit();
    // Quit finalizes child processes; force exit if shutdown is wedged or startup is incomplete.
    setTimeout(() => app.exit(1), 5_000).unref();
  });

app.setName("Cake");
registerRichContentSchemes();
function startMain() {
  if (process.env.CAKE_ELECTRON_USER_DATA)
    app.setPath("userData", process.env.CAKE_ELECTRON_USER_DATA);

  // ManagedRuntime acquires its entire Layer before executing the application program.
  // Claim this profile synchronously, before even constructing the local/remote graph.
  if (!app.requestSingleInstanceLock()) {
    console.info("Cake is already running with this profile; exiting");
    app.exit(0);
    return;
  }

  const paths = resolveCakePaths({ piAgentDirectory: piAgentDirectory() });
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
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
        await reportMainFailure(Cause.pretty(exit.cause));
      try {
        await mainRuntime.dispose();
      } catch (defect) {
        exitCode = 1;
        console.error("[cake.main] ManagedRuntime finalization failed", defect);
        await reportMainFailure(
          defect instanceof Error ? (defect.stack ?? defect.message) : String(defect),
        );
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
    const boardServices = Effect.fn("Smoke.boardServices")(function* () {
      const artifacts = yield* Effect.serviceOption(ArtifactStorage);
      const boards = yield* Effect.serviceOption(MessageBoardStorage);
      const families = yield* Effect.serviceOption(SessionFamilyStorage);
      if (artifacts._tag === "None" || boards._tag === "None" || families._tag === "None")
        return yield* Effect.die("Local-only Workboard smoke hook");
      return Context.make(ArtifactStorage, artifacts.value).pipe(
        Context.add(MessageBoardStorage, boards.value),
        Context.add(SessionFamilyStorage, families.value),
      );
    });
    const reportSmokeFailure = (operation: string, defect: Error) => {
      console.error(`[cake.smoke] ${operation} failed`, defect);
    };
    let smokeWidgetTemplates: ResolveWidgetTemplate | undefined;
    Object.assign(globalThis, {
      async cakeSmokePrepareWidgetTemplates(input: {
        sessionId: string;
        workingDirectory: string;
        skills: { name: string; baseDir: string }[];
      }) {
        return mainRuntime.runPromise(
          Effect.gen(function* () {
            const host = yield* Effect.serviceOption(ProjectSessionRuntimeHost);
            if (host._tag === "None") return yield* Effect.die("Local-only smoke hook");
            const integration = yield* host.value.runtimeIntegrations(
              input.workingDirectory,
              input.sessionId,
            );
            const templates = yield* Effect.promise(() =>
              prepareSkillWidgetTemplates(input.skills, integration.compileArtifactBrowser),
            );
            smokeWidgetTemplates = templates;
            return input.skills.map((skill) => {
              const template = templates(skill.name);
              return { name: skill.name, browser: template.browser };
            });
          }),
        );
      },
      cakeSmokeWorkflowSandbox(program: WorkflowProgram) {
        return mainRuntime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const decoded = yield* Schema.decodeUnknownEffect(WorkflowProgram)(program);
              const sandbox = yield* Effect.serviceOption(WorkflowSandbox);
              if (sandbox._tag === "None") return yield* Effect.die("Local-only smoke hook");
              return yield* sandbox.value.execute(decoded, {
                agent: (input) => Effect.succeed(input.prompt),
                phase: () => Effect.void,
                log: () => Effect.void,
              });
            }),
          ),
        );
      },
      cakeSmokeAppendBoard(sessionId: string, input: BoardAppendInput) {
        return mainRuntime.runPromise(
          Effect.gen(function* () {
            const services = yield* boardServices();
            const entry = yield* Schema.decodeUnknownEffect(BoardAppendInput)(input);
            return yield* messageBoards.append(sessionId, entry).pipe(Effect.provide(services));
          }),
        );
      },
      cakeSmokeReadBoard(sessionId: string, sequence: number) {
        return mainRuntime.runPromise(
          Effect.gen(function* () {
            const services = yield* boardServices();
            const supplied = yield* messageBoards
              .read(sessionId, [sequence])
              .pipe(Effect.provide(services));
            yield* messageBoards
              .recordIntake(sessionId, supplied.boardId, [sequence], "readAt")
              .pipe(Effect.provide(services));
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
        language?: "react" | "html";
        source: string;
        pluginState?: JsonValue;
        artifactState?: JsonValue;
        capability?: "artifact";
        expectedRevision?: number;
        cancelAfterMs?: number;
      }) {
        return mainRuntime.runPromise(
          Effect.gen(function* () {
            const packages = yield* Effect.serviceOption(WidgetPackages).pipe(
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
            const lineageId = yield* Schema.decodeUnknownEffect(ArtifactLineageId)(
              input.artifactId,
            );
            const before = yield* artifacts.read(lineageId);
            const outputs = yield* Effect.serviceOption(WidgetBrowserOutputs).pipe(
              Effect.flatMap((service) =>
                service._tag === "Some"
                  ? Effect.succeed(service.value)
                  : Effect.die("Local-only smoke hook"),
              ),
            );
            const compiled = yield* Effect.promise(() =>
              compileInlineWidget(
                input.language ?? "react",
                input.source,
                input.artifactState !== undefined || input.capability === "artifact"
                  ? "artifact"
                  : input.pluginState === undefined
                    ? "display"
                    : "session-plugin",
                { packageDirectory: packages.directory },
              ),
            );
            const widget = publishInlineWidget(compiled);
            const controller = new AbortController();
            const cancelTimer =
              input.cancelAfterMs === undefined
                ? undefined
                : setTimeout(() => controller.abort(), input.cancelAfterMs);
            const capture = yield* captures
              .capture(
                input.sessionId,
                widget,
                controller.signal,
                input.artifactState ?? input.pluginState,
              )
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (cancelTimer) clearTimeout(cancelTimer);
                    revokeInlineWidget(widget.token);
                  }),
                ),
              );
            const browser = yield* outputs.retain(compiled);
            const host = yield* Effect.serviceOption(ProjectSessionRuntimeHost).pipe(
              Effect.flatMap((service) =>
                service._tag === "Some"
                  ? Effect.succeed(service.value)
                  : Effect.die("Local-only smoke hook"),
              ),
            );
            const integration = yield* host.runtimeIntegrations(
              input.workingDirectory,
              input.sessionId,
            );
            if (!integration.persistArtifact)
              return yield* Effect.die("Missing artifact persistence");
            // Deterministic model boundary; compilation, pixels, repository CAS and linking are real.
            const generated = async (): Promise<InlineWidgetGenerationResult> => ({
              language: input.language ?? "react",
              source: input.source,
              generationSessionId: "smoke-review",
              browser,
              state: input.artifactState,
              preview: { mimeType: "image/png", data: capture.pngBase64 },
            });
            const registry = new CakeOperationRegistry(
              createCakeArtifactOperations(
                { appendEntry: () => undefined },
                {
                  ...integration,
                  persistArtifact: integration.persistArtifact,
                  generateInlineWidget: generated,
                  reviseInlineWidget: generated,
                },
              ),
            );
            const exactRef = `cake://artifact/${input.artifactId}@r${(input.expectedRevision ?? 0) + 1}`;
            const context = {
              signal: controller.signal,
              toolCallId: "smoke-publication",
              runtime: {
                sessionId: input.sessionId,
                sessionFile: "/smoke/parent.jsonl",
                entryId: "smoke-assistant",
              },
            };
            const publication = yield* Effect.promise(() =>
              registry.invoke(
                input.expectedRevision === undefined
                  ? {
                      command: "widgets.present",
                      input: {
                        widget: {
                          id: input.artifactId,
                          language: input.language ?? "react",
                          title: "Captured widget fixture",
                          brief: "Electron rendered-review fixture",
                          fallback: { markdown: "Captured widget fixture." },
                        },
                      },
                    }
                  : {
                      command: "artifacts.replace",
                      input: {
                        lineageId: input.artifactId,
                        expectedRevision: input.expectedRevision,
                        instructions:
                          "Surgically update the staged fixture scene, preserving unrelated manual edits.",
                      },
                    },
                context,
              ),
            );
            const retained = yield* Effect.promise(() =>
              registry.invoke(
                {
                  command: "artifacts.preview",
                  input: { reference: exactRef },
                },
                context,
              ),
            );
            const record = yield* artifacts.read(lineageId);
            yield* Effect.serviceOption(ArtifactProjection).pipe(
              Effect.flatMap((service) =>
                service._tag === "Some"
                  ? service.value.cleanupSession(input.sessionId)
                  : Effect.void,
              ),
            );
            return {
              pngBase64: capture.pngBase64,
              diagnostics: capture.diagnostics,
              stateVersion: (yield* artifacts.readState(lineageId)).version,
              persistedBeforeCapture: before !== undefined,
              persistedAfterCapture:
                record?.snapshot.kind === "widget" &&
                record.snapshot.payload.source === input.source,
              publishedImage: publication.content.find((block) => block.type === "image"),
              retainedImage: retained.content.find((block) => block.type === "image"),
              exactRef,
            };
          }),
        );
      },
      async cakeSmokeWidgetPackage(input: {
        operation: "list" | "install" | "remove";
        value?: string;
      }) {
        return mainRuntime.runPromise(
          Effect.gen(function* () {
            const packages = yield* Effect.serviceOption(WidgetPackages).pipe(
              Effect.flatMap((service) =>
                service._tag === "Some"
                  ? Effect.succeed(service.value)
                  : Effect.die("Local-only smoke hook"),
              ),
            );
            if (input.operation === "install")
              return yield* packages.install(
                yield* Schema.decodeUnknownEffect(WidgetPackageSpecifier)(input.value),
              );
            if (input.operation === "remove")
              return yield* packages.remove(
                yield* Schema.decodeUnknownEffect(WidgetPackageName)(input.value),
              );
            return yield* packages.list();
          }),
        );
      },
      async cakeSmokeInvokeArtifact(input: {
        sessionId: string;
        workingDirectory: string;
        command: string;
        input?: Record<string, JsonValue>;
      }) {
        return mainRuntime.runPromise(
          Effect.gen(function* () {
            const host = yield* Effect.serviceOption(ProjectSessionRuntimeHost).pipe(
              Effect.flatMap((service) =>
                service._tag === "Some"
                  ? Effect.succeed(service.value)
                  : Effect.die("Local-only smoke hook"),
              ),
            );
            const integration = yield* host.runtimeIntegrations(
              input.workingDirectory,
              input.sessionId,
            );
            if (!integration.persistArtifact)
              return yield* Effect.die("Missing artifact persistence");
            const options = {
              ...integration,
              persistArtifact: integration.persistArtifact,
              resolveWidgetTemplate: smokeWidgetTemplates,
            };
            const registry = new CakeOperationRegistry(
              createCakeArtifactOperations({ appendEntry: () => undefined }, options),
            );
            return yield* Effect.promise(() =>
              registry.invoke(
                { command: input.command, input: input.input },
                {
                  signal: new AbortController().signal,
                  toolCallId: "smoke-artifact-operation",
                  runtime: {
                    sessionId: input.sessionId,
                    sessionFile: "/smoke/parent.jsonl",
                    entryId: "smoke-assistant",
                  },
                },
              ),
            );
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
}

startMain();
