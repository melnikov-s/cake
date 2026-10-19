import { Clock, Effect, Option, Schema, type Scope } from "effect";
import { sessionContextCost } from "../../utils/session-context-cost";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { sessionRoster } from "./sessionRoster";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { CakeChatConfiguration } from "../../services/pi-durable/CakeChatConfiguration";
import * as chatMetadata from "../cake-chats/cakeChatMetadata";
import * as chatTargets from "../cake-chats/cakeChatTargets";
import { isBackendAgentSetting } from "../../contracts/application/agent-settings-tools";
import {
  AgentSettingsInvocation,
  agentSettingsSections,
} from "../../contracts/application/agent-settings-schema";
import {
  BackendAgentInvocation,
  backendAgentCommands,
} from "../../contracts/application/backend-agent-control";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import type { SavedDraft } from "../../contracts/project-sessions/saved-draft-data";
import { SavedDraftStorage } from "../../services/storage/SavedDraftStorage";
import type {
  ProjectSessionLocation,
  ProjectSessionSummary,
} from "../../contracts/project-sessions/project-session-data";
import { sessionLink } from "../../contracts/conversations/message-reference";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionFamilyStorage, familyMemberIds } from "../../services/storage/SessionFamilyStorage";
import { SessionCoordination } from "../../services/session-catalogs/SessionCoordination";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import * as application from "./application";
import { defaultProjectSettings } from "../../contracts/application/application-data";
import * as agentSettings from "./agentSettings";
import * as pendingReports from "../conversations/pendingReports";
import * as completionInbox from "../conversations/completionInbox";
import * as agentSessionMessaging from "./agentSessionMessaging";
import * as agentActionNotices from "./agentActionNotices";
import { AgentControlError } from "./agentSettings";
import * as metadata from "../project-sessions/projectSessionMetadata";
import * as sessionReferences from "../project-sessions/sessionReferences";
import * as projectSessions from "../project-sessions/projectSessionOperations";
import * as savedDrafts from "../project-sessions/savedDrafts";
import * as projects from "../projects/projects";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import type { acquireOptions } from "../project-sessions/projectSessionRuntime";
import * as sessionChats from "../conversations/sessionChats";
import { toJsonValue } from "../../utils/to-json-value";
import { agentListLabel, agentListPage } from "../../contracts/agent/agent-list-data";
import type { AgentSessionStatus } from "../../contracts/project-sessions/agent-session-list";

export interface AgentControlCaller {
  readonly kind: "project-session" | "cake-chat";
  readonly sessionId: string;
  readonly title: string;
  readonly projectName?: string;
  readonly projectPath?: string;
  readonly workingDirectory?: string;
}

export const handles = (command: string) =>
  backendAgentCommands.has(command) || isBackendAgentSetting(command);

export type AgentControlServices = Effect.Services<ReturnType<typeof acquireOptions>>;

const labels = Effect.fn("AgentControl.labels")(function* () {
  const state = (yield* ApplicationState).snapshot();
  return [
    ...state.globalSessionLabels.map((label) => ({ ...label, scope: "global" as const })),
    ...state.projects.flatMap((project) =>
      (project.workflow?.labels ?? []).map((label) => ({
        ...label,
        scope: "project" as const,
        projectPath: project.path,
      })),
    ),
  ];
});

type AgentSessionSummary = ProjectSessionSummary & {
  readonly savedDraft?: SavedDraft;
  readonly location?: ProjectSessionLocation;
};

function sessionListStatus(session: AgentSessionSummary): AgentSessionStatus {
  if (session.resolved) return "resolved";
  if (session.savedDraft) return "draft";
  if (session.running) return "running";
  const report = session.cakeChatLaunch?.lastReport;
  if (report?.status === "blocked") return "needs-you";
  if (
    report?.status === "failed" ||
    report?.status === "interrupted" ||
    report?.status === "stopped"
  )
    return report.status;
  if (report) return "done";
  return session.unread ? "unread" : "idle";
}

const lookupSession = Effect.fn("AgentControl.lookupSession")(function* (sessionId: string) {
  const storage = yield* Effect.serviceOption(SavedDraftStorage);
  const drafts = Option.isSome(storage) ? yield* storage.value.list() : [];
  const draft = drafts.find(
    (record) => record.sessionId === sessionId && record.status !== "activated",
  );
  const project = draft
    ? (yield* ApplicationState).snapshot().projects.find((item) => item.path === draft.projectPath)
    : undefined;
  return yield* metadata.lookupWithLocation({ sessionId }).pipe(
    Effect.map(({ session, location }): AgentSessionSummary => ({ ...session, location })),
    Effect.catch((error) =>
      draft && project
        ? Effect.succeed<AgentSessionSummary>({
            sessionId,
            title: draft.title,
            createdAt: draft.createdAt,
            modifiedAt: draft.modifiedAt,
            messageCount: 0,
            resolved: draft.resolved,
            unread: false,
            running: false,
            projectPath: draft.projectPath,
            projectName: project.name,
            workingDirectory: draft.workingDirectory,
            savedDraft: draft,
          })
        : Effect.fail(error),
    ),
  );
});

const controlSession = Effect.fn("AgentControl.controlSession")(function* (
  session: AgentSessionSummary,
) {
  const state = (yield* ApplicationState).snapshot();
  const assigned =
    session.savedDraft?.labelIds ??
    state.projects
      .find((project) => project.path === session.projectPath)
      ?.workflow?.assignments.find((assignment) => assignment.sessionId === session.sessionId)
      ?.labelIds ??
    [];
  const available = yield* labels();
  const location = session.savedDraft
    ? undefined
    : (session.location ?? (yield* metadata.findLocation({ sessionId: session.sessionId })));
  const status = location
    ? yield* (yield* CakeSessionRuntimes).currentStatus({
        sessionId: session.sessionId,
        workingDirectory: location.workingDirectory,
        sessionDirectory: location.sessionDirectory,
      })
    : undefined;
  const activity = status?.streaming
    ? "running"
    : state.unreadSessionIds.includes(session.sessionId)
      ? "unread"
      : undefined;
  const launch = session.cakeChatLaunch;
  return {
    workspacePath: session.workingDirectory,
    workspaceName: session.projectName,
    sessionId: session.sessionId,
    deepLink: sessionLink(session.sessionId),
    title: session.title,
    modified: session.modifiedAt,
    messageCount: session.messageCount,
    resolved: session.resolved,
    draft: session.savedDraft !== undefined,
    ...(location?.managedWorktree ? { managedWorktree: location.managedWorktree } : null),
    ...(session.familyId
      ? {
          familyId: session.familyId,
          familyParentSessionId: session.familyParentSessionId,
          familyChildSessionIds: session.familyChildSessionIds,
          familyChildOrder: session.familyChildOrder,
          familyDepth: session.familyDepth,
        }
      : null),
    ...(assigned.length
      ? {
          labels: available.filter(
            (label) =>
              assigned.includes(label.id) &&
              (label.scope === "global" || label.projectPath === session.projectPath),
          ),
        }
      : null),
    ...(activity ? { activity } : null),
    ...(launch
      ? {
          launch: {
            status: status?.streaming
              ? "running"
              : launch.lastReport?.status === "blocked"
                ? "needs-you"
                : launch.lastReport?.status === "failed"
                  ? "failed"
                  : launch.lastReport?.status === "interrupted"
                    ? "interrupted"
                    : launch.lastReport?.status === "stopped"
                      ? "stopped"
                      : launch.lastReport
                        ? "done"
                        : "idle",
            ...(launch.launchedAt ? { launchedAt: launch.launchedAt } : null),
            ...(launch.lastReport
              ? { summary: launch.lastReport.summary, reportedAt: launch.lastReport.reportedAt }
              : null),
          },
        }
      : null),
  };
});

/** Undefined means a genuinely window/device-owned operation. Errors never fall back to a renderer. */
export const invoke: (
  command: string,
  input: JsonValue,
  caller: AgentControlCaller,
) => Effect.Effect<JsonValue | undefined, AgentControlError, AgentControlServices | Scope.Scope> =
  Effect.fn("AgentControl.invoke")(
    function* (command, input, caller) {
      if (isBackendAgentSetting(command))
        return yield* agentSettings.invoke(
          yield* Schema.decodeUnknownEffect(AgentSettingsInvocation)(
            { name: command, arguments: input },
            { onExcessProperty: "error" },
          ),
          caller,
        );
      if (!backendAgentCommands.has(command)) return undefined;
      const invocation = yield* Schema.decodeUnknownEffect(BackendAgentInvocation)({
        name: command,
        arguments: input,
      });
      const fail = (error: string) => toJsonValue({ ok: false, command, error });
      switch (invocation.name) {
        case "settings.sections":
          return toJsonValue({ ok: true, command, sections: agentSettingsSections });
        case "projects.list":
          return toJsonValue({
            ok: true,
            command,
            ...(yield* projects.listForAgent(invocation.arguments)),
          });
        case "projects.info":
          return toJsonValue({
            ok: true,
            command,
            ...(yield* projects.infoForAgent(invocation.arguments)),
          });
        case "project.settings.get":
        case "project.settings.update":
        case "projects.settings.get":
        case "projects.settings.update": {
          const owner = yield* ApplicationState;
          const projectPath =
            "projectPath" in invocation.arguments
              ? invocation.arguments.projectPath
              : caller.projectPath;
          const project = owner.snapshot().projects.find((project) => project.path === projectPath);
          if (!project) return fail("Cake could not find that Project.");
          const changes =
            "changes" in invocation.arguments ? invocation.arguments.changes : undefined;
          if (changes && !(yield* (yield* ProjectAccess).isAllowed(project.path)))
            return fail("Project path was not selected by the user");
          if (changes)
            yield* owner.transact((current) =>
              Effect.succeed({
                ...current,
                projects: current.projects.map((item) =>
                  item.path === project.path
                    ? {
                        ...item,
                        settings: { ...(item.settings ?? defaultProjectSettings()), ...changes },
                      }
                    : item,
                ),
              }),
            );
          return toJsonValue({
            ok: true,
            command,
            scope: "project",
            projectPath: project.path,
            settings:
              owner.snapshot().projects.find((item) => item.path === project.path)?.settings ??
              defaultProjectSettings(),
          });
        }
        case "session-labels.list": {
          const input = invocation.arguments;
          const query = input.query?.toLowerCase();
          const selected = (yield* labels()).filter(
            (label) =>
              (!input.projectPath ||
                label.scope === "global" ||
                label.projectPath === input.projectPath) &&
              (!query || label.name.toLowerCase().includes(query)),
          );
          const { items, ...page } = agentListPage(selected, input);
          return toJsonValue({ ok: true, command, ...page, labels: items });
        }
        case "session-labels.add": {
          const input = invocation.arguments;
          if (
            input.projectPath &&
            !(yield* ApplicationState)
              .snapshot()
              .projects.some((project) => project.path === input.projectPath)
          )
            return fail("Cake could not find that project.");
          const label = { id: crypto.randomUUID(), name: input.name, color: input.color };
          if (input.projectPath)
            yield* projects.mutateWorkflow({
              projectPath: input.projectPath,
              mutation: {
                _tag: "AddLabel",
                label,
              },
            });
          else yield* application.mutateGlobalSessionLabels({ _tag: "AddLabel", label });
          return toJsonValue({
            ok: true,
            command,
            label: {
              ...label,
              scope: input.projectPath ? "project" : "global",
              ...(input.projectPath ? { projectPath: input.projectPath } : null),
            },
          });
        }
        case "session-labels.update":
        case "session-labels.remove":
        case "session-labels.reorder": {
          const label = (yield* labels()).find((item) => item.id === invocation.arguments.labelId);
          if (!label) return fail("Cake could not find that session label.");
          if (
            invocation.name === "session-labels.update" &&
            invocation.arguments.name === undefined &&
            invocation.arguments.color === undefined
          )
            return fail("Provide a name or color to update.");
          const changes =
            invocation.name === "session-labels.update"
              ? {
                  ...(invocation.arguments.name ? { name: invocation.arguments.name } : null),
                  ...(invocation.arguments.color ? { color: invocation.arguments.color } : null),
                }
              : null;
          const mutation =
            invocation.name === "session-labels.update"
              ? { _tag: "UpdateLabel" as const, labelId: label.id, ...changes }
              : invocation.name === "session-labels.remove"
                ? { _tag: "DeleteLabel" as const, labelId: label.id }
                : {
                    _tag: "MoveLabel" as const,
                    labelId: label.id,
                    index: invocation.arguments.index,
                  };
          if (label.scope === "project")
            yield* projects.mutateWorkflow({ projectPath: label.projectPath, mutation });
          else yield* application.mutateGlobalSessionLabels(mutation);
          return toJsonValue({ ok: true, command, label: { ...label, ...changes } });
        }
        case "sessions.list-family": {
          if (caller.kind !== "project-session")
            return fail("Listing a Session Family requires a calling Project Session.");
          const family = yield* (yield* SessionFamilyStorage).familyForMember(caller.sessionId);
          if (!family)
            return fail("The calling Project Session does not belong to a Session Family.");
          const summaries = yield* Effect.forEach(familyMemberIds(family), (sessionId) =>
            metadata.lookup({ sessionId }),
          );
          const query = invocation.arguments.query?.toLowerCase();
          const selected = summaries.filter(
            (session) => !query || session.title.toLowerCase().includes(query),
          );
          const { items, ...page } = agentListPage(selected, invocation.arguments);
          return toJsonValue({
            ok: true,
            command,
            ...page,
            familyId: family.familyId,
            rootSessionId: family.parentSessionId,
            currentSessionId: caller.sessionId,
            sessions: items.map((session) => ({
              sessionId: session.sessionId,
              title: agentListLabel(session.title),
              status: sessionListStatus(session),
              ...(session.familyParentSessionId
                ? { familyParentSessionId: session.familyParentSessionId }
                : null),
            })),
          });
        }
        case "sessions.set-labels": {
          const sessionId = yield* sessionReferences.resolve(invocation.arguments.sessionId);
          const target = yield* lookupSession(sessionId);
          const available = yield* labels();
          const selected = invocation.arguments.labelIds.flatMap((id) => {
            const label = available.find((item) => item.id === id);
            return label ? [label] : [];
          });
          if (selected.length !== invocation.arguments.labelIds.length)
            return fail("Cake could not find a selected session label.");
          if (
            selected.some(
              (label) => label.scope === "project" && label.projectPath !== target.projectPath,
            )
          )
            return fail("A selected label belongs to a different Project.");
          if (target.resolved || target.savedDraft?.status === "activating")
            return fail("Only active sessions and saved Drafts can have their labels changed.");
          if (target.savedDraft) {
            const storage = yield* Effect.serviceOption(SavedDraftStorage);
            if (Option.isNone(storage)) return fail("Saved Draft storage is unavailable.");
            yield* savedDrafts
              .update(
                { ...target.savedDraft, labelIds: [...invocation.arguments.labelIds] },
                target.savedDraft.revision,
              )
              .pipe(Effect.provideService(SavedDraftStorage, storage.value));
          } else
            yield* projects.setWorkflowSessionLabels({
              projectPath: target.projectPath,
              sessionId,
              workingDirectory: target.workingDirectory,
              labelIds: invocation.arguments.labelIds,
            });
          return toJsonValue({
            ok: true,
            command,
            target: { workspacePath: target.workingDirectory, sessionId },
            labels: selected,
          });
        }
        case "sessions.list": {
          const startedAt = yield* Clock.currentTimeMillis;
          const global = caller.kind === "cake-chat" && caller.sessionId === CAKE_CHAT_SESSION_ID;
          const scope = global
            ? undefined
            : caller.kind === "cake-chat"
              ? (yield* ApplicationState)
                  .snapshot()
                  .projects.find(
                    (project) => projectChatSessionId(project.path) === caller.sessionId,
                  )?.path
              : (caller.projectPath ?? (yield* lookupSession(caller.sessionId)).projectPath);
          if (!global && !scope) return fail("The caller has no registered project scope.");
          const input = invocation.arguments;
          const inScope = (projectPath: string) =>
            (!scope || projectPath === scope) &&
            (!input.projectPath || projectPath === input.projectPath);
          const discovery = yield* sessionReferences
            .discover()
            .pipe(Effect.withSpan("sessions.list.discovery"));
          const discoveredAt = yield* Clock.currentTimeMillis;
          const roster = discovery.roster;
          const listing = yield* metadata.listing(discovery, inScope).pipe(
            Effect.withSpan("sessions.list.summaries", {
              attributes: {
                locations: discovery.locations.length,
                identities: roster.length,
              },
            }),
          );
          const summarizedAt = yield* Clock.currentTimeMillis;
          const projectEntries = listing.sessions
            .filter(
              (session) =>
                !input.launchedByCakeChat ||
                (!session.resolved &&
                  session.cakeChatLaunch !== undefined &&
                  (caller.kind !== "cake-chat" ||
                    session.cakeChatLaunch.requesterSessionId === caller.sessionId)),
            )
            .map((session) => ({
              sessionId: session.sessionId,
              title: session.title,
              contextMetadata: undefined,
              projectName: session.projectName,
              projectPath: session.projectPath,
              modifiedAt: session.modifiedAt,
              status: sessionListStatus(session),
            }));
          const chatConfiguration = yield* Effect.serviceOption(CakeChatConfiguration);
          const chatEntries =
            Option.isSome(chatConfiguration) && !input.launchedByCakeChat
              ? (yield* chatMetadata
                  .catalog(chatConfiguration.value.location)
                  .pipe(Effect.withSpan("sessions.list.chats"))).map((chat) => ({
                  sessionId: chat.sessionId,
                  title: chat.projectPath ? "Project Chat" : chat.title,
                  projectName: chat.projectPath ? chat.title : undefined,
                  projectPath: chat.projectPath,
                  modifiedAt: chat.modifiedAt,
                  status: chat.unread ? ("unread" as const) : ("idle" as const),
                  contextMetadata: chat.contextMetadata,
                }))
              : [];
          const entries = yield* Effect.forEach([...projectEntries, ...chatEntries], (entry) =>
            Effect.gen(function* () {
              // Text rosters must retain the coordinator's task-input title redaction;
              // the later JSON-only safeCoordinatorProjection cannot inspect these rows.
              const protectedTitle =
                caller.kind === "cake-chat" &&
                (yield* (yield* TaskInputStorage).isRecipient(entry.sessionId));
              return protectedTitle ? { ...entry, title: "Task session" } : entry;
            }),
          ).pipe(Effect.withSpan("sessions.list.redaction"));
          const selectingAt = yield* Clock.currentTimeMillis;
          const query = input.query?.toLowerCase();
          const selected = entries
            .filter(
              (session) =>
                (!scope || session.projectPath === scope) &&
                (!input.projectPath || session.projectPath === input.projectPath) &&
                (!query || session.title.toLowerCase().includes(query)) &&
                (!input.status || session.status === input.status) &&
                (!input.attentionOnly ||
                  ["needs-you", "failed", "interrupted", "unread"].includes(session.status)),
            )
            .sort(
              (a, b) =>
                b.modifiedAt.localeCompare(a.modifiedAt) || a.sessionId.localeCompare(b.sessionId),
            );
          const { items, ...page } = agentListPage(selected, input);
          const now = yield* Clock.currentTimeMillis;
          const listed = yield* Effect.forEach(items, (item) =>
            Effect.gen(function* () {
              const contextMetadata = isCakeChatSessionId(item.sessionId)
                ? item.contextMetadata
                : item.status === "draft"
                  ? undefined
                  : yield* Effect.gen(function* () {
                      const location = listing.routes.get(item.sessionId);
                      if (!location) return undefined;
                      return yield* (yield* CakeSessionRuntimes)
                        .inspect(
                          { ...location, sessionId: item.sessionId },
                          { includeParts: false },
                        )
                        .pipe(Effect.map((preview) => preview.contextMetadata));
                    }).pipe(
                      // Advisory inspection failure must not hide an otherwise discoverable session.
                      Effect.catch(() => Effect.succeed(undefined)),
                      Effect.withSpan("sessions.list.context"),
                    );
              return { ...item, contextMetadata };
            }),
          );
          // Numeric, request-local diagnostics only: no paths, titles, queries, or transcript data.
          yield* Effect.logDebug("Session list timings", {
            scopeAndDiscoveryMs: discoveredAt - startedAt,
            summariesMs: summarizedAt - discoveredAt,
            chatsAndRedactionMs: selectingAt - summarizedAt,
            selectionMs: now - selectingAt,
            contextMs: (yield* Clock.currentTimeMillis) - now,
            locations: discovery.locations.length,
            identities: roster.length,
            matched: selected.length,
            returned: listed.length,
          });
          return sessionRoster(
            listed,
            page,
            [
              ...roster.map((entry) => entry.sessionId),
              ...chatEntries.map((entry) => entry.sessionId),
            ],
            now,
            global && !input.projectPath,
          );
        }
        case "sessions.reports":
          return toJsonValue({
            ok: true,
            command,
            ...(yield* pendingReports.list(caller.sessionId, invocation.arguments)),
          });
        case "sessions.reports.read":
          return toJsonValue({
            ok: true,
            command,
            ...(yield* pendingReports.read(caller.sessionId, invocation.arguments)),
          });
        case "sessions.reports.acknowledge":
          return toJsonValue({
            ok: true,
            command,
            ...(yield* pendingReports.acknowledge(caller.sessionId, invocation.arguments)),
          });
        case "sessions.completions":
          return toJsonValue({
            ok: true,
            command,
            ...(yield* completionInbox.list(caller.sessionId, invocation.arguments)),
          });
        case "sessions.completions.update":
          return toJsonValue({
            ok: true,
            command,
            ...(yield* completionInbox.update(caller.sessionId, invocation.arguments)),
          });
        case "sessions.send":
        case "sessions.reply":
        case "sessions.thread":
        case "sessions.close-thread":
          return yield* (yield* SessionCoordination).withAdmission(
            agentSessionMessaging.invoke(invocation, caller),
          );
        default: {
          const sessionId = yield* sessionReferences.resolve(invocation.arguments.sessionId);
          if (isCakeChatSessionId(sessionId)) {
            const handle = yield* chatTargets.acquireAvailable(sessionId);
            const snapshot = yield* handle.snapshot();
            if (invocation.name !== "sessions.info") {
              const target = { sessionId, workspacePath: snapshot.workspacePath };
              const result =
                invocation.name === "sessions.cake"
                  ? yield* handle.callCakeOperation(
                      invocation.arguments.command,
                      invocation.arguments.input ?? {},
                    )
                  : yield* handle.inspectSession({
                      ...invocation.arguments,
                      kind: yield* Schema.decodeUnknownEffect(
                        Schema.Literals([
                          "history",
                          "compactions",
                          "tree",
                          "context",
                          "usage",
                          "commands",
                        ]),
                      )(invocation.name.slice("sessions.".length)),
                    });
              return toJsonValue({ ok: true, command, target, result });
            }
            const configuration = yield* Effect.serviceOption(CakeChatConfiguration);
            const contextMetadata = Option.isSome(configuration)
              ? (yield* chatMetadata.catalog(configuration.value.location)).find(
                  (chat) => chat.sessionId === sessionId,
                )?.contextMetadata
              : undefined;
            return toJsonValue({
              ok: true,
              command,
              session: {
                sessionId,
                kind: "cake-chat",
                context: sessionContextCost(contextMetadata, yield* Clock.currentTimeMillis),
                ...(contextMetadata?.cacheObservation
                  ? { cacheEvidence: contextMetadata.cacheObservation }
                  : null),
                workingDirectory: snapshot.workspacePath,
                sessionFile: snapshot.sessionFile,
              },
              status: snapshot.streaming ? "running" : "idle",
            });
          }
          const known = yield* lookupSession(sessionId);
          const target = { workspacePath: known.workingDirectory, sessionId };
          if (invocation.name === "sessions.info") {
            if (known.savedDraft)
              return toJsonValue({
                ok: true,
                command,
                session: yield* controlSession(known),
                status: "idle",
              });
            const location = known.location ?? (yield* metadata.findLocation({ sessionId }));
            const preview = yield* metadata.inspectAt(location, sessionId);
            const session = yield* controlSession(known);
            return toJsonValue({
              ok: true,
              command,
              session: {
                ...session,
                sessionFile: preview.sessionFile,
                context: sessionContextCost(
                  preview.contextMetadata,
                  yield* Clock.currentTimeMillis,
                ),
                ...(preview.contextMetadata?.cacheObservation
                  ? { cacheEvidence: preview.contextMetadata.cacheObservation }
                  : null),
                ...(preview.firstUserMessage
                  ? { firstUserMessage: preview.firstUserMessage }
                  : null),
              },
              status: session.activity ?? "idle",
            });
          }
          if (invocation.name === "sessions.cake")
            return toJsonValue({
              ok: true,
              command,
              target,
              result: yield* projectSessions.callCakeOperation(
                { sessionId },
                invocation.arguments.command,
                invocation.arguments.input ?? {},
              ),
            });
          const kind = invocation.name.slice("sessions.".length);
          // The decoder above owns the query vocabulary, not arbitrary agent strings.
          const query = yield* Schema.decodeUnknownEffect(
            Schema.Literals(["history", "compactions", "tree", "context", "usage", "commands"]),
          )(kind);
          yield* projectSessions.acquireTarget(
            known.location ?? (yield* metadata.findLocation({ sessionId })),
            sessionId,
            false,
          );
          return toJsonValue({
            ok: true,
            command,
            target,
            result: yield* sessionChats.inspect({
              ...invocation.arguments,
              sessionId,
              kind: query,
            }),
          });
        }
      }
    },
    (effect, _command, _input, caller) =>
      effect.pipe(Effect.tap((result) => agentActionNotices.present(result, caller))),
    Effect.mapError((cause) =>
      cause instanceof AgentControlError
        ? cause
        : new AgentControlError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
    ),
  );
