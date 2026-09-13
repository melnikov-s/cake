import {
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Predicate,
  RcMap,
  Schema,
  Scope,
  Semaphore,
  SubscriptionRef,
} from "effect";
import { createHash, randomUUID } from "node:crypto";
import {
  projectReviewThread,
  reviewThreadRecordSchema,
  type ReviewAnchor,
  type ReviewSessionProjection,
  type ReviewThreadRecord,
} from "../../ipc/review-contract";
import { ReviewStorage, ReviewStorageError } from "./ReviewStorage";
import { atomicWriteFile } from "./internal/atomicFile";

type ReviewSessionLoader = (
  record: ReviewThreadRecord,
) => Effect.Effect<ReviewSessionProjection, unknown>;

const storageError = (operation: string, cause: unknown) =>
  new ReviewStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const digestKey = (value: string) => createHash("sha256").update(value).digest("hex");
const serialKey = (...parts: ReadonlyArray<string>) => parts.join("\u0000");

export const makeReviewStorageLive = (
  root: string,
  piSessionRoot: string,
  loadSession: ReviewSessionLoader = () => Effect.succeed({ parts: [] }),
) =>
  Layer.effect(
    ReviewStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const revision = yield* SubscriptionRef.make(0);
      const updateLocks = yield* RcMap.make({ lookup: () => Semaphore.make(1) });
      const creationLocks = yield* RcMap.make({ lookup: () => Semaphore.make(1) });
      const contextLocks = yield* RcMap.make({ lookup: () => Semaphore.make(1) });

      const sessionDirectory = (workspacePath: string, sessionId: string) =>
        path.join(root, digestKey(workspacePath), digestKey(sessionId));
      const threadPath = (workspacePath: string, sessionId: string, threadId: string) =>
        path.join(sessionDirectory(workspacePath, sessionId), `${digestKey(threadId)}.json`);
      const agentSessionDirectory = (workspacePath: string, sessionId: string, threadId: string) =>
        path.join(
          piSessionRoot,
          digestKey(workspacePath),
          digestKey(sessionId),
          digestKey(threadId),
        );
      const reviewContextPath = (workspacePath: string, sessionId: string) =>
        path.join(sessionDirectory(workspacePath, sessionId), "review-threads.md");
      const discussionParentContextPath = (
        workspacePath: string,
        sessionId: string,
        threadId: string,
      ) =>
        path.join(
          sessionDirectory(workspacePath, sessionId),
          "context",
          `${digestKey(threadId)}.md`,
        );

      const withKeyLock = <A, E, R>(
        locks: RcMap.RcMap<unknown, Semaphore.Semaphore>,
        key: string,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> =>
        Effect.acquireUseRelease(
          Scope.make(),
          (leaseScope) =>
            Effect.gen(function* () {
              const lock = yield* RcMap.get(locks, key).pipe(
                Effect.provideService(Scope.Scope, leaseScope),
              );
              return yield* lock.withPermits(1)(effect);
            }),
          (leaseScope) => Scope.close(leaseScope, Exit.void),
        );

      const write = Effect.fn("ReviewStorage.write")(function* (record: ReviewThreadRecord) {
        const encoded = yield* Schema.encodeEffect(reviewThreadRecordSchema)(record);
        const content = yield* Effect.try(() => `${JSON.stringify(encoded, null, 2)}\n`);
        const target = threadPath(record.workspacePath, record.sessionId, record.id);
        yield* atomicWriteFile(fileSystem, path, target, content, (stage, cause) =>
          storageError(`write:${stage}`, cause),
        );
      });

      const readRecord = Effect.fn("ReviewStorage.readRecord")(function* (untrustedValue: unknown) {
        return yield* Schema.decodeUnknownEffect(reviewThreadRecordSchema)(untrustedValue).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              if (!Predicate.isObject(untrustedValue) || !Predicate.isObject(untrustedValue.anchor))
                return yield* Effect.fail(new Error("Review thread document is malformed"));
              const view = untrustedValue.anchor.view;
              if (view !== "diff" && view !== "full")
                return yield* Effect.fail(new Error("Review thread document is malformed"));
              const migrated = yield* Schema.decodeUnknownEffect(reviewThreadRecordSchema)({
                ...untrustedValue,
                anchor: { ...untrustedValue.anchor, view: "file" },
              });
              yield* write(migrated);
              return migrated;
            }),
          ),
        );
      });

      const readRecordFile = Effect.fn("ReviewStorage.readRecordFile")(function* (target: string) {
        const text = yield* fileSystem.readFileString(target);
        const parsed: unknown = yield* Effect.try(() => JSON.parse(text));
        return yield* readRecord(parsed);
      });

      const listRecords = Effect.fn("ReviewStorage.listRecords")(function* (
        workspacePath: string,
        sessionId: string,
      ) {
        const directory = sessionDirectory(workspacePath, sessionId);
        if (!(yield* fileSystem.exists(directory))) return [];
        const names = yield* fileSystem.readDirectory(directory);
        const records = yield* Effect.forEach(
          names.filter((name) => name.endsWith(".json")),
          (name) => readRecordFile(path.join(directory, name)),
          { concurrency: "unbounded" },
        );
        return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      });

      const getRecord = Effect.fn("ReviewStorage.getRecord")(function* (
        workspacePath: string,
        sessionId: string,
        threadId: string,
      ) {
        const target = threadPath(workspacePath, sessionId, threadId);
        if (!(yield* fileSystem.exists(target))) return undefined;
        return yield* readRecordFile(target);
      });

      const project = Effect.fn("ReviewStorage.project")(function* (record: ReviewThreadRecord) {
        const projection = record.agentSessionFile
          ? yield* loadSession(record)
          : { parts: [], usage: record.usage };
        return projectReviewThread(record, projection);
      });

      const listSessionInternal = Effect.fn("ReviewStorage.listSessionInternal")(function* (
        workspacePath: string,
        sessionId: string,
      ) {
        const records = yield* listRecords(workspacePath, sessionId);
        return yield* Effect.forEach(records, project, { concurrency: "unbounded" });
      });

      const refreshReviewContext = Effect.fn("ReviewStorage.refreshReviewContext")(function* (
        workspacePath: string,
        sessionId: string,
      ) {
        const key = serialKey(workspacePath, sessionId);
        yield* withKeyLock(
          contextLocks,
          key,
          Effect.gen(function* () {
            const threads = yield* listSessionInternal(workspacePath, sessionId);
            const sections = threads.map((thread) =>
              [
                `## Thread ${thread.id} · ${thread.status}`,
                thread.anchor.view === "message"
                  ? `Assistant message: ${thread.anchor.messageId ?? "unknown"}${thread.anchor.entryId ? ` · Pi entry ${thread.anchor.entryId}` : ""}`
                  : thread.anchor.view === "session"
                    ? "Session-level side chat"
                    : `Code: ${thread.anchor.path} · diff rows ${thread.anchor.start.diffLine}-${thread.anchor.end.diffLine}`,
                thread.anchor.selectedText
                  ? `> ${thread.anchor.selectedText.replaceAll("\n", "\n> ")}`
                  : "",
                ...thread.parts.flatMap((part) =>
                  part.kind === "text"
                    ? [`### ${part.role === "user" ? "User" : "Assistant"}\n\n${part.text}`]
                    : [],
                ),
              ].join("\n\n"),
            );
            const content = `# Side chats and review threads\n\nParent session: ${sessionId}\n\nThis is a derived index of session-level side chats, inline code reviews, and assistant-message discussions.\n\n${sections.join("\n\n---\n\n")}\n`;
            yield* atomicWriteFile(
              fileSystem,
              path,
              reviewContextPath(workspacePath, sessionId),
              content,
              (stage, cause) => storageError(`refreshContext:${stage}`, cause),
            );
          }),
        );
      });

      const createDiscussionInternal = Effect.fn("ReviewStorage.createDiscussionInternal")(
        function* (workspacePath: string, sessionId: string, anchor: ReviewAnchor) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const record = yield* Schema.decodeUnknownEffect(reviewThreadRecordSchema)({
            id: randomUUID(),
            workspacePath,
            sessionId,
            anchor,
            status: "open",
            createdAt: now,
            updatedAt: now,
            pendingComments: [],
          });
          yield* write(record);
          yield* refreshReviewContext(workspacePath, sessionId);
          return record;
        },
      );

      const update = Effect.fn("ReviewStorage.update")(function* (
        workspacePath: string,
        sessionId: string,
        threadId: string,
        mutate: (thread: ReviewThreadRecord) => ReviewThreadRecord,
      ) {
        const key = serialKey(workspacePath, sessionId, threadId);
        return yield* withKeyLock(
          updateLocks,
          key,
          Effect.gen(function* () {
            const existing = yield* getRecord(workspacePath, sessionId, threadId);
            if (!existing)
              return yield* Effect.fail(new Error("That review thread no longer exists"));
            const record = yield* Schema.decodeUnknownEffect(reviewThreadRecordSchema)(
              mutate(existing),
            );
            yield* write(record);
            return record;
          }),
        );
      });

      const changed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.tap(() => SubscriptionRef.update(revision, (value) => value + 1)));
      const boundary = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.mapError((cause) => storageError(operation, cause)));

      return ReviewStorage.of({
        changes: () => SubscriptionRef.changes(revision),
        agentSessionDirectory,
        reviewContextPath,
        discussionParentContextPath,
        deleteSession: Effect.fn("ReviewStorage.deleteSession")((workspacePath, sessionId) =>
          changed(
            boundary(
              "deleteSession",
              Effect.all([
                fileSystem.remove(sessionDirectory(workspacePath, sessionId), {
                  recursive: true,
                  force: true,
                }),
                fileSystem.remove(
                  path.join(piSessionRoot, digestKey(workspacePath), digestKey(sessionId)),
                  { recursive: true, force: true },
                ),
              ]).pipe(Effect.asVoid),
            ),
          ),
        ),
        listSession: Effect.fn("ReviewStorage.listSession")((workspacePath, sessionId) =>
          boundary("listSession", listSessionInternal(workspacePath, sessionId)),
        ),
        listDiscussionRecords: Effect.fn("ReviewStorage.listDiscussionRecords")(
          (workspacePath, sessionId) =>
            boundary("listDiscussionRecords", listRecords(workspacePath, sessionId)),
        ),
        get: Effect.fn("ReviewStorage.get")((workspacePath, sessionId, threadId) =>
          boundary("get", getRecord(workspacePath, sessionId, threadId)),
        ),
        createDiscussion: Effect.fn("ReviewStorage.createDiscussion")(
          (workspacePath, sessionId, anchor) =>
            changed(
              boundary(
                "createDiscussion",
                createDiscussionInternal(workspacePath, sessionId, anchor),
              ),
            ),
        ),
        ensureDiscussion: Effect.fn("ReviewStorage.ensureDiscussion")(
          (workspacePath, sessionId, anchor) =>
            changed(
              boundary(
                "ensureDiscussion",
                withKeyLock(
                  creationLocks,
                  serialKey(workspacePath, sessionId, anchor.view ?? "file", anchor.path),
                  Effect.gen(function* () {
                    const records = yield* listRecords(workspacePath, sessionId);
                    const existing = records.find(
                      (record) =>
                        record.anchor.view === anchor.view && record.anchor.path === anchor.path,
                    );
                    return (
                      existing ??
                      (yield* createDiscussionInternal(workspacePath, sessionId, anchor))
                    );
                  }),
                ),
              ),
            ),
        ),
        linkDiscussionSidecar: Effect.fn("ReviewStorage.linkDiscussionSidecar")(
          (workspacePath, sessionId, threadId, sidecar) =>
            changed(
              boundary(
                "linkDiscussionSidecar",
                Effect.gen(function* () {
                  const now = DateTime.formatIso(yield* DateTime.now);
                  return yield* update(workspacePath, sessionId, threadId, (thread) => ({
                    ...thread,
                    agentSessionId: sidecar.sessionId,
                    agentSessionFile: sidecar.sessionFile,
                    pendingComments: [],
                    submission: undefined,
                    updatedAt: now,
                  }));
                }),
              ),
            ),
        ),
        resolve: Effect.fn("ReviewStorage.resolve")(
          (workspacePath, sessionId, threadId, resolved) =>
            changed(
              boundary(
                "resolve",
                Effect.gen(function* () {
                  const now = DateTime.formatIso(yield* DateTime.now);
                  const record = yield* update(workspacePath, sessionId, threadId, (thread) => ({
                    ...thread,
                    status: resolved ? "resolved" : "open",
                    resolvedAt: resolved ? now : undefined,
                    updatedAt: now,
                  }));
                  yield* refreshReviewContext(workspacePath, sessionId);
                  return yield* project(record);
                }),
              ),
            ),
        ),
        refreshDiscussionContext: Effect.fn("ReviewStorage.refreshDiscussionContext")(
          (workspacePath, sessionId) =>
            changed(
              boundary("refreshDiscussionContext", refreshReviewContext(workspacePath, sessionId)),
            ),
        ),
      });
    }),
  );
