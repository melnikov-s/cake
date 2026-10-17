import { Effect, Option, Schema, type Scope } from "effect";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
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
import type { ProjectSessionSummary } from "../../contracts/project-sessions/project-session-data";
import { sessionLink } from "../../contracts/conversations/message-reference";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionFamilyStorage, familyMemberIds } from "../../services/storage/SessionFamilyStorage";
import { SessionCoordination } from "../../services/session-catalogs/SessionCoordination";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import * as application from "./application";
import { defaultProjectSettings } from "../../contracts/application/application-data";
import * as agentSettings from "./agentSettings";
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

type AgentSessionSummary = ProjectSessionSummary & { readonly savedDraft?: SavedDraft };

const lookupSession = Effect.fn("AgentControl.lookupSession")(function* (sessionId: string) {
  const storage = yield* Effect.serviceOption(SavedDraftStorage);
  const drafts = Option.isSome(storage) ? yield* storage.value.list() : [];
  const draft = drafts.find(
    (record) => record.sessionId === sessionId && record.status !== "activated",
  );
  const project = draft
    ? (yield* ApplicationState).snapshot().projects.find((item) => item.path === draft.projectPath)
    : undefined;
  return yield* metadata.lookup({ sessionId }).pipe(
    Effect.map((session): AgentSessionSummary => session),
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
    : yield* metadata.findLocation({ sessionId: session.sessionId }, { includeInactive: true });
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
        case "session-labels.list":
          return toJsonValue({ ok: true, command, labels: yield* labels() });
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
          const sessions = yield* Effect.forEach(familyMemberIds(family), (sessionId) =>
            metadata.lookup({ sessionId }).pipe(Effect.flatMap(controlSession)),
          );
          return toJsonValue({
            ok: true,
            command,
            familyId: family.familyId,
            rootSessionId: family.parentSessionId,
            currentSessionId: caller.sessionId,
            sessions,
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
          const summaries = yield* Effect.forEach(
            (yield* sessionReferences.catalog()).filter(
              ({ sessionId }) => !isCakeChatSessionId(sessionId),
            ),
            ({ sessionId }) =>
              lookupSession(sessionId).pipe(Effect.catch(() => Effect.succeed(undefined))),
          );
          const ordered = summaries
            .filter((item): item is AgentSessionSummary => item !== undefined)
            .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
          const projectEntries = (yield* Effect.forEach(
            ordered.filter(
              (session) =>
                !invocation.arguments.launchedByCakeChat ||
                caller.kind !== "cake-chat" ||
                session.cakeChatLaunch?.requesterSessionId === caller.sessionId,
            ),
            controlSession,
          )).filter(
            (session) =>
              !invocation.arguments.launchedByCakeChat || (session.launch && !session.resolved),
          );
          const chatConfiguration = yield* Effect.serviceOption(CakeChatConfiguration);
          const chatEntries =
            Option.isSome(chatConfiguration) && !invocation.arguments.launchedByCakeChat
              ? (yield* chatMetadata.catalog(chatConfiguration.value.location)).map((chat) => ({
                  sessionId: chat.sessionId,
                  title: chat.projectPath ? `${chat.title} / Project Chat` : chat.title,
                  kind: "cake-chat",
                  projectPath: chat.projectPath,
                  modifiedAt: chat.modifiedAt,
                  resolved: false,
                  launch: undefined,
                  activity: chat.unread ? "unread" : undefined,
                }))
              : [];
          const sessions = [...projectEntries, ...chatEntries];
          return toJsonValue({
            ok: true,
            command,
            sessions,
            attentionSessions: sessions.filter((session) =>
              invocation.arguments.launchedByCakeChat
                ? ["needs-you", "failed", "interrupted"].includes(session.launch?.status ?? "")
                : session.activity !== undefined,
            ),
          });
        }
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
            return toJsonValue({
              ok: true,
              command,
              session: {
                sessionId,
                kind: "cake-chat",
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
            const preview = yield* metadata.inspect({ sessionId });
            const session = yield* controlSession(known);
            return toJsonValue({
              ok: true,
              command,
              session: {
                ...session,
                sessionFile: preview.sessionFile,
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
            yield* metadata.findLocation({ sessionId }),
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
