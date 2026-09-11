import { Effect, Layer, Option, Predicate, Schema, SubscriptionRef } from "effect";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  projectReviewThread,
  reviewThreadRecordSchema,
  type ReviewAnchor,
  type ReviewSessionProjection,
  type ReviewThread,
  type ReviewThreadRecord,
} from "../../ipc/review-contract";
import { AtomicFileWriter } from "./internal/AtomicFileWriter";
import { KeyedSerialExecutor } from "../../utils/KeyedSerialExecutor";
import { ReviewStorage, ReviewStorageError } from "./ReviewStorage";

type ReviewSessionLoader = (record: ReviewThreadRecord) => Promise<ReviewSessionProjection>;
class ReviewRepository {
  private readonly updates = new KeyedSerialExecutor<string>();
  private readonly contextUpdates = new KeyedSerialExecutor<string>();
  private readonly writer = new AtomicFileWriter();

  constructor(
    private readonly root: string,
    private readonly piSessionRoot: string,
    private readonly loadSession: ReviewSessionLoader = async () => ({ parts: [] }),
  ) {}

  agentSessionDirectory(workspacePath: string, sessionId: string, threadId: string) {
    return join(
      this.piSessionRoot,
      digestKey(workspacePath),
      digestKey(sessionId),
      digestKey(threadId),
    );
  }

  reviewContextPath(workspacePath: string, sessionId: string) {
    return join(this.sessionDirectory(workspacePath, sessionId), "review-threads.md");
  }

  discussionParentContextPath(workspacePath: string, sessionId: string, threadId: string) {
    return join(
      this.sessionDirectory(workspacePath, sessionId),
      "context",
      `${digestKey(threadId)}.md`,
    );
  }

  async deleteSession(workspacePath: string, sessionId: string) {
    await Promise.all([
      rm(this.sessionDirectory(workspacePath, sessionId), { recursive: true, force: true }),
      rm(join(this.piSessionRoot, digestKey(workspacePath), digestKey(sessionId)), {
        recursive: true,
        force: true,
      }),
    ]);
  }

  async listSession(workspacePath: string, sessionId: string): Promise<ReviewThread[]> {
    const records = await this.listRecords(workspacePath, sessionId);
    return Promise.all(records.map((record) => this.project(record)));
  }

  /** Cake-owned Discussion anchors and sidecar references; replies remain in Pi. */
  listDiscussionRecords(workspacePath: string, sessionId: string) {
    return this.listRecords(workspacePath, sessionId);
  }

  async get(
    workspacePath: string,
    sessionId: string,
    threadId: string,
  ): Promise<ReviewThreadRecord | undefined> {
    try {
      return await this.readRecord(
        JSON.parse(await readFile(this.threadPath(workspacePath, sessionId, threadId), "utf8")),
      );
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async createDiscussion(
    workspacePath: string,
    sessionId: string,
    anchor: ReviewAnchor,
  ): Promise<ReviewThreadRecord> {
    const now = new Date().toISOString();
    const record = Schema.decodeUnknownSync(reviewThreadRecordSchema)({
      id: crypto.randomUUID(),
      workspacePath,
      sessionId,
      anchor,
      status: "open",
      createdAt: now,
      updatedAt: now,
      pendingComments: [],
    });
    await this.write(record);
    await this.refreshReviewContext(workspacePath, sessionId);
    return record;
  }

  async linkDiscussionSidecar(
    workspacePath: string,
    sessionId: string,
    threadId: string,
    sidecar: { sessionId: string; sessionFile: string },
  ): Promise<ReviewThreadRecord> {
    return this.update(workspacePath, sessionId, threadId, (thread) => ({
      ...thread,
      agentSessionId: sidecar.sessionId,
      agentSessionFile: sidecar.sessionFile,
      pendingComments: [],
      submission: undefined,
      updatedAt: new Date().toISOString(),
    }));
  }

  refreshDiscussionContext(workspacePath: string, sessionId: string) {
    return this.refreshReviewContext(workspacePath, sessionId);
  }

  async resolve(
    workspacePath: string,
    sessionId: string,
    threadId: string,
    resolved: boolean,
  ): Promise<ReviewThread> {
    const record = await this.update(workspacePath, sessionId, threadId, (thread) => {
      const now = new Date().toISOString();
      return {
        ...thread,
        status: resolved ? "resolved" : "open",
        resolvedAt: resolved ? now : undefined,
        updatedAt: now,
      };
    });
    await this.refreshReviewContext(workspacePath, sessionId);
    return this.project(record);
  }

  private async refreshReviewContext(workspacePath: string, sessionId: string) {
    const key = `${workspacePath}\u0000${sessionId}`;
    await this.contextUpdates.run(key, async () => {
      const threads = await this.listSession(workspacePath, sessionId);
      const target = this.reviewContextPath(workspacePath, sessionId);
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
      await mkdir(this.sessionDirectory(workspacePath, sessionId), {
        recursive: true,
        mode: 0o700,
      });
      await this.writer.write(
        target,
        `# Side chats and review threads\n\nParent session: ${sessionId}\n\nThis is a derived index of session-level side chats, inline code reviews, and assistant-message discussions.\n\n${sections.join("\n\n---\n\n")}\n`,
      );
    });
  }

  private async project(record: ReviewThreadRecord) {
    return projectReviewThread(
      record,
      record.agentSessionFile ? await this.loadSession(record) : { parts: [], usage: record.usage },
    );
  }

  private async listRecords(
    workspacePath: string,
    sessionId: string,
  ): Promise<ReviewThreadRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.sessionDirectory(workspacePath, sessionId));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          try {
            return await this.readRecord(
              JSON.parse(
                await readFile(join(this.sessionDirectory(workspacePath, sessionId), name), "utf8"),
              ),
            );
          } catch (error) {
            if (isMissing(error)) return undefined;
            throw error;
          }
        }),
    );
    return records
      .filter((record): record is ReviewThreadRecord => Boolean(record))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async update(
    workspacePath: string,
    sessionId: string,
    threadId: string,
    mutate: (thread: ReviewThreadRecord) => ReviewThreadRecord,
  ): Promise<ReviewThreadRecord> {
    const key = `${workspacePath}\u0000${sessionId}\u0000${threadId}`;
    return this.updates.run(key, async () => {
      const existing = await this.get(workspacePath, sessionId, threadId);
      if (!existing) throw new Error("That review thread no longer exists");
      const record = Schema.decodeUnknownSync(reviewThreadRecordSchema)(mutate(existing));
      await this.write(record);
      return record;
    });
  }

  private async readRecord(untrustedValue: unknown): Promise<ReviewThreadRecord> {
    const current = Schema.decodeUnknownOption(reviewThreadRecordSchema)(untrustedValue);
    if (Option.isSome(current)) return current.value;
    if (!Predicate.isObject(untrustedValue) || !Predicate.isObject(untrustedValue.anchor))
      throw new Error("Review thread document is malformed");
    const view = untrustedValue.anchor.view;
    if (view !== "diff" && view !== "full") throw new Error("Review thread document is malformed");
    const migrated = Schema.decodeUnknownSync(reviewThreadRecordSchema)({
      ...untrustedValue,
      anchor: { ...untrustedValue.anchor, view: "file" },
    });
    await this.write(migrated);
    return migrated;
  }

  private async write(record: ReviewThreadRecord) {
    const directory = this.sessionDirectory(record.workspacePath, record.sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.threadPath(record.workspacePath, record.sessionId, record.id);
    await this.writer.write(
      target,
      `${JSON.stringify(Schema.decodeUnknownSync(reviewThreadRecordSchema)(record), null, 2)}\n`,
    );
  }

  private sessionDirectory(workspacePath: string, sessionId: string) {
    return join(this.root, digestKey(workspacePath), digestKey(sessionId));
  }
  private threadPath(workspacePath: string, sessionId: string, threadId: string) {
    return join(this.sessionDirectory(workspacePath, sessionId), `${digestKey(threadId)}.json`);
  }
}

function digestKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const storageError = (operation: string, cause: unknown) =>
  new ReviewStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const makeReviewStorage = (
  root: string,
  piSessionRoot: string,
  loadSession?: ReviewSessionLoader,
) =>
  Effect.gen(function* () {
    const repository = new ReviewRepository(root, piSessionRoot, loadSession);
    const revision = yield* SubscriptionRef.make(0);
    const changed = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.tap(() => SubscriptionRef.update(revision, (value) => value + 1)));
    const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
      Effect.tryPromise({
        try: evaluate,
        catch: (cause) => storageError(operation, cause),
      });
    const service = ReviewStorage.of({
      changes: () => SubscriptionRef.changes(revision),
      agentSessionDirectory: (workingDirectory, sessionId, threadId) =>
        repository.agentSessionDirectory(workingDirectory, sessionId, threadId),
      reviewContextPath: (workingDirectory, sessionId) =>
        repository.reviewContextPath(workingDirectory, sessionId),
      discussionParentContextPath: (workingDirectory, sessionId, threadId) =>
        repository.discussionParentContextPath(workingDirectory, sessionId, threadId),
      deleteSession: Effect.fn("ReviewStorage.deleteSession")((workingDirectory, sessionId) =>
        changed(
          attempt("deleteSession", () => repository.deleteSession(workingDirectory, sessionId)),
        ),
      ),
      listSession: Effect.fn("ReviewStorage.listSession")((workingDirectory, sessionId) =>
        attempt("listSession", () => repository.listSession(workingDirectory, sessionId)),
      ),
      listDiscussionRecords: Effect.fn("ReviewStorage.listDiscussionRecords")(
        (workingDirectory, sessionId) =>
          attempt("listDiscussionRecords", () =>
            repository.listDiscussionRecords(workingDirectory, sessionId),
          ),
      ),
      get: Effect.fn("ReviewStorage.get")((workingDirectory, sessionId, threadId) =>
        attempt("get", () => repository.get(workingDirectory, sessionId, threadId)),
      ),
      createDiscussion: Effect.fn("ReviewStorage.createDiscussion")(
        (workingDirectory, sessionId, anchor) =>
          changed(
            attempt("createDiscussion", () =>
              repository.createDiscussion(workingDirectory, sessionId, anchor),
            ),
          ),
      ),
      linkDiscussionSidecar: Effect.fn("ReviewStorage.linkDiscussionSidecar")(
        (workingDirectory, sessionId, threadId, sidecar) =>
          changed(
            attempt("linkDiscussionSidecar", () =>
              repository.linkDiscussionSidecar(workingDirectory, sessionId, threadId, sidecar),
            ),
          ),
      ),
      resolve: Effect.fn("ReviewStorage.resolve")(
        (workingDirectory, sessionId, threadId, resolved) =>
          changed(
            attempt("resolve", () =>
              repository.resolve(workingDirectory, sessionId, threadId, resolved),
            ),
          ),
      ),
      refreshDiscussionContext: Effect.fn("ReviewStorage.refreshDiscussionContext")(
        (workingDirectory, sessionId) =>
          attempt("refreshDiscussionContext", () =>
            repository.refreshDiscussionContext(workingDirectory, sessionId),
          ),
      ),
    });
    return service;
  });

export const makeReviewStorageLive = (
  root: string,
  piSessionRoot: string,
  loadSession?: ReviewSessionLoader,
) => Layer.effect(ReviewStorage, makeReviewStorage(root, piSessionRoot, loadSession));
