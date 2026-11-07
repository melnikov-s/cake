import { Effect, Option } from "effect";
import {
  cakeChatSideChatConversationId,
  cakeChatSideChatParentId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { DiscussionSessionError } from "../../contracts/discussion-sessions/discussion-session-data";
import { DiscussionSessionEnvironment } from "../../services/discussion-sessions/DiscussionSessionEnvironment";
import { CakeChatDurable } from "../../services/pi-durable/CakeChatDurable";
import type { SessionInspectionQuery } from "../../contracts/conversations/session-query-data";
import { CakeChatConfiguration } from "../../services/pi-durable/CakeChatConfiguration";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import * as chatLocations from "../cake-chats/cakeChatLocations";

/** Resolve native Side Chat IDs through their actual owner's saved Discussion metadata.
 * Never manufacture a Project Session catalog entry or inspect a transcript for identity.
 */
export const lookup = Effect.fn("DiscussionSessionReferences.lookup")(
  function* (sessionId: string) {
    const parentSessionId = cakeChatSideChatParentId(sessionId);
    if (!parentSessionId || cakeChatSideChatConversationId(sessionId) === undefined)
      return yield* new DiscussionSessionError({
        operation: "lookup",
        message: "Invalid Side Chat ID",
      });
    const configuration = yield* Effect.serviceOption(CakeChatConfiguration);
    const environment = yield* Effect.serviceOption(DiscussionSessionEnvironment);
    if (Option.isNone(configuration) || Option.isNone(environment))
      return yield* new DiscussionSessionError({
        operation: "lookup",
        message: "Side Chat metadata is unavailable in this runtime",
      });
    const location = yield* chatLocations.resolve(configuration.value.location, parentSessionId);
    const records = yield* environment.value.list(location.workingDirectory, parentSessionId);
    const record = records.find((record) => record.sidecarSessionId === sessionId);
    if (!record)
      return yield* new DiscussionSessionError({
        operation: "lookup",
        message: `Cake could not find Side Chat ${sessionId}`,
      });
    const spawn = (yield* (yield* SessionFamilyStorage).state()).spawnedSessions.find(
      (spawn) => spawn.sessionId === sessionId && spawn.requester.sessionId === parentSessionId,
    );
    const projects = (yield* ApplicationState).snapshot().projects;
    const projectPath =
      spawn?.projectPath ??
      projects.find(
        (project) => chatLocations.projectChatSessionId(project.path) === parentSessionId,
      )?.path;
    return {
      record,
      location,
      reference: {
        sessionId,
        parentSessionId,
        threadId: record.id,
        workingDirectory: record.workingDirectory,
        executionDirectory: spawn?.workingDirectory ?? record.workingDirectory,
        ...(projectPath ? { projectPath } : null),
        resolved: record.status === "resolved",
      },
    };
  },
  Effect.mapError((cause) =>
    cause instanceof DiscussionSessionError
      ? cause
      : new DiscussionSessionError({ operation: "lookup", message: cause.message }),
  ),
);

/** Exact originals are read without assembling a runtime or resuming any task. */
export const inspectMessages = Effect.fn("DiscussionSessionReferences.inspectMessages")(function* (
  sessionId: string,
  query: SessionInspectionQuery,
) {
  const { location } = yield* lookup(sessionId);
  const durable = yield* Effect.serviceOption(CakeChatDurable);
  if (Option.isNone(durable))
    return yield* new DiscussionSessionError({
      operation: "messages",
      message: "Side Chat history is unavailable in this runtime",
    });
  return yield* durable.value
    .inspectSideChatMessages(location.sessionDirectory, sessionId, query)
    .pipe(
      Effect.mapError(
        (cause) => new DiscussionSessionError({ operation: "messages", message: cause.message }),
      ),
    );
});
