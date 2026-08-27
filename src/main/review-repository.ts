import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  projectReviewThread,
  reviewThreadRecordSchema,
  type ReviewAnchor,
  type ReviewSessionProjection,
  type ReviewThread,
  type ReviewThreadRecord,
} from "../ipc/review-contract";
import { AtomicFileWriter } from "./atomic-file-writer";
import { KeyedSerialExecutor } from "./keyed-serial-executor";

const legacyReviewThreadRecordSchema = z
  .object({
    anchor: z
      .object({
        view: z.enum(["diff", "full"]),
      })
      .passthrough(),
  })
  .passthrough()
  .transform((record) =>
    reviewThreadRecordSchema.parse({
      ...record,
      anchor: { ...record.anchor, view: "file" },
    }),
  );

export type ReviewSessionLoader = (record: ReviewThreadRecord) => Promise<ReviewSessionProjection>;
export class ReviewRepository {
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

  async listSession(workspacePath: string, sessionId: string): Promise<ReviewThread[]> {
    const records = await this.listRecords(workspacePath, sessionId);
    return Promise.all(records.map((record) => this.project(record)));
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

  async recoverRunning(workspacePath: string): Promise<void> {
    let sessionDirectories: string[];
    try {
      sessionDirectories = await readdir(join(this.root, digestKey(workspacePath)));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await Promise.all(
      sessionDirectories.map(async (sessionDirectory) => {
        const directory = join(this.root, digestKey(workspacePath), sessionDirectory);
        const names = await readdir(directory);
        await Promise.all(
          names
            .filter((name) => name.endsWith(".json"))
            .map(async (name) => {
              const path = join(directory, name);
              const record = await this.readRecord(JSON.parse(await readFile(path, "utf8")));
              if (record.submission?.status !== "running") return;
              record.submission = {
                ...record.submission,
                status: "failed",
                failedAt: new Date().toISOString(),
                error: "Cake stopped before this review run completed. Retry the comment.",
              };
              record.updatedAt = new Date().toISOString();
              await this.write(record);
            }),
        );
      }),
    );
  }

  async claimPending(
    workspacePath: string,
    sessionId: string,
    threadId: string,
    runId: string,
  ): Promise<ReviewThreadRecord | undefined> {
    let claimed: ReviewThreadRecord | undefined;
    await this.update(workspacePath, sessionId, threadId, (thread) => {
      if (
        thread.status !== "open" ||
        thread.pendingComments.length === 0 ||
        thread.submission?.status === "running"
      )
        return thread;
      const now = new Date().toISOString();
      thread.submission = {
        status: "running",
        runId,
        commentIds: thread.pendingComments.map((comment) => comment.id),
        startedAt: now,
      };
      thread.updatedAt = now;
      claimed = reviewThreadRecordSchema.parse(thread);
      return thread;
    });
    return claimed;
  }

  async create(
    workspacePath: string,
    sessionId: string,
    anchor: ReviewAnchor,
    body: string,
  ): Promise<ReviewThread> {
    const now = new Date().toISOString();
    const record = reviewThreadRecordSchema.parse({
      id: crypto.randomUUID(),
      workspacePath,
      sessionId,
      anchor,
      status: "open",
      createdAt: now,
      updatedAt: now,
      pendingComments: [{ id: crypto.randomUUID(), body: body.trim(), createdAt: now }],
    });
    await this.write(record);
    await this.refreshReviewContext(workspacePath, sessionId);
    return projectReviewThread(record);
  }

  async reply(
    workspacePath: string,
    sessionId: string,
    threadId: string,
    body: string,
  ): Promise<ReviewThread> {
    const record = await this.update(workspacePath, sessionId, threadId, (thread) => {
      const now = new Date().toISOString();
      thread.pendingComments.push({ id: crypto.randomUUID(), body: body.trim(), createdAt: now });
      thread.status = "open";
      thread.resolvedAt = undefined;
      thread.updatedAt = now;
      return thread;
    });
    await this.refreshReviewContext(workspacePath, sessionId);
    return this.project(record);
  }

  async resolve(
    workspacePath: string,
    sessionId: string,
    threadId: string,
    resolved: boolean,
  ): Promise<ReviewThread> {
    const record = await this.update(workspacePath, sessionId, threadId, (thread) => {
      const now = new Date().toISOString();
      thread.status = resolved ? "resolved" : "open";
      thread.resolvedAt = resolved ? now : undefined;
      thread.updatedAt = now;
      return thread;
    });
    await this.refreshReviewContext(workspacePath, sessionId);
    return this.project(record);
  }

  async completeRun(
    workspacePath: string,
    sessionId: string,
    threadId: string,
    runId: string,
    agent: { sessionId: string; sessionFile: string; usage?: ReviewThreadRecord["usage"] },
  ): Promise<ReviewThread | undefined> {
    let completed = false;
    const record = await this.update(workspacePath, sessionId, threadId, (thread) => {
      if (thread.submission?.status !== "running" || thread.submission.runId !== runId)
        return thread;
      thread.agentSessionId = agent.sessionId;
      thread.agentSessionFile = agent.sessionFile;
      thread.usage = agent.usage;
      const now = new Date().toISOString();
      const claimed = new Set(thread.submission.commentIds);
      thread.pendingComments.splice(
        0,
        thread.pendingComments.length,
        ...thread.pendingComments.filter((comment) => !claimed.has(comment.id)),
      );
      thread.submission = { status: "answered", runId, commentIds: [...claimed], completedAt: now };
      thread.updatedAt = now;
      completed = true;
      return thread;
    });
    if (!completed) return undefined;
    await this.refreshReviewContext(workspacePath, sessionId);
    return this.project(record);
  }

  async failRun(
    workspacePath: string,
    sessionId: string,
    threadId: string,
    runId: string,
    error: string,
  ): Promise<ReviewThread | undefined> {
    let failed = false;
    const record = await this.update(workspacePath, sessionId, threadId, (thread) => {
      if (thread.submission?.status !== "running" || thread.submission.runId !== runId)
        return thread;
      const now = new Date().toISOString();
      thread.submission = {
        status: "failed",
        runId,
        commentIds: thread.submission.commentIds,
        failedAt: now,
        error,
      };
      thread.updatedAt = now;
      failed = true;
      return thread;
    });
    if (!failed) return undefined;
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
            : `Code: ${thread.anchor.path} · diff rows ${thread.anchor.start.diffLine}-${thread.anchor.end.diffLine}`,
          `> ${thread.anchor.selectedText.replaceAll("\n", "\n> ")}`,
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
        `# Review threads\n\nParent session: ${sessionId}\n\nThis is a derived index of inline code reviews and assistant-message discussions.\n\n${sections.join("\n\n---\n\n")}\n`,
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
      const record = reviewThreadRecordSchema.parse(mutate(existing));
      await this.write(record);
      return record;
    });
  }

  private async readRecord(untrustedValue: unknown): Promise<ReviewThreadRecord> {
    const current = reviewThreadRecordSchema.safeParse(untrustedValue);
    if (current.success) return current.data;

    const migrated = legacyReviewThreadRecordSchema.safeParse(untrustedValue);
    if (!migrated.success) throw current.error;

    await this.write(migrated.data);
    return migrated.data;
  }

  private async write(record: ReviewThreadRecord) {
    const directory = this.sessionDirectory(record.workspacePath, record.sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.threadPath(record.workspacePath, record.sessionId, record.id);
    await this.writer.write(
      target,
      `${JSON.stringify(reviewThreadRecordSchema.parse(record), null, 2)}\n`,
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
