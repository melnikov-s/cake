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

  constructor(
    private readonly root: string,
    private readonly loadMessages: ReviewMessageLoader = async () => [],
    private readonly migrateLegacy?: LegacyReviewMigrator
  ) {}

  agentSessionDirectory(workspacePath: string, sessionId: string, threadId: string) {
    return join(this.root, "pi-sessions", digestKey(workspacePath), digestKey(sessionId), digestKey(threadId));
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

  async create(workspacePath: string, sessionId: string, anchor: ReviewAnchor, body: string): Promise<ReviewThread> {
    const now = new Date().toISOString();
    const record = reviewThreadRecordSchema.parse({
      id: crypto.randomUUID(), workspacePath, sessionId, anchor, status: "open", createdAt: now, updatedAt: now,
      pendingComments: [{ id: crypto.randomUUID(), body: body.trim(), createdAt: now }]
    });
    await this.write(record);
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
    return this.project(record);
  }

  async attachAgentSession(workspacePath: string, sessionId: string, threadId: string, agent: { sessionId: string; sessionFile: string }): Promise<ReviewThread> {
    const record = await this.update(workspacePath, sessionId, threadId, (thread) => {
      thread.agentSessionId = agent.sessionId;
      thread.agentSessionFile = agent.sessionFile;
      thread.pendingComments.splice(0);
      thread.updatedAt = new Date().toISOString();
      return thread;
    });
    return this.project(record);
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
