import { Effect, Stream } from "effect";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ReviewStorage } from "../../services/storage/ReviewStorage";
import {
  DiscussionTitleRequests,
  type DiscussionTitleRequest,
} from "../../services/discussion-sessions/DiscussionTitleRequests";
import { generateSessionTitle, utilityModelSelection } from "../utility-work/utilityWork";

/** A saved title belongs to the thread, independent of pane/runtime/window lifetime. */
export const assign = Effect.fn("DiscussionTitles.assign")(function* (
  request: DiscussionTitleRequest,
) {
  const utilityModel = (yield* ApplicationState).snapshot().utilityModel;
  if (!utilityModel || !request.firstUserMessage.trim()) return;
  const storage = yield* ReviewStorage;
  const record = yield* storage.get(
    request.workingDirectory,
    request.parentSessionId,
    request.threadId,
  );
  if (!record || record.title) return;
  const title = yield* generateSessionTitle({
    selection: utilityModelSelection(utilityModel),
    firstUserMessage: request.firstUserMessage,
    style: "side-chat",
  });
  yield* storage.setDiscussionTitle(
    request.workingDirectory,
    request.parentSessionId,
    request.threadId,
    title,
  );
});

export const initialize = Effect.fn("DiscussionTitles.initialize")(function* () {
  const requests = yield* DiscussionTitleRequests;
  yield* requests.requests().pipe(
    Stream.runForEach((request) =>
      assign(request).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Side chat naming failed; keeping its current title", error),
        ),
      ),
    ),
    Effect.forkScoped,
  );
});
