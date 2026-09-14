import { Stream } from "effect";
import * as discussionSessions from "../../domain/discussion-sessions/discussionSessions";
import { DiscussionRpc } from "../protocol/DiscussionRpc";

export const discussionHandlers = DiscussionRpc.of({
  "discussionSessions.observeCatalog": (input) =>
    Stream.unwrap(discussionSessions.observeCatalog(input)),
  "discussionSessions.list": (input) => discussionSessions.list(input),
  "discussionSessions.observe": (target) => Stream.unwrap(discussionSessions.observe(target)),
  "discussionSessions.start": (input) => discussionSessions.start(input),
  "discussionSessions.ensureSessionAssistant": (input) =>
    discussionSessions.ensureSessionAssistant(input),
  "discussionSessions.setResolved": ({ resolved, ...target }) =>
    discussionSessions.setResolved(target, resolved),
});
