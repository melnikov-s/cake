import { it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import * as discussionTitles from "../../../src/domain/discussion-sessions/discussionTitles";
import { DiscussionTitleRequests } from "../../../src/services/discussion-sessions/DiscussionTitleRequests";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { ReviewStorage } from "../../../src/services/storage/ReviewStorage";
import { PiModels } from "../../../src/services/pi/PiModels";
import { PiModelCompletionError } from "../../../src/contracts/pi/model-data";
import type { ReviewThreadRecord } from "../../../src/contracts/reviews/review-contract";

const request = {
  workingDirectory: "/project",
  parentSessionId: "parent",
  threadId: "thread",
  firstUserMessage: "Explain retrying filename collisions, not retaking screenshots",
};
const record: ReviewThreadRecord = {
  id: "thread",
  workspacePath: "/project",
  sessionId: "parent",
  anchor: {
    path: "session:parent",
    view: "session",
    start: { diffLine: 0 },
    end: { diffLine: 0 },
    selectedText: "Unrelated previous answer",
    contextBefore: "",
    contextAfter: "",
    diff: "",
  },
  pendingComments: [],
  status: "open",
  createdAt: "",
  updatedAt: "",
};
const utilityModel = {
  provider: "configured-provider",
  modelId: "configured-utility",
  thinkingLevel: "low" as const,
};
const application = (configured = true) =>
  Layer.mock(ApplicationState, {
    snapshot: () => ({ ...defaultApplicationState(), ...(configured ? { utilityModel } : {}) }),
  });

describe("side-chat utility naming", () => {
  it.effect(
    "accepts naming without waiting for the model and saves a short first-message title",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const saved = yield* Deferred.make<string>();
        yield* Effect.gen(function* () {
          yield* discussionTitles.initialize();
          yield* (yield* DiscussionTitleRequests).offer(request);
          yield* Deferred.await(entered);
          expect(yield* Deferred.isDone(saved)).toBe(false);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Deferred.await(saved)).toBe("Filename collisions");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              DiscussionTitleRequests.layer,
              application(),
              Layer.mock(ReviewStorage, {
                get: () => Effect.succeed(record),
                setDiscussionTitle: (cwd, parent, thread, title) =>
                  Effect.gen(function* () {
                    expect([cwd, parent, thread]).toEqual(["/project", "parent", "thread"]);
                    yield* Deferred.succeed(saved, title);
                  }),
              }),
              Layer.mock(PiModels, {
                complete: (input) =>
                  Effect.gen(function* () {
                    expect(input.selection).toEqual({ ...utilityModel, fastMode: false });
                    expect(input.context).toContain(request.firstUserMessage);
                    expect(input.context).not.toContain(record.anchor.selectedText);
                    expect(input.instructions).toContain("2–4 words");
                    expect(input.maximumOutputCharacters).toBe(40);
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                    return '"Filename collisions."';
                  }),
              }),
            ),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("keeps an existing saved title without renaming on reopen", () =>
    discussionTitles.assign(request).pipe(
      Effect.provide(
        Layer.mergeAll(
          application(),
          Layer.mock(ReviewStorage, {
            get: () => Effect.succeed({ ...record, title: "Saved title" }),
          }),
          Layer.mock(PiModels, {}),
        ),
      ),
    ),
  );

  it.effect("keeps the default when no utility model is configured", () =>
    discussionTitles
      .assign(request)
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            application(false),
            Layer.mock(ReviewStorage, {}),
            Layer.mock(PiModels, {}),
          ),
        ),
      ),
  );

  it.effect("a failed naming request does not stop the next chat from being named", () =>
    Effect.gen(function* () {
      const saved = yield* Deferred.make<string>();
      yield* Effect.gen(function* () {
        yield* discussionTitles.initialize();
        const requests = yield* DiscussionTitleRequests;
        yield* requests.offer(request);
        yield* requests.offer({ ...request, firstUserMessage: "A new topic" });
        expect(yield* Deferred.await(saved)).toBe("New topic");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DiscussionTitleRequests.layer,
            application(),
            Layer.mock(ReviewStorage, {
              get: () => Effect.succeed(record),
              setDiscussionTitle: (_cwd, _parent, _thread, title) =>
                Deferred.succeed(saved, title).pipe(Effect.asVoid),
            }),
            Layer.mock(PiModels, {
              complete: (input) =>
                input.context.includes(request.firstUserMessage)
                  ? Effect.fail(new PiModelCompletionError({ message: "Unavailable" }))
                  : Effect.succeed("New topic"),
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );
});
