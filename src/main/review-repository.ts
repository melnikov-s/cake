import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  projectReviewThread,
  reviewThreadSchema,
  reviewThreadRecordSchema,
  type ReviewAnchor,
  type ReviewMessage,
  type ReviewThread,
  type ReviewThreadRecord
} from "../ipc/review-contract";

export type ReviewMessageLoader = (record: ReviewThreadRecord) => Promise<ReviewMessage[]>;
export type LegacyReviewMigrator = (thread: ReviewThread, sessionDir: string) => Promise<{ sessionId: string; sessionFile: string }>;

export class ReviewRepository {
  private readonly updates = new Map<string, Promise<unknown>>();
  private readonly contextUpdates = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root: string,
    private readonly piSessionRoot: string,
    private readonly loadMessages: ReviewMessageLoader = async () => [],
    private readonly migrateLegacy?: LegacyReviewMigrator
  ) {}

  agentSessionDirectory(workspacePath: string, sessionId: string, threadId: string) {
    return join(this.piSessionRoot, digestKey(workspacePath), digestKey(sessionId), digestKey(threadId));
  }

  reviewContextPath(workspacePath: string, sessionId: string) {
    return join(this.sessionDirectory(workspacePath, sessionId), "review-threads.md");
  }

  async listSession(workspacePath: string, sessionId: string): Promise<ReviewThread[]> {
    const records = await this.listRecords(workspacePath, sessionId);
    return Promise.all(records.map((record) => this.project(record)));
  }

  async get(workspacePath: string, sessionId: string, threadId: string): Promise<ReviewThreadRecord | undefined> {
    try {
      return await this.readRecord(JSON.parse(await readFile(this.threadPath(workspacePath, sessionId, threadId), "utf8")));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async recoverRunning(workspacePath: string): Promise<void> {
    let sessionDirectories: string[];
    try { sessionDirectories = await readdir(join(this.root, digestKey(workspacePath))); }
    catch (error) { if (isMissing(error)) return; throw error; }
    await Promise.all(sessionDirectories.map(async (sessionDirectory) => {
      const directory = join(this.root, digestKey(workspacePath), sessionDirectory);
      const names = await readdir(directory);
      await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
        const path = join(directory, name);
        const record = await this.readRecord(JSON.parse(await readFile(path, "utf8")));
        if (record.submission?.status !== "running") return;
        record.submission = { ...record.submission, status: "failed", failedAt: new Date().toISOString(), error: "Cake stopped before this review run completed. Retry the comment." };
        record.updatedAt = new Date().toISOString();
        await this.write(record);
      }));
    }));
  }

  async claimPending(workspacePath: string, sessionId: string, threadId: string, runId: string): Promise<ReviewThreadRecord | undefined> {
    let claimed: ReviewThreadRecord | undefined;
    await this.update(workspacePath, sessionId, threadId, (thread) => {
      if (thread.status !== "open" || thread.pendingComments.length === 0 || thread.submission?.status === "running") return thread;
      const now = new Date().toISOString();
      thread.submission = { status: "running", runId, commentIds: thread.pendingComments.map((comment) => comment.id), startedAt: now };
      thread.updatedAt = now;
      claimed = reviewThreadRecordSchema.parse(thread);
      return thread;
    });
    return claimed;
  }

  async create(workspacePath: string, sessionId: string, anchor: ReviewAnchor, body: string): Promise<ReviewThread> {
    const now = new Date().toISOString();
    const record = reviewThreadRecordSchema.parse({
      id: crypto.randomUUID(), workspacePath, sessionId, anchor, status: "open", createdAt: now, updatedAt: now,
      pendingComments: [{ id: crypto.randomUUID(), body: body.trim(), createdAt: now }]
    });
    await this.write(record);
    await this.refreshReviewContext(workspacePath, sessionId);
    return projectReviewThread(record);
  }

  async reply(workspacePath: string, sessionId: string, threadId: string, body: string): Promise<ReviewThread> {
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

  async resolve(workspacePath: string, sessionId: string, threadId: string, resolved: boolean): Promise<ReviewThread> {
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

  async completeRun(workspacePath: string, sessionId: string, threadId: string, runId: string, agent: { sessionId: string; sessionFile: string }): Promise<ReviewThread | undefined> {
    let completed = false;
    const record = await this.update(workspacePath, sessionId, threadId, (thread) => {
      if (thread.submission?.status !== "running" || thread.submission.runId !== runId) return thread;
      thread.agentSessionId = agent.sessionId;
      thread.agentSessionFile = agent.sessionFile;
      const now = new Date().toISOString();
      const claimed = new Set(thread.submission.commentIds);
      thread.pendingComments.splice(0, thread.pendingComments.length, ...thread.pendingComments.filter((comment) => !claimed.has(comment.id)));
      thread.submission = { status: "answered", runId, commentIds: [...claimed], completedAt: now };
      thread.updatedAt = now;
      completed = true;
      return thread;
    });
    if (!completed) return undefined;
    await this.refreshReviewContext(workspacePath, sessionId);
    return this.project(record);
  }

  async failRun(workspacePath: string, sessionId: string, threadId: string, runId: string, error: string): Promise<ReviewThread | undefined> {
    let failed = false;
    const record = await this.update(workspacePath, sessionId, threadId, (thread) => {
      if (thread.submission?.status !== "running" || thread.submission.runId !== runId) return thread;
      const now = new Date().toISOString();
      thread.submission = { status: "failed", runId, commentIds: thread.submission.commentIds, failedAt: now, error };
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
    const previous = this.contextUpdates.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const threads = await this.listSession(workspacePath, sessionId);
      const target = this.reviewContextPath(workspacePath, sessionId);
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const sections = threads.map((thread) => [
        `## Thread ${thread.id} · ${thread.status}`,
        thread.anchor.view === "message"
          ? `Assistant message: ${thread.anchor.messageId ?? "unknown"}${thread.anchor.entryId ? ` · Pi entry ${thread.anchor.entryId}` : ""}`
          : `Code: ${thread.anchor.path} · diff rows ${thread.anchor.start.diffLine}-${thread.anchor.end.diffLine}`,
        `> ${thread.anchor.selectedText.replaceAll("\n", "\n> ")}`,
        ...thread.messages.map((message) => `### ${message.role === "user" ? "User" : "Assistant"}\n\n${message.body}`)
      ].join("\n\n"));
      await mkdir(this.sessionDirectory(workspacePath, sessionId), { recursive: true, mode: 0o700 });
      await writeFile(temporary, `# Review threads\n\nParent session: ${sessionId}\n\nThis is a derived index of inline code reviews and assistant-message discussions.\n\n${sections.join("\n\n---\n\n")}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    });
    this.contextUpdates.set(key, next);
    try { await next; }
    finally { if (this.contextUpdates.get(key) === next) this.contextUpdates.delete(key); }
  }

  private async project(record: ReviewThreadRecord) {
    return projectReviewThread(record, record.agentSessionFile ? await this.loadMessages(record) : []);
  }

  private async listRecords(workspacePath: string, sessionId: string): Promise<ReviewThreadRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.sessionDirectory(workspacePath, sessionId));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      try {
        return await this.readRecord(JSON.parse(await readFile(join(this.sessionDirectory(workspacePath, sessionId), name), "utf8")));
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    }));
    return records.filter((record): record is ReviewThreadRecord => Boolean(record)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async update(workspacePath: string, sessionId: string, threadId: string, mutate: (thread: ReviewThreadRecord) => ReviewThreadRecord): Promise<ReviewThreadRecord> {
    const key = `${workspacePath}\u0000${sessionId}\u0000${threadId}`;
    const previous = this.updates.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const existing = await this.get(workspacePath, sessionId, threadId);
      if (!existing) throw new Error("That review thread no longer exists");
      const record = reviewThreadRecordSchema.parse(mutate(existing));
      await this.write(record);
      return record;
    });
    this.updates.set(key, next);
    try { return await next; }
    finally { if (this.updates.get(key) === next) this.updates.delete(key); }
  }

  private async readRecord(value: unknown): Promise<ReviewThreadRecord> {
    const current = reviewThreadRecordSchema.safeParse(value);
    if (current.success) return current.data;
    const legacy = reviewThreadSchema.parse(value);
    const delivered = legacy.messages.filter((message) => message.delivered);
    const agent = delivered.length > 0 && this.migrateLegacy
      ? await this.migrateLegacy({ ...legacy, messages: delivered }, this.agentSessionDirectory(legacy.workspacePath, legacy.sessionId, legacy.id))
      : undefined;
    const record = reviewThreadRecordSchema.parse({
      id: legacy.id,
      workspacePath: legacy.workspacePath,
      sessionId: legacy.sessionId,
      agentSessionId: agent?.sessionId,
      agentSessionFile: agent?.sessionFile,
      anchor: legacy.anchor,
      pendingComments: legacy.messages.filter((message) => message.role === "user" && !message.delivered).map(({ id, body, createdAt }) => ({ id, body, createdAt })),
      status: legacy.status,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
      resolvedAt: legacy.resolvedAt
    });
    await this.write(record);
    return record;
  }

  private async write(record: ReviewThreadRecord) {
    const directory = this.sessionDirectory(record.workspacePath, record.sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.threadPath(record.workspacePath, record.sessionId, record.id);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(reviewThreadRecordSchema.parse(record), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private sessionDirectory(workspacePath: string, sessionId: string) { return join(this.root, digestKey(workspacePath), digestKey(sessionId)); }
  private threadPath(workspacePath: string, sessionId: string, threadId: string) { return join(this.sessionDirectory(workspacePath, sessionId), `${digestKey(threadId)}.json`); }
}

function digestKey(value: string) { return createHash("sha256").update(value).digest("hex"); }
function isMissing(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
