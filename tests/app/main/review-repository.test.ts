import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewRepository } from "../../../src/main/review-repository";
import { loadReviewSessionMessages, migrateLegacyReviewSession } from "../../../src/agent/pi-runtime";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("ReviewRepository", () => {
  it("persists only review metadata and projects messages from the referenced Pi session", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-reviews-")); directories.push(root);
    const projectedMessages = [{ id: "pi-user", role: "user" as const, body: "Use a clearer name", createdAt: new Date(0).toISOString(), delivered: true, status: "complete" as const }, { id: "pi-assistant", role: "assistant" as const, body: "Renamed it.", createdAt: new Date(1).toISOString(), delivered: true, status: "complete" as const }];
    const repository = new ReviewRepository(root, async () => projectedMessages);
    const anchor = { path: "src/app.ts", start: { diffLine: 2, newLine: 10, column: 3 }, end: { diffLine: 3, newLine: 11, column: 8 }, selectedText: "const value", contextBefore: "before", contextAfter: "after", diff: "@@" };
    const created = await repository.create("/project", "session", anchor, "Use a clearer name");
    expect(created.messages[0]).toMatchObject({ role: "user", delivered: false });
    expect((await repository.listSession("/project", "session")).filter((thread) => thread.status === "open")).toHaveLength(1);

    const answered = await repository.attachAgentSession("/project", "session", created.id, { sessionId: "pi-review", sessionFile: "/reviews/pi-review.jsonl" });
    expect(answered.agentSessionId).toBe("pi-review");
    expect(answered.messages).toEqual(projectedMessages);
    const record = await repository.get("/project", "session", created.id);
    expect(record).toMatchObject({ agentSessionId: "pi-review", agentSessionFile: "/reviews/pi-review.jsonl", pendingComments: [] });
    expect(record).not.toHaveProperty("messages");
    const replied = await repository.reply("/project", "session", created.id, "One more thing");
    expect(replied.messages.at(-1)).toMatchObject({ role: "user", body: "One more thing", delivered: false });
    await repository.resolve("/project", "session", created.id, true);
    expect((await repository.listSession("/project", "session")).filter((thread) => thread.status === "open")).toHaveLength(0);
    expect((await new ReviewRepository(root, async () => projectedMessages).listSession("/project", "session"))[0]?.status).toBe("resolved");
  });

  it("migrates a legacy Cake transcript into a durable Pi session", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-review-migration-")); directories.push(root);
    const now = new Date(0).toISOString();
    const messages = [
      { id: "legacy-user", role: "user" as const, body: "Why this name?", createdAt: now, delivered: true, status: "complete" as const },
      { id: "legacy-assistant", role: "assistant" as const, body: "It describes the value.", createdAt: now, delivered: true, status: "complete" as const }
    ];

    const agent = await migrateLegacyReviewSession({ workspacePath: "/project", messages }, join(root, "pi"));
    const projected = await loadReviewSessionMessages({
      id: "review", workspacePath: "/project", sessionId: "parent", agentSessionId: agent.sessionId, agentSessionFile: agent.sessionFile,
      anchor: { path: "src/app.ts", start: { diffLine: 1 }, end: { diffLine: 1 }, selectedText: "", contextBefore: "", contextAfter: "", diff: "" },
      pendingComments: [], status: "open", createdAt: now, updatedAt: now
    });

    expect(projected.map(({ role, body }) => ({ role, body }))).toEqual([
      { role: "user", body: "Why this name?" },
      { role: "assistant", body: "It describes the value." }
    ]);
  });
});
