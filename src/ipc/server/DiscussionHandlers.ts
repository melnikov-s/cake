import { Effect, Stream } from "effect";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import * as discussionSessions from "../../domain/discussion-sessions/discussionSessions";
import * as discussionSessionReferences from "../../domain/discussion-sessions/discussionSessionReferences";
import { DiscussionRpc } from "../protocol/DiscussionRpc";

export const discussionHandlers = DiscussionRpc.of({
  "discussionSessions.lookup": ({ sessionId }) =>
    Effect.map(discussionSessionReferences.lookup(sessionId), ({ reference }) => reference),
  "discussionSessions.observeMetadata": (input) =>
    Stream.unwrap(discussionSessions.observeMetadata(input)),
  "discussionSessions.observeCatalog": (input) =>
    Stream.unwrap(discussionSessions.observeCatalog(input)),
  "discussionSessions.list": (input) => discussionSessions.list(input),
  "discussionSessions.observe": (target) =>
    Stream.unwrap(
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        discussionSessions.observe(target, connectionId),
      ),
    ),
  "discussionSessions.start": (input) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      discussionSessions.start(input, connectionId),
    ),
  "discussionSessions.merge": (target) => discussionSessions.merge(target),
  "discussionSessions.setResolved": ({ resolved, ...target }) =>
    discussionSessions.setResolved(target, resolved),
});
