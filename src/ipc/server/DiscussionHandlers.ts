import { Stream } from "effect";
import * as discussionSessions from "../../domain/discussionSessions";
import { DiscussionRpc } from "../protocol/DiscussionRpc";

export const discussionHandlers = DiscussionRpc.of({
  "discussionSessions.observeCatalog": (input) =>
    Stream.unwrap(discussionSessions.observeCatalog(input)),
  "discussionSessions.list": (input) => discussionSessions.list(input),
  "discussionSessions.create": (input) => discussionSessions.create(input),
  "discussionSessions.observe": (target) => Stream.unwrap(discussionSessions.observe(target)),
  "discussionSessions.prompt": (input) => discussionSessions.prompt(input),
  "discussionSessions.abort": (target) => discussionSessions.abort(target),
  "discussionSessions.setResolved": ({ resolved, ...target }) =>
    discussionSessions.setResolved(target, resolved),
});
