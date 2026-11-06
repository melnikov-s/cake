import { messageReference } from "../../contracts/conversations/message-reference";
import { AutomationEvents } from "../../services/automations/AutomationEvents";
import { automationToolDescriptions } from "../../contracts/automations/agent-automations";
import { publishChat as publishChatAutomationEvent } from "../automations/automationSourceEvents";
import { parseScheduledMessage } from "../../contracts/conversations/scheduled-message-envelope";
import { cakeChatBuiltinSlashCommands } from "../../contracts/conversations/session-contract";
import { agentSettingsOperations } from "../../contracts/application/agent-settings-schema";
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
import { reuseRecent } from "../../utils/reuse-recent";
import * as sessionReferences from "../project-sessions/sessionReferences";
import * as projectSessionMetadata from "../project-sessions/projectSessionMetadata";
import { projectChatSessionId } from "./cakeChatLocations";
import { CakeChatDurable } from "../../services/pi-durable/CakeChatDurable";
import * as projects from "../projects/projects";
import * as projectTodoAssociations from "../projects/projectTodoAssociations";
import * as projectTodos from "../projects/projectTodos";
import {
  CAKE_CHAT_TODO_SCOPE,
  emptyProjectTodos,
  projectTodoBaseline,
} from "../../contracts/projects/project-todos";
import { projectTodoReceipt } from "../../contracts/projects/project-todo-context";
import { splitSessionDigestReminder } from "../../contracts/cake-chats/session-digest-reminder";
import * as projectChatInstructions from "../projects/projectChatInstructions";
import { AgentProjectSessionCreate } from "../../contracts/project-sessions/session-reporting";
import type {
  ProjectSettingsGetInput,
  ProjectSettingsUpdateInput,
} from "../../contracts/projects/project-settings-schema";
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
  defaultAssistantPreferences,
} from "../../contracts/cake-chats/cake-chat-preferences";
import { SESSION_ASSISTANT_ID } from "../../contracts/cake-chats/cake-chat-identity";
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
import { SubagentStorage } from "../../services/storage/SubagentStorage";
import { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import { ProjectTodoReports } from "../../services/projects/ProjectTodoReports";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import type { CakeSessionRuntimeAcquireOptions } from "../../services/pi/CakeSessionRuntimes";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";
import * as worktreeMerges from "../worktrees/worktreeMerges";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import { WorktreeLandingAgent } from "../../services/worktrees/WorktreeLandingAgent";
import { themeOperationDefinitions } from "../../contracts/themes/theme-operations";
import { WorktreeLandingCompletion } from "../../services/worktrees/WorktreeLandingCompletion";

import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { ArtifactProjection } from "../../services/artifacts/ArtifactProjection";
import { ClientEvents } from "../../services/clients/ClientEvents";
import * as agentArtifactAccess from "../artifacts/agentArtifactAccess";
import * as artifactWorkflows from "../artifacts/artifactWorkflows";
import { artifactRevisionToRecord } from "../../contracts/artifacts/artifact-lineage";
import * as artifactState from "../artifacts/artifactState";
import { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";

const SHARED_VSCODE_OPERATIONS = [
  "vscode.enter",
  "vscode.open",
  "vscode.script.run",
  "vscode.selections.add",
  "vscode.selections.set",
  "vscode.selections.list",
  "vscode.selections.remove",
  "vscode.selections.clear",
] as const;

const CAKE_CHAT_OPERATIONS = [
  ...automationToolDescriptions.map((description) => description.command),
  ...Object.keys(themeOperationDefinitions),
  "html.present",
  "artifacts.link",
  "artifacts.present",
  "artifacts.state.read",
  "artifacts.selection.capture",
  "artifacts.source",
  "browser.enter",
  "browser.cdp",
  "browser.events",
  ...SHARED_VSCODE_OPERATIONS,
  "attachments.list",
  "attachments.read",
  "messages.list",
  "messages.read",
  "messages.open",
  "messages.present",
  "app.state",
  "app.user-selection",
  "settings.cake-chat.get",
  "settings.cake-chat.update",
  "settings.project-chat.get",
  "settings.project-chat.update",
  // Every user setting the Settings UI offers, through the same authorities.
  "settings.window.get",
  "settings.window.update",
  ...agentSettingsOperations.map((operation) => operation.command),
  "todos.list",
  "todos.read",
  "todos.create",
  "todos.update",
  "todos.update-many",
  "todos.select",
  "todos.snooze",
  "todos.unsnooze",
  "models.list",
  "models.info",
  "models.reference",
  "session.info",
  "session.usage",
  "session.set-model",
  "context.status",
  "context.compact",
  "sessions.list",
  "sessions.info",
  "sessions.compact",
  "sessions.compact-batch",
  "sessions.tool-compact",
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
  "sessions.update-queued",
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
  "projects.settings.get",
  "projects.settings.update",
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
  sideChatSessionId,
}: {
  readonly sideChatSessionId?: string;
  readonly configuration: CakeChatRuntimeConfiguration;
  readonly target: CakeChatTarget;
  readonly newSession: boolean;
}): Effect.fn.Return<CakeSessionRuntimeAcquireOptions, never, CakeChatRuntimeServices> {
  const application = yield* ApplicationState;
  const companion = target.sessionId === SESSION_ASSISTANT_ID;
  const senderSessionId = sideChatSessionId ?? target.sessionId;
  const models = yield* PiModels;
  const catalogs = yield* SessionCatalogChanges;
  const rendererRequests = yield* RendererRequests;
  const context = Context.add(
    yield* Effect.context<CakeChatRuntimeServices>(),
    SubagentStorage,
    (yield* SubagentCoordinator).storage,
  );
  const landingCoordinator = yield* Effect.serviceOption(WorktreeLandingCoordinator);
  const landingAgent = yield* Effect.serviceOption(WorktreeLandingAgent);
  const landingCompletion = yield* Effect.serviceOption(WorktreeLandingCompletion);
  const drafts = yield* Effect.serviceOption(SavedDraftStorage);
  const chatConfiguration = yield* Effect.serviceOption(CakeChatConfiguration);
  const todoReports = yield* Effect.serviceOption(ProjectTodoReports);
  const reportContext = Option.isSome(todoReports)
    ? Context.add(context, ProjectTodoReports, todoReports.value)
    : context;
  const configuredContext = Option.isSome(chatConfiguration)
    ? Context.add(reportContext, CakeChatConfiguration, chatConfiguration.value)
    : reportContext;
  const run = makePiCallbackExecutor(
    Option.isSome(drafts)
      ? Context.add(configuredContext, SavedDraftStorage, drafts.value)
      : configuredContext,
  );
  // Every model request whose context holds a cross-session message shortens its references
  // against all known sessions. Share one discovery per minute; the full ID always resolves.
  const sessionReferenceIds = reuseRecent(60_000, () =>
    run(
      sessionReferences
        .catalog()
        .pipe(Effect.map((roster) => roster.map((entry) => entry.sessionId))),
    ),
  );
  const agentControl = makeSubagentControl({
    runEffect: (effect, signal) => run(effect, { signal }),
  });
  const vscode = yield* Effect.serviceOption(VsCodeServer);
  const durable = yield* Effect.serviceOption(CakeChatDurable);
  const families = yield* SessionFamilyStorage;
  const automationEvents = yield* Effect.serviceOption(AutomationEvents);
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
        target.sessionId !== CAKE_CHAT_SESSION_ID &&
        !companion,
    );
  // Resolve on every call: Companion's runtime/history remain app-wide as the user moves.
  const vscodeWorkingDirectory = Effect.fn("CakeChats.vscodeWorkingDirectory")(function* () {
    if (project) return project.path;
    const sessionId = Option.isSome(durable)
      ? yield* durable.value.assistantContextSessionId()
      : undefined;
    if (!sessionId || sessionId === SESSION_ASSISTANT_ID || sessionId === CAKE_CHAT_SESSION_ID)
      return yield* Effect.fail(
        new Error(
          "Companion has no project editor context. Open a Project Chat or Project Session, call vscode.enter, then retry.",
        ),
      );
    const viewedProject = application
      .snapshot()
      .projects.find((item) => projectChatSessionId(item.path) === sessionId);
    if (viewedProject) return viewedProject.path;
    const draft = Option.isSome(drafts)
      ? (yield* drafts.value.list()).find((item) => item.sessionId === sessionId)
      : undefined;
    if (draft) return draft.workingDirectory;
    return (yield* projectSessionMetadata.findLocation({ sessionId })).workingDirectory;
  });
  const title = companion ? "Companion" : project ? `${project.name} / Project Chat` : "Cake Chat";
  /** Same backend authority, receipts and ProjectAccess check as every other settings writer.
   * A Project Chat's caller carries its Project, so the handler rejects every other path. */
  const invokeProjectSettings = (
    command: "projects.settings.get" | "projects.settings.update",
    input: ProjectSettingsGetInput | ProjectSettingsUpdateInput,
  ) =>
    Effect.scoped(
      backendAgentControl.invoke(command, toJsonValue(input), {
        kind: "cake-chat",
        sessionId: target.sessionId,
        title,
        ...(project ? { projectPath: project.path } : null),
      }),
    ).pipe(
      Effect.flatMap((result) => {
        const failure = Schema.decodeUnknownOption(
          Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
        )(result);
        return Option.isSome(failure)
          ? Effect.fail(new Error(failure.value.error))
          : Effect.succeed(result ?? null);
      }),
    );
  /** Project Chat edits its Project's to-do list; global Cake Chat keeps its own list. */
  const todoScope = project?.path ?? CAKE_CHAT_TODO_SCOPE;
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
      const userText =
        input.internal === undefined
          ? input.text
          : input.internal._tag === "UserWithReminders"
            ? input.internal.userText
            : undefined;
      const sourceEvent =
        Option.isSome(automationEvents) &&
        !companion &&
        userText !== undefined &&
        !message &&
        !parseScheduledMessage(input.text)
          ? publishChatAutomationEvent({
              event: "user-message-received",
              eventId: input.turnId,
              sessionId: target.sessionId,
              text: userText,
              ...(project === undefined ? null : { projectPath: project.path }),
            }).pipe(Effect.provideService(AutomationEvents, automationEvents.value))
          : Effect.void;
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
        Effect.andThen(sourceEvent),
      );
    },
    onTurnSettled: (event) =>
      Effect.gen(function* () {
        if (
          Option.isSome(automationEvents) &&
          !companion &&
          event.outcome === "complete" &&
          event.result?.stopReason === "stop" &&
          event.result.entryId
        )
          yield* publishChatAutomationEvent({
            event: "assistant-response-completed",
            eventId: `${target.sessionId}:${event.result.entryId}`,
            sessionId: target.sessionId,
            sourceMessageId: event.result.entryId,
            text: event.result.text,
            ...(project === undefined ? null : { projectPath: project.path }),
          }).pipe(Effect.provideService(AutomationEvents, automationEvents.value));
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
      utilityModel: () => application.snapshot().utilityModel,
      cakeChatTodos: companion
        ? undefined
        : () =>
            project
              ? (application.snapshot().projects.find((item) => item.path === project.path)?.todos
                  ?.items ?? [])
              : (application.snapshot().cakeChatTodos?.items ?? []),
      onCakeChatInputConsumed: (text, signal) => {
        const receipt = projectTodoReceipt(splitSessionDigestReminder(text).text);
        return receipt === undefined
          ? Promise.resolve()
          : run(projectTodos.acknowledge(todoScope, receipt), { signal });
      },
      cakeChatSystemPrompt: companion
        ? () =>
            [
              "You are the user’s app-wide companion. Keep one continuous identity and your own conversation history across sessions, projects and modes. You run independently of the main agent; never interrupt it unless the user asks.",
              `Your own messaging address is ${SESSION_ASSISTANT_ID}. Use sessionId: "parent" when the user means the viewed session/chat ("this session"); it resolves from your current invoking context, not your own conversation. Omitting sessionId from sessions.schedule always schedules to yourself. If invoking context is unavailable, ask rather than inventing a target.`,
              "Orientation entries are metadata, not requests: enter/exit only describe where the user is looking. Do not greet again, repeat reminders or import the invoking conversation. Use sessions.list/info and messages tools only when deeper context is needed. Prefer short answers and direct navigation via supported Cake tools, including sessions.open and vscode.open. Preserve destructive-action safeguards.",
              "You can directly author and run VS Code scripts with vscode.script.run, arrange editors and configure VS Code at the user's request; do not delegate these actions to or interrupt the main coding agent. VS Code tools target the currently viewed Project Chat or Project Session and its actual Working Directory, not your app-wide home directory. Call vscode.enter first. Scripts run trusted async JavaScript with vscode, input and require; return a JSON-compatible result. For settings use vscode.workspace.getConfiguration().inspect/get/update with an explicit ConfigurationTarget (Global or Workspace) matching the user's request, preserve unrelated settings and verify the result. If no project/editor context is available, ask the user to open the intended Project Chat or Project Session before retrying.",
              "You use the configured utility model. Your memory and instructions are separate, customizable in Settings → Application → Cake Chat → Companion or settings.get/update with companion.memoryViewBytes, companion.contextLimitTokens and companion.instructions. Change instructions only when the user requests lasting guidance: read first and preserve unrelated text. Shared Cake Chat instructions do not apply.",
            ].join("\n\n")
        : project
          ? () =>
              [
                "## Project Chat scope",
                `You are the permanent Project Chat for ${JSON.stringify(project.name)} at ${JSON.stringify(project.path)}.`,
                `Your messaging address is ${target.sessionId}. Your history and memory belong only to this project; global Cake Chat is a separate conversation at cake-chat.`,
                "Work only on this project. If a request belongs to another registered project, say so and offer to send it to that project's chat; send it only if the user agrees. You can discuss ideas and decisions without creating tasks. Delegate only when useful, using this project's root.",
                "VS Code and the interactive Terminal open at this project root; Browser Mode belongs to this conversation. Use these shared tools for visual exploration while keeping discussion primary.",
                "Other chats have independent memories. Exchange a focused request and relevant references, not entire histories. Do not repeatedly relay or delegate the same request.",
                projectTodoBaseline(
                  application.snapshot().projects.find((item) => item.path === project.path)
                    ?.todos ?? emptyProjectTodos(),
                ),
                application.snapshot().projects.find((item) => item.path === project.path)?.settings
                  ?.projectChatInstructions,
              ]
                .filter(Boolean)
                .join("\n\n")
          : () =>
              projectTodoBaseline(
                application.snapshot().cakeChatTodos ?? emptyProjectTodos(),
                "Cake Chat",
              ),
      sessionReferences: {
        resolve: (reference, signal) =>
          reference === "parent" && sideChatSessionId
            ? Promise.resolve(target.sessionId)
            : run(sessionReferences.resolve(reference, target.sessionId), { signal }),
        project: (value, signal) => run(sessionReferences.project(value), { signal }),
        ids: () => sessionReferenceIds(),
      },
      agentDir: configuration.agentDirectory,
      sessionDir: configuration.location.sessionDirectory,
      newSession,
      sessionId: target.sessionId,
      // Pin the complete Cake Chat toolset instead of relying on Pi's default-tool
      // selection, which does not necessarily activate extension tools.
      tools: ["cake", "zoom", "date", "read", "bash", "mcp"],
      // A Project Chat never writes shared Cake Chat guidance; projects.settings.* is
      // restricted to its own Project by the backend handler.
      allowedCakeOperations: project
        ? CAKE_CHAT_OPERATIONS.filter((command) => !command.startsWith("settings.cake-chat."))
        : CAKE_CHAT_OPERATIONS,
      persistArtifact: (artifact) =>
        runArtifact(
          Effect.gen(function* () {
            const revision = yield* artifactWorkflows.create({
              sessionId: target.sessionId,
              lineageId: yield* Schema.decodeUnknownEffect(ArtifactLineageId)(artifact.id),
              snapshot: artifact,
              workingDirectory: configuration.location.workingDirectory,
            });
            const record = artifactRevisionToRecord(revision);
            (yield* ClientEvents).broadcast({ type: "artifact-updated", record });
            return record;
          }),
        ),
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
                yield* sessionReferences.resolve(reference, target.sessionId),
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
        getSettings: (input, signal) =>
          run(invokeProjectSettings("projects.settings.get", input), { signal }),
        updateSettings: (input, signal) =>
          run(invokeProjectSettings("projects.settings.update", input), { signal }),
      },
      cakeChatInstructions: project
        ? undefined
        : {
            get: (signal) => run(getCakeChatInstructions(), { signal }),
            update: (input, signal) => run(updateCakeChatInstructions(input), { signal }),
          },
      // Project Chat keeps its Project's list; global Cake Chat keeps its own separate list.
      projectTodos: {
        select: (input, signal) =>
          run(
            projectTodos
              .mutateUser(todoScope, { _tag: "Select", ...input })
              .pipe(Effect.map(({ selectedId }) => ({ selectedId }))),
            { signal },
          ),
        list: (input, signal) => run(projectTodoAssociations.list(todoScope, input), { signal }),
        read: (id, signal) => run(projectTodoAssociations.read(todoScope, id), { signal }),
        create: (input, signal) =>
          run(projectTodoAssociations.create(todoScope, input), { signal }),
        update: (input, signal) =>
          run(projectTodoAssociations.update(todoScope, input), { signal }),
        updateMany: (input, signal) =>
          run(projectTodoAssociations.updateMany(todoScope, input), { signal }),
      },
      projectChatInstructions: {
        get: (input, signal) => run(projectChatInstructions.get(input, project?.path), { signal }),
        update: (input, signal) =>
          run(projectChatInstructions.update(input, project?.path), { signal }),
      },
      cakeChatMemory: {
        preferences: () =>
          companion
            ? (application.snapshot().assistantPreferences ?? defaultAssistantPreferences())
            : (application.snapshot().cakeChatPreferences ?? defaultCakeChatPreferences()),
        summarize: (input) => {
          const state = application.snapshot();
          let selection;
          try {
            selection = resolveCakeModelChoice(
              (companion
                ? { source: "utility" as const }
                : state.cakeChatPreferences?.summarizationModel) ??
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
                chat: { tools: input.tools ?? [], previous: input.previous ?? [] },
                maximumOutputCharacters: 4_096,
              },
              input.observeRequest,
            ),
            { signal: input.signal },
          );
        },
      },
      browserControl,
      vscodeControl:
        project || companion
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
                return run(
                  vscodeWorkingDirectory().pipe(
                    Effect.flatMap((workingDirectory) =>
                      vscode.value.runProjectScript(workingDirectory, source, input),
                    ),
                  ),
                  { signal },
                );
              },
            })
          : undefined,
      slashCommands: cakeChatBuiltinSlashCommands.map((command) => command.name),
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
        // Shared VS Code definitions replace renderer-advertised Companion controls.
        tools: target.tools
          .filter(
            (tool) =>
              !(project || companion) ||
              !SHARED_VSCODE_OPERATIONS.some((command) => command === tool.command),
          )
          .map((tool) => ({
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
              if (
                invocation.name !== "sessions.compact" &&
                invocation.name !== "sessions.tool-compact" &&
                Schema.is(Schema.String)(argumentsObject.sessionId)
              )
                invocation = {
                  ...invocation,
                  arguments: {
                    ...argumentsObject,
                    sessionId:
                      argumentsObject.sessionId === "parent" && sideChatSessionId
                        ? target.sessionId
                        : yield* sessionReferences.resolve(
                            argumentsObject.sessionId,
                            target.sessionId,
                          ),
                  },
                };
              const args = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ sessionId: Schema.optionalKey(Schema.String) }),
              )(invocation.arguments);
              // Project Sessions reach Cake Chat by omitting sessionId; Cake Chat cannot message itself.
              if (
                invocation.name === "sessions.send" &&
                (sideChatSessionId
                  ? (args.sessionId ?? CAKE_CHAT_SESSION_ID) === senderSessionId
                  : args.sessionId === undefined || args.sessionId === target.sessionId)
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
                  "sessions.info",
                  "sessions.open",
                  "sessions.abort",
                  "sessions.compact",
                  "sessions.compact-batch",
                  "sessions.tool-compact",
                  "sessions.rename",
                  "sessions.resolve",
                  "sessions.set-labels",
                ].includes(invocation.name) &&
                args.sessionId !== undefined &&
                // A chat's own task inputs never hide its own schedules or metadata from it.
                args.sessionId !== target.sessionId &&
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
                            source: { sessionId: target.sessionId, kind: "cake-chat", title },
                            senderWorkingDirectory: project?.path,
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
                        sessionId: [
                          "sessions.send",
                          "sessions.reply",
                          "sessions.thread",
                          "sessions.close-thread",
                        ].includes(forwarded.name)
                          ? senderSessionId
                          : target.sessionId,
                        title: sideChatSessionId ? `Side chat of ${title}` : title,
                        ...(project ? { projectPath: project.path } : null),
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
