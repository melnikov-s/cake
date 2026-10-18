import { messageReference } from "../../contracts/conversations/message-reference";
import { makeVscodeControl } from "../../services/pi/VscodeControlAdapter";
import { VsCodeServer } from "../../services/vscode/VsCodeServer";
import { cakeRpcPayloadSchemas } from "../../contracts/application/cake-rpc-contract";
import type { JsonObject } from "../../contracts/serialization/json-contract";
import type { BrowserControl } from "../../contracts/browser/browser-agent-control";
import { Context, Effect, Option, Schema } from "effect";
import * as backendAgentControl from "../application/agentControl";
import { validateMessageReferenceControl } from "../conversations/messageReferenceForwarding";
import { grantMessageAttachments } from "../conversations/messageReferenceAccess";
import * as messageReferences from "../conversations/messageReferences";
import { messageNavigationTarget } from "../../contracts/conversations/message-reference";
import { makeAttachmentReferenceControl } from "../conversations/attachmentReferences";
import * as projectSessionCreation from "../project-sessions/projectSessionCreation";
import * as sessionReferences from "../project-sessions/sessionReferences";
import * as projects from "../projects/projects";
import { AgentProjectSessionCreate } from "../../contracts/project-sessions/session-reporting";
import { inputRefsSchema } from "../../contracts/conversations/task-input";
import { toJsonValue } from "../../utils/to-json-value";
import { forwardTaskInputControl, safeCoordinatorProjection } from "./taskInputControls";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { SavedDraftStorage } from "../../services/storage/SavedDraftStorage";
import {
  cakeModelCatalog,
  resolveCakeModelChoice,
  resolveCakeModelSelection,
} from "../model-presets/cake-model-selection";
import {
  getCakeChatInstructions,
  updateCakeChatInstructions,
  setSessionFastMode,
} from "../application/application";
import { PiModels } from "../../services/pi/PiModels";
import {
  cakeChatModelSettingDefaults,
  defaultCakeChatPreferences,
} from "../../contracts/cake-chats/cake-chat-preferences";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { CakeChatTarget } from "../../contracts/cake-chats/cake-chat-data";
import {
  CakeChatConfiguration,
  type CakeChatRuntimeConfiguration,
} from "../../services/pi-durable/CakeChatConfiguration";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { SessionCoordination } from "../../services/session-catalogs/SessionCoordination";
import * as sessionFamilies from "../session-families/sessionFamilies";
import { implicitTurnResultFor } from "../../contracts/pi/turn-result-data";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
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
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import type { CakeSessionRuntimeAcquireOptions } from "../../services/pi/CakeSessionRuntimes";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";
import * as worktreeMerges from "../worktrees/worktreeMerges";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import { WorktreeLandingAgent } from "../../services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCompletion } from "../../services/worktrees/WorktreeLandingCompletion";

import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { ArtifactProjection } from "../../services/artifacts/ArtifactProjection";
import { ClientEvents } from "../../services/clients/ClientEvents";
import * as agentArtifactAccess from "../artifacts/agentArtifactAccess";
import * as artifactState from "../artifacts/artifactState";
import { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";

const CAKE_CHAT_OPERATIONS = [
  "artifacts.link",
  "artifacts.present",
  "artifacts.state.read",
  "artifacts.selection.capture",
  "artifacts.source",
  "browser.enter",
  "browser.cdp",
  "browser.events",
  "vscode.enter",
  "vscode.open",
  "vscode.script.run",
  "vscode.selections.list",
  "vscode.selections.remove",
  "vscode.selections.clear",
  "attachments.list",
  "attachments.read",
  "messages.list",
  "messages.read",
  "messages.open",
  "app.state",
  "app.user-selection",
  "settings.cake-chat.get",
  "settings.cake-chat.update",
  "models.list",
  "models.info",
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
  "sessions.reports",
  "sessions.reports.read",
  "sessions.reports.acknowledge",
  "sessions.completions",
  "sessions.completions.update",
  "sessions.abort",
  "sessions.rename",
  "sessions.resolve",
  "sessions.pending",
  "sessions.pending-info",
  "sessions.reorder",
  "sessions.cancel-queued",
  "sessions.steer-queued",
  "sessions.send-now",
  "sessions.clear-queue",
  "sessions.schedule",
  "sessions.scheduled",
  "sessions.scheduled-info",
  "sessions.cancel-scheduled",
  "session-labels.list",
  "sessions.set-labels",
  "projects.list",
  "projects.info",
  "projects.add",
  "projects.rename",
  "projects.remove",
  "worktrees.merge",
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
  "workflows.inspect-saved",
  "workflows.save",
  "workflows.authoring",
] as const;

export type CakeChatRuntimeServices =
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
  | Effect.Services<ReturnType<typeof projects.addForAgent>>
  | Effect.Services<ReturnType<typeof projects.renameForAgent>>
  | Effect.Services<ReturnType<typeof worktreeMerges.resolveSessionWorktree>>
  | Exclude<
      Effect.Services<ReturnType<typeof worktreeMerges.merge>>,
      WorktreeLandingCoordinator | WorktreeLandingAgent | WorktreeLandingCompletion
    >;

/** Shared composition for global and project-scoped permanent chats. */
export const acquireOptions = Effect.fn("CakeChats.acquireOptions")(function* ({
  configuration,
  target,
  newSession,
}: {
  readonly configuration: CakeChatRuntimeConfiguration;
  readonly target: CakeChatTarget;
  readonly newSession: boolean;
}): Effect.fn.Return<CakeSessionRuntimeAcquireOptions, never, CakeChatRuntimeServices> {
  const application = yield* ApplicationState;
  const models = yield* PiModels;
  const catalogs = yield* SessionCatalogChanges;
  const rendererRequests = yield* RendererRequests;
  const context = yield* Effect.context<CakeChatRuntimeServices>();
  const landingCoordinator = yield* Effect.serviceOption(WorktreeLandingCoordinator);
  const landingAgent = yield* Effect.serviceOption(WorktreeLandingAgent);
  const landingCompletion = yield* Effect.serviceOption(WorktreeLandingCompletion);
  const drafts = yield* Effect.serviceOption(SavedDraftStorage);
  const chatConfiguration = yield* Effect.serviceOption(CakeChatConfiguration);
  const configuredContext = Option.isSome(chatConfiguration)
    ? Context.add(context, CakeChatConfiguration, chatConfiguration.value)
    : context;
  const run = makePiCallbackExecutor(
    Option.isSome(drafts)
      ? Context.add(configuredContext, SavedDraftStorage, drafts.value)
      : configuredContext,
  );
  const agentControl = makeSubagentControl({
    runEffect: (effect, signal) => run(effect, { signal }),
  });
  const vscode = yield* Effect.serviceOption(VsCodeServer);
  const families = yield* SessionFamilyStorage;
  const archive = yield* SessionArchiveStorage;
  const artifactStorage = yield* Effect.serviceOption(ArtifactStorage);
  const artifactProjection = yield* Effect.serviceOption(ArtifactProjection);
  const clientEvents = yield* Effect.serviceOption(ClientEvents);
  const runArtifact = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      ArtifactStorage | ArtifactProjection | ClientEvents | SessionFamilyStorage
    >,
  ) => {
    if (
      Option.isNone(artifactStorage) ||
      Option.isNone(artifactProjection) ||
      Option.isNone(clientEvents)
    )
      return Promise.reject(new Error("Artifact source access is unavailable"));
    return run(
      effect.pipe(
        Effect.provideService(ArtifactStorage, artifactStorage.value),
        Effect.provideService(ArtifactProjection, artifactProjection.value),
        Effect.provideService(ClientEvents, clientEvents.value),
        Effect.provideService(SessionFamilyStorage, families),
      ),
    );
  };
  const coordination = yield* SessionCoordination;
  const project = application
    .snapshot()
    .projects.find(
      (item) =>
        item.path === configuration.location.workingDirectory &&
        target.sessionId !== CAKE_CHAT_SESSION_ID,
    );
  const title = project ? `${project.name} / Project Chat` : "Cake Chat";
  const modelPresets = () => cakeModelCatalog(application.snapshot());
  const getRuntimeOptions = () => runtimeOptions;
  const browserRequest = async (
    operation: "enter" | "cdp" | "events",
    fields: {
      method?: string;
      params?: JsonObject;
      methods?: readonly string[];
      limit?: number;
      clear?: boolean;
    },
    signal: AbortSignal,
  ) => {
    const result = await run(
      rendererRequests.requestBrowserNative(
        target.sessionId,
        {
          operation,
          workspacePath: configuration.location.workingDirectory,
          ...fields,
        },
        signal,
      ),
      { signal },
    );
    const decoded = await Schema.decodeUnknownPromise(
      cakeRpcPayloadSchemas["respond-browser-native"].fields.result,
    )(result);
    if (decoded.status === "failed") throw new Error(decoded.message);
    return decoded;
  };
  const browserControl: BrowserControl = {
    enter: async (signal) => {
      const result = await browserRequest("enter", {}, signal);
      if (result.status !== "completed") throw new Error("Browser Mode is unavailable");
    },
    cdp: (method, params, signal) => browserRequest("cdp", { method, params }, signal),
    events: (methods, limit, clear, signal) =>
      browserRequest("events", { methods, limit, clear }, signal),
  };
  const runtimeOptions: CakeSessionRuntimeAcquireOptions = {
    profile: { _tag: "CakeChatSession" },
    admitTurn: (input, accept) => {
      const message = parseCrossSessionMessage(input.text);
      return coordination.checkStorage().pipe(
        Effect.andThen(
          sessionFamilies
            .admitTurn(
              target.sessionId,
              {
                cwd: configuration.location.workingDirectory,
                activeRoot: configuration.location.sessionDirectory,
                resolvedRoot: configuration.location.sessionDirectory,
              },
              input,
              message
                ? coordination
                    .bindTurn(target.sessionId, message.metadata.messageId, input.turnId)
                    .pipe(Effect.andThen(accept))
                : accept,
            )
            .pipe(
              Effect.provideService(SessionFamilyStorage, families),
              Effect.provideService(SessionArchiveStorage, archive),
            ),
        ),
      );
    },
    onTurnSettled: (event) =>
      Effect.gen(function* () {
        yield* coordination.settleTurn(event.turnId, event.outcome);
        const turn = (yield* families.state()).turns.find((item) => item.turnId === event.turnId);
        const text = turn ? implicitTurnResultFor(event.result, turn.senderSessionId) : undefined;
        if (turn)
          yield* families.settleTurn(
            event.turnId,
            event.outcome,
            text
              ? {
                  outcome: "result",
                  text,
                  ...(event.result?.entryId
                    ? { resultMessageRef: messageReference(target.sessionId, event.result.entryId) }
                    : null),
                }
              : undefined,
            event.stop,
          );
        yield* catalogs.publish({
          _tag: "CakeChatSessionChanged",
          sessionId: target.sessionId,
          resolved: false,
        });
      }),
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
      additionalSystemPrompt: project
        ? [
            "## Project Chat scope",
            `You are the permanent Project Chat for ${JSON.stringify(project.name)} at ${JSON.stringify(project.path)}.`,
            `Your messaging address is ${target.sessionId}. Your history and memory belong only to this project; global Cake Chat is a separate conversation at cake-chat.`,
            "Keep this conversation focused on the project. You can discuss ideas and decisions without creating tasks. Delegate only when useful, using this project's root as the default.",
            "VS Code and the interactive Terminal open at this project root; Browser Mode belongs to this conversation. Use these shared tools for visual exploration while keeping discussion primary.",
            "Other chats have independent memories. Exchange a focused request and relevant references, not entire histories. Do not repeatedly relay or delegate the same request.",
            project.settings?.customInstructions,
          ]
            .filter(Boolean)
            .join("\n\n")
        : undefined,
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
      trusted: !project || application.snapshot().trustedProjectPaths.includes(project.path),
      agentDir: configuration.agentDirectory,
      sessionDir: configuration.location.sessionDirectory,
      newSession,
      sessionId: target.sessionId,
      // Pin the complete Cake Chat toolset instead of relying on Pi's default-tool
      // selection, which does not necessarily activate extension tools.
      tools: ["cake", "zoom", "date", "read", "bash", "mcp"],
      allowedCakeOperations: CAKE_CHAT_OPERATIONS,
      resolveArtifact: (reference) =>
        runArtifact(agentArtifactAccess.resolve(target.sessionId, reference)),
      resolveArtifactForPresentation: (reference) =>
        runArtifact(agentArtifactAccess.resolveForPresentation(target.sessionId, reference)),
      linkArtifact: (reference) =>
        runArtifact(agentArtifactAccess.link(target.sessionId, reference)),
      readArtifactState: (lineageId) =>
        runArtifact(
          Effect.gen(function* () {
            return yield* artifactState.read({
              sessionId: target.sessionId,
              lineageId: yield* Schema.decodeUnknownEffect(ArtifactLineageId)(lineageId),
            });
          }),
        ),
      cakeChatWorktrees: {
        merge: (reference, signal) =>
          run(
            Effect.gen(function* () {
              if (
                Option.isNone(landingCoordinator) ||
                Option.isNone(landingAgent) ||
                Option.isNone(landingCompletion)
              )
                return yield* Effect.fail(new Error("Managed Worktree landing is unavailable"));
              const worktree = yield* worktreeMerges.resolveSessionWorktree(
                yield* sessionReferences.resolve(reference),
              );
              return toJsonValue(
                yield* worktreeMerges
                  .merge({ ...worktree, callerSessionId: target.sessionId })
                  .pipe(
                    Effect.provideService(WorktreeLandingCoordinator, landingCoordinator.value),
                    Effect.provideService(WorktreeLandingAgent, landingAgent.value),
                    Effect.provideService(WorktreeLandingCompletion, landingCompletion.value),
                  ),
              );
            }),
            { signal },
          ),
      },
      cakeChatProjects: {
        list: (input, signal) =>
          run(projects.listForAgent(input).pipe(Effect.map(toJsonValue)), { signal }),
        info: (input, signal) =>
          run(projects.infoForAgent(input).pipe(Effect.map(toJsonValue)), { signal }),
        add: (input, signal) =>
          run(projects.addForAgent(input).pipe(Effect.map(toJsonValue)), { signal }),
        rename: (input, signal) =>
          run(projects.renameForAgent(input).pipe(Effect.map(toJsonValue)), { signal }),
        // Removal retires window navigation and session history, so it runs through the
        // invoking window's sidebar removal workflow rather than only the main transaction.
        remove: (input, signal) =>
          run(
            rendererRequests.requestCakeChatControl(
              target.sessionId,
              { name: "projects.remove", arguments: { ...input } },
              signal,
            ),
            { signal },
          ),
      },
      cakeChatInstructions: {
        get: (signal) => run(getCakeChatInstructions(), { signal }),
        update: (input, signal) => run(updateCakeChatInstructions(input), { signal }),
      },
      cakeChatMemory: {
        preferences: () =>
          application.snapshot().cakeChatPreferences ?? defaultCakeChatPreferences(),
        summarize: (input) => {
          const state = application.snapshot();
          let selection;
          try {
            selection = resolveCakeModelChoice(
              state.cakeChatPreferences?.summarizationModel ??
                cakeChatModelSettingDefaults.summarizationModel,
              cakeModelCatalog(state),
              input.caller,
            );
          } catch (error) {
            return Promise.reject(error);
          }
          return run(
            models.complete(
              {
                selection,
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
      browserControl,
      vscodeControl: project
        ? makeVscodeControl({
            request: (name, input, signal) =>
              run(
                rendererRequests.requestCakeChatControl(
                  target.sessionId,
                  { name, arguments: input },
                  signal,
                ),
                { signal },
              ),
            runScript: (source, input, signal) => {
              if (Option.isNone(vscode))
                return Promise.reject(new Error("VS Code is unavailable in this host"));
              return run(vscode.value.runProjectScript(project.path, source, input), { signal });
            },
          })
        : undefined,
      slashCommands: ["compact", "model"],
      requestUi: async () => undefined,
      modelPresets,
      resolveModelSelection: (selection, caller, launch) =>
        resolveCakeModelSelection(selection, modelPresets(), caller, launch),
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
      attachmentReferenceControl: makeAttachmentReferenceControl(target.sessionId, run),
      messageReferenceControl: {
        list: (input, signal) =>
          run(Effect.scoped(messageReferences.list(input).pipe(Effect.map(toJsonValue))), {
            signal,
          }),
        read: (input, signal) =>
          run(
            Effect.scoped(
              messageReferences.read(input).pipe(
                Effect.tap((result) => grantMessageAttachments(target.sessionId, result.message)),
                Effect.map(toJsonValue),
              ),
            ),
            { signal },
          ),
        open: (input, signal) =>
          run(
            rendererRequests.requestCakeChatControl(
              target.sessionId,
              { name: "sessions.open", arguments: messageNavigationTarget(input.ref) },
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
              // Project Sessions reach Cake Chat by omitting sessionId; Cake Chat cannot message itself.
              if (
                invocation.name === "sessions.send" &&
                (args.sessionId === undefined || args.sessionId === target.sessionId)
              )
                return {
                  ok: false,
                  command: "sessions.send",
                  error:
                    "Cake Chat cannot message itself. Omitting sessionId addresses Cake Chat only when a Project Session sends; from Cake Chat, pass the target Project Session's sessionId (see sessions.list).",
                };
              yield* Effect.scoped(validateMessageReferenceControl(invocation));
              const forwarded = yield* forwardTaskInputControl(target.sessionId, invocation);
              // Explicit selection reads are allowed. Attachment pixels use the scoped
              // attachments.read capability rather than renderer previews or filesystem paths.
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
                              title,
                            },
                          }),
                        );
                      }),
                    )
                  : ((yield* Effect.scoped(
                      backendAgentControl.invoke(forwarded.name, forwarded.arguments, {
                        kind: "cake-chat",
                        sessionId: target.sessionId,
                        title,
                      }),
                    )) ??
                    (yield* rendererRequests.requestCakeChatControl(
                      target.sessionId,
                      forwarded,
                      signal,
                    )));
              return yield* safeCoordinatorProjection(result);
            }).pipe(Effect.orDie),
            { signal },
          ),
      },
    },
  };
  return runtimeOptions;
});
