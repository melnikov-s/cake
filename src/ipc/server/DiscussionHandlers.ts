import { Effect, Stream } from "effect";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import * as discussionSessions from "../../domain/discussion-sessions/discussionSessions";
import { DiscussionRpc } from "../protocol/DiscussionRpc";

export const discussionHandlers = DiscussionRpc.of({
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
  "discussionSessions.ensureSessionAssistant": (input) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      discussionSessions.ensureSessionAssistant(input, connectionId),
    ),
  "discussionSessions.setResolved": ({ resolved, ...target }) =>
    discussionSessions.setResolved(target, resolved),
});
