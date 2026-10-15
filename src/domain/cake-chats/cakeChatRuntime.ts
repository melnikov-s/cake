import { Context, Effect, Option, Schema } from "effect";
import * as projectSessionCreation from "../project-sessions/projectSessionCreation";
import * as sessionReferences from "../project-sessions/sessionReferences";
import { AgentProjectSessionCreate } from "../../contracts/project-sessions/session-reporting";
import { inputRefsSchema } from "../../contracts/conversations/task-input";
import { toJsonValue } from "../../utils/to-json-value";
import { forwardTaskInputControl, safeCoordinatorProjection } from "./taskInputControls";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { SavedDraftStorage } from "../../services/storage/SavedDraftStorage";
import { resolveCakeModelSelection } from "../model-presets/cake-model-selection";
import {
  getCakeChatInstructions,
  updateCakeChatInstructions,
  setSessionFastMode,
} from "../application/application";
import { PiModels } from "../../services/pi/PiModels";
import { defaultCakeChatPreferences } from "../../contracts/cake-chats/cake-chat-preferences";
import { utilityModelSelection } from "../utility-work/utilityWork";
import type { CakeChatTarget } from "../../contracts/cake-chats/cake-chat-data";
import type { CakeChatLocation } from "./cakeChatLocations";
import { makeSubagentControl } from "../subagents/subagentControl";
import * as workflowControl from "../workflows/workflow-control";
import { jsonObjectSchema } from "../../contracts/serialization/json-contract";
import type { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import type { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { RendererRequestCoordinator as RendererRequests } from "../../services/renderer-requests/RendererRequestCoordinator";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import type { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import { ApplicationState } from "../../services/storage/ApplicationState";
import type { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import type { CakeSessionRuntimeAcquireOptions } from "../../services/pi/CakeSessionRuntimes";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";

const CAKE_CHAT_OPERATIONS = [
  "app.state",
  "app.user-selection",
  "settings.cake-chat.get",
  "settings.cake-chat.update",
  "models.list",
  "session.info",
  "session.usage",
  "session.set-model",
  "context.status",
  "context.compact",
  "sessions.list",
  "sessions.info",
  "sessions.open",
  "sessions.create",
  "sessions.send",
  "sessions.send-batch",
  "sessions.reply",
  "sessions.thread",
  "sessions.close-thread",
  "sessions.abort",
  "sessions.rename",
  "sessions.resolve",
  "sessions.pending",
  "sessions.reorder",
  "sessions.cancel-queued",
  "sessions.steer-queued",
  "sessions.send-now",
  "sessions.clear-queue",
  "sessions.schedule",
  "sessions.scheduled",
  "sessions.cancel-scheduled",
  "session-labels.list",
  "sessions.set-labels",
  "subagents.start",
  "subagents.follow-up",
  "subagents.abort",
  "subagents.close",
  "notifications.send",
  "workflows.start",
  "workflows.propose",
  "workflows.list",
  "workflows.inspect",
  "workflows.pause",
  "workflows.resume",
  "workflows.stop",
  "workflows.relaunch",
  "workflows.stopWorker",
  "workflows.restartWorker",
  "workflows.inspectWorker",
  "workflows.saved",
  "workflows.save",
  "workflows.authoring",
] as const;

export interface CakeChatRuntimeConfiguration {
  readonly location: CakeChatLocation;
  readonly agentDirectory: string;
}

/** The single Cake-owned composition point for Cake Chat Pi acquisition. */
export const acquireOptions = Effect.fn("CakeChats.acquireOptions")(function* ({
  configuration,
  target,
  newSession,
}: {
  readonly configuration: CakeChatRuntimeConfiguration;
  readonly target: CakeChatTarget;
  readonly newSession: boolean;
}) {
  const application = yield* ApplicationState;
  const models = yield* PiModels;
  const catalogs = yield* SessionCatalogChanges;
  const rendererRequests = yield* RendererRequests;
  const context = yield* Effect.context<
    | ApplicationState
    | PiModels
    | CakeSessionRuntimes
    | RendererRequestCoordinator
    | SessionArchiveStorage
    | SessionCatalogChanges
    | SubagentCoordinator
    | SubagentEnvironment
    | Effect.Services<ReturnType<typeof projectSessionCreation.createPrompted>>
    | TaskInputStorage
    | Effect.Services<ReturnType<typeof workflowControl.invoke>>
    | Effect.Services<ReturnType<typeof sessionReferences.catalog>>
  >();
  const drafts = yield* Effect.serviceOption(SavedDraftStorage);
  const run = makePiCallbackExecutor(
    Option.isSome(drafts) ? Context.add(context, SavedDraftStorage, drafts.value) : context,
  );
  const agentControl = makeSubagentControl({
    runEffect: (effect, signal) => run(effect, { signal }),
  });
  const modelPresets = () => {
    const state = application.snapshot();
    return {
      presets: state.modelPresets.map((preset) => ({ ...preset })),
      defaultPresetId: state.defaultModelPresetId,
    };
  };
  const getRuntimeOptions = () => runtimeOptions;
  const runtimeOptions: CakeSessionRuntimeAcquireOptions = {
    profile: { _tag: "CakeChatSession" },
    onSessionChanged: catalogs.publish({
      _tag: "CakeChatSessionChanged",
      sessionId: target.sessionId,
      resolved: false,
    }),
    onRelease: rendererRequests.releaseSession({
      _tag: "CakeChatSession",
      sessionId: target.sessionId,
    }),
    runtime: {
      cwd: configuration.location.workingDirectory,
      sessionReferences: {
        resolve: (reference, signal) => run(sessionReferences.resolve(reference), { signal }),
        project: (value, signal) => run(sessionReferences.project(value), { signal }),
        ids: (signal) =>
          run(
            sessionReferences
              .catalog()
              .pipe(Effect.map((roster) => roster.map((entry) => entry.sessionId))),
            { signal },
          ),
      },
      trusted: true,
      agentDir: configuration.agentDirectory,
      sessionDir: configuration.location.sessionDirectory,
      newSession,
      sessionId: target.sessionId,
      // Pin the complete Cake Chat toolset instead of relying on Pi's default-tool
      // selection, which does not necessarily activate extension tools.
      tools: ["cake", "zoom", "date"],
      allowedCakeOperations: CAKE_CHAT_OPERATIONS,
      cakeChatInstructions: {
        get: (signal) => run(getCakeChatInstructions(), { signal }),
        update: (input, signal) => run(updateCakeChatInstructions(input), { signal }),
      },
      cakeChatMemory: {
        preferences: () =>
          application.snapshot().cakeChatPreferences ?? defaultCakeChatPreferences(),
        summarize: (input) => {
          const state = application.snapshot();
          const model = state.cakeChatPreferences?.summarizationModel ?? state.utilityModel;
          if (!model)
            return Promise.reject(
              new Error(
                "Configure a utility model or Cake Chat summarization model in Settings to continue.",
              ),
            );
          return run(
            models.complete(
              {
                selection: utilityModelSelection(model),
                instructions: input.instructions,
                context: input.context,
                maximumOutputCharacters: 4_096,
                timeoutMs: 120_000,
              },
              input.observeRequest,
            ),
            { signal: input.signal },
          );
        },
      },
      slashCommands: ["compact", "model"],
      requestUi: async () => undefined,
      modelPresets,
      resolveModelSelection: (selection, fallback) =>
        resolveCakeModelSelection(selection, modelPresets(), fallback),
      fastMode: {
        get: () => application.snapshot().fastModeSessionIds.includes(target.sessionId),
        set: (enabled) => run(setSessionFastMode(target.sessionId, enabled)).then(() => undefined),
      },
      sessionTitleChanged: (sessionId) =>
        run(
          catalogs.publish({
            _tag: "CakeChatSessionChanged",
            sessionId,
            resolved: false,
          }),
        ),
      agentControl: agentControl(getRuntimeOptions, configuration.location.workingDirectory),
      workflowControl: {
        isEnabled: () => application.snapshot().experimentalFeatures?.dynamicWorkflows === true,
        invoke: (command, input, signal) =>
          run(
            workflowControl.invoke(
              command,
              input,
              { _tag: "CakeChatSession", sessionId: target.sessionId },
              signal,
            ),
            { signal },
          ),
      },
      globalControl: {
        tools: target.tools.map((tool) => ({
          ...tool,
          parameters: Schema.decodeUnknownSync(jsonObjectSchema)(tool.parameters),
          examples: tool.examples?.map((example) => ({
            ...example,
            input:
              example.input === undefined
                ? undefined
                : Schema.decodeUnknownSync(jsonObjectSchema)(example.input),
          })),
        })),
        // Pi requires a Promise callback; this is the final adapter from the
        // Cake-owned control Effect to the Pi runtime callback contract.
        invoke: (invocation, signal) =>
          run(
            Effect.gen(function* () {
              const inputs = yield* TaskInputStorage;
              const argumentsObject = yield* Schema.decodeUnknownEffect(jsonObjectSchema)(
                invocation.arguments,
              );
              if (Schema.is(Schema.String)(argumentsObject.sessionId))
                invocation = {
                  ...invocation,
                  arguments: {
                    ...argumentsObject,
                    sessionId: yield* sessionReferences.resolve(argumentsObject.sessionId),
                  },
                };
              const args = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ sessionId: Schema.optionalKey(Schema.String) }),
              )(invocation.arguments);
              const forwarded = yield* forwardTaskInputControl(target.sessionId, invocation);
              // No backdoor via target inspection or selected preview text.
              if (invocation.name === "app.user-selection")
                return {
                  ok: false,
                  error:
                    "Cake Chat cannot read attachment previews or selected session content. Share text explicitly in your message.",
                };
              if (
                invocation.name.startsWith("sessions.") &&
                ![
                  "sessions.send",
                  "sessions.open",
                  "sessions.abort",
                  "sessions.rename",
                  "sessions.resolve",
                  "sessions.set-labels",
                ].includes(invocation.name) &&
                args.sessionId !== undefined &&
                (yield* inputs.isRecipient(args.sessionId))
              )
                return {
                  ok: false,
                  error:
                    "This session contains task inputs. Open the Project Session to inspect its content.",
                };
              const result =
                invocation.name === "sessions.create"
                  ? yield* Effect.scoped(
                      Effect.gen(function* () {
                        const input = yield* Schema.decodeUnknownEffect(AgentProjectSessionCreate)(
                          forwarded.arguments,
                        );
                        const selected = yield* Schema.decodeUnknownEffect(
                          Schema.Struct({ inputRefs: inputRefsSchema }),
                        )(forwarded.arguments);
                        return toJsonValue(
                          yield* projectSessionCreation.createPrompted({
                            ...input,
                            projectPath: input.workspacePath,
                            sourceSessionId: target.sessionId,
                            attachments: selected.inputRefs.map((reference) => ({
                              kind: "forwarded-input" as const,
                              name: "Attachment",
                              reference,
                            })),
                            requester: {
                              sessionId: target.sessionId,
                              kind: "cake-chat",
                              title: "Cake Chat",
                            },
                          }),
                        );
                      }),
                    )
                  : yield* rendererRequests.requestCakeChatControl(
                      target.sessionId,
                      forwarded,
                      signal,
                    );
              return yield* safeCoordinatorProjection(result);
            }).pipe(Effect.orDie),
            { signal },
          ),
      },
    },
  };
  return runtimeOptions;
});
