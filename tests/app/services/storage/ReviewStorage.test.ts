import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { describe, expect } from "vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema, Stream } from "effect";
import {
  reviewThreadRecordSchema,
  type ReviewSessionProjection,
  type ReviewThreadRecord,
} from "../../../../src/ipc/review-contract";
import { ReviewStorage } from "../../../../src/services/storage/ReviewStorage";
import { makeReviewStorageTestAdapter } from "./ReviewStorageTestAdapter";

const TestPlatformLive = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const codeAnchor = {
  path: "src/app.ts",
  view: "file" as const,
  start: { diffLine: 2, newLine: 10, column: 3 },
  end: { diffLine: 3, newLine: 11, column: 8 },
  selectedText: "const value",
  contextBefore: "before",
  contextAfter: "after",
  diff: "@@",
};

const withStorage = <A, E, R>(
  prefix: string,
  use: (
    storage: ReviewStorage["Service"],
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    root: string,
  ) => Effect.Effect<A, E, R>,
  loadSession?: (record: ReviewThreadRecord) => Effect.Effect<ReviewSessionProjection, unknown>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix });
    return yield* Effect.gen(function* () {
      const storage = yield* ReviewStorage;
      return yield* use(storage, fileSystem, path, root);
    }).pipe(
      Effect.provide(
        makeReviewStorageTestAdapter(root, path.join(root, "pi-sessions"), loadSession),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(TestPlatformLive));

describe("ReviewStorage Discussion metadata", () => {
  it.effect("publishes a current-first revision stream for review mutations", () =>
    withStorage("cake-review-revisions-", (storage) =>
      Effect.gen(function* () {
        const observer = yield* storage
          .changes()
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* storage.createDiscussion("/project", "session", codeAnchor);
        const revisions = yield* Fiber.join(observer);
        expect([...revisions]).toEqual([0, 1]);
      }),
    ),
  );

  it.effect("atomically reuses a dedicated discussion anchor", () =>
    withStorage("cake-discussion-ensure-", (storage) =>
      Effect.gen(function* () {
        const assistantAnchor = {
          ...codeAnchor,
          path: "session:parent/assistant",
          view: "session" as const,
        };
        const [first, second] = yield* Effect.all(
          [
            storage.ensureDiscussion("/project", "parent", assistantAnchor),
            storage.ensureDiscussion("/project", "parent", assistantAnchor),
          ],
          { concurrency: "unbounded" },
        );
        expect(second.id).toBe(first.id);
        expect(yield* storage.listDiscussionRecords("/project", "parent")).toHaveLength(1);
      }),
    ),
  );

  for (const view of ["diff", "full"] as const) {
    it.effect(`migrates persisted ${view} review anchors to file anchors`, () =>
      withStorage("cake-review-migration-", (storage, fileSystem, path, root) =>
        Effect.gen(function* () {
          const created = yield* storage.createDiscussion("/project", "session", codeAnchor);
          const recordPath = path.join(
            root,
            digestKey("/project"),
            digestKey("session"),
            `${digestKey(created.id)}.json`,
          );
          const persisted = yield* fileSystem.readFileString(recordPath);
          yield* fileSystem.writeFileString(
            recordPath,
            persisted.replace('"view": "file"', `"view": "${view}"`),
          );

          const [migrated] = yield* storage.listDiscussionRecords("/project", "session");
          expect(migrated?.anchor.view).toBe("file");
          const saved = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(reviewThreadRecordSchema),
          )(yield* fileSystem.readFileString(recordPath));
          expect(saved.anchor.view).toBe("file");
        }),
      ),
    );
  }

  it.effect("persists anchors and sidecar references but projects replies from Pi", () =>
    withStorage(
      "cake-discussions-",
      (storage, fileSystem, path, root) =>
        Effect.gen(function* () {
          const created = yield* storage.createDiscussion("/project", "session", codeAnchor);
          const sessionMode = yield* Effect.promise(() =>
            stat(path.join(root, digestKey("/project"), digestKey("session"))),
          );
          expect(sessionMode.mode & 0o777).toBe(0o700);
          const recordMode = yield* Effect.promise(() =>
            stat(
              path.join(
                root,
                digestKey("/project"),
                digestKey("session"),
                `${digestKey(created.id)}.json`,
              ),
            ),
          );
          expect(recordMode.mode & 0o777).toBe(0o600);
          const linked = yield* storage.linkDiscussionSidecar("/project", "session", created.id, {
            sessionId: "pi-discussion",
            sessionFile: "/reviews/pi-discussion.jsonl",
          });
          expect(linked).toMatchObject({
            agentSessionId: "pi-discussion",
            agentSessionFile: "/reviews/pi-discussion.jsonl",
            pendingComments: [],
          });
          const [projected] = yield* storage.listSession("/project", "session");
          expect(projected?.parts).toEqual(projectedParts);

          const recordPath = path.join(
            root,
            digestKey("/project"),
            digestKey("session"),
            `${digestKey(created.id)}.json`,
          );
          const persistedText = yield* fileSystem.readFileString(recordPath);
          const persisted = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(reviewThreadRecordSchema),
          )(persistedText);
          expect(persistedText).not.toContain('"parts"');
          expect(persisted.pendingComments).toEqual([]);
        }),
      () => Effect.succeed({ parts: projectedParts }),
    ),
  );

  it.effect("serializes deletion behind an in-flight session mutation", () =>
    Effect.gen(function* () {
      const loadStarted = yield* Deferred.make<void>();
      const releaseLoad = yield* Deferred.make<void>();
      let shouldBlock = true;
      yield* withStorage(
        "cake-review-delete-race-",
        (storage) =>
          Effect.gen(function* () {
            const created = yield* storage.createDiscussion("/project", "session", codeAnchor);
            yield* storage.linkDiscussionSidecar("/project", "session", created.id, {
              sessionId: "pi-discussion",
              sessionFile: "/reviews/pi-discussion.jsonl",
            });
            const mutation = yield* storage
              .resolve("/project", "session", created.id, true)
              .pipe(Effect.forkChild);
            yield* Deferred.await(loadStarted);
            yield* storage.createDiscussion("/project", "other-session", codeAnchor);
            const deletion = yield* storage
              .deleteSession("/project", "session")
              .pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            expect(deletion.pollUnsafe()).toBeUndefined();
            yield* Deferred.succeed(releaseLoad, undefined);
            yield* Fiber.join(mutation);
            yield* Fiber.join(deletion);
            expect(yield* storage.listDiscussionRecords("/project", "session")).toEqual([]);
          }),
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(loadStarted, undefined);
            if (shouldBlock) {
              shouldBlock = false;
              yield* Deferred.await(releaseLoad);
            }
            return { parts: projectedParts };
          }),
      );
    }),
  );

  it.effect("refreshes the parent index and resolves Discussion anchors", () =>
    withStorage("cake-message-comments-", (storage, fileSystem) =>
      Effect.gen(function* () {
        const anchor = {
          path: "session:parent/message/assistant-1",
          view: "message" as const,
          messageId: "assistant-1",
          entryId: "entry-1",
          startOffset: 6,
          endOffset: 15,
          start: { diffLine: 0 },
          end: { diffLine: 0 },
          selectedText: "important",
          contextBefore: "Alpha ",
          contextAfter: " detail",
          diff: "",
        };
        const created = yield* storage.createDiscussion("/project", "parent", anchor);
        yield* storage.resolve("/project", "parent", created.id, true);
        yield* storage.refreshDiscussionContext("/project", "parent");

        const context = yield* fileSystem.readFileString(
          storage.reviewContextPath("/project", "parent"),
        );
        expect(context).toContain("important");
        expect(context).toContain(`${created.id} · resolved`);

        yield* storage.deleteSession("/project", "parent");
        expect(yield* storage.listDiscussionRecords("/project", "parent")).toEqual([]);
      }),
    ),
  );
});

const projectedParts = [
  {
    id: "pi-user",
    kind: "text" as const,
    role: "user" as const,
    text: "Use a clearer name",
    status: "complete" as const,
  },
  {
    id: "pi-assistant",
    kind: "text" as const,
    role: "assistant" as const,
    text: "Renamed it.",
    status: "complete" as const,
  },
];

function digestKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
