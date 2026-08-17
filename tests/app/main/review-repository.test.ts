import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewRepository } from "../../../src/main/review-repository";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("ReviewRepository", () => {
  it("exports all review threads as live parent-readable context", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-message-comments-")); directories.push(root);
    const repository = new ReviewRepository(root, join(root, "pi-sessions"));
    const anchor = { path: "session:parent/message/assistant-1", view: "message" as const, messageId: "assistant-1", entryId: "entry-1", startOffset: 6, endOffset: 15, start: { diffLine: 0 }, end: { diffLine: 0 }, selectedText: "important", contextBefore: "Alpha ", contextAfter: " detail", diff: "" };

    const created = await repository.create("/project", "parent", anchor, "Why is this important?");
    let context = await readFile(repository.reviewContextPath("/project", "parent"), "utf8");
    expect(context).toContain("important");
    expect(context).toContain("Why is this important?");

    await repository.resolve("/project", "parent", created.id, true);
    context = await readFile(repository.reviewContextPath("/project", "parent"), "utf8");
    expect(context).toContain(`${created.id} · resolved`);
  });

  it("persists only review metadata and projects chat parts from the referenced Pi session", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-reviews-")); directories.push(root);
    const projectedParts = [{ id: "pi-user", kind: "text" as const, role: "user" as const, text: "Use a clearer name", status: "complete" as const }, { id: "tool-1", kind: "tool" as const, name: "read", input: "src/app.ts", output: "source", state: "success" as const }, { id: "pi-assistant", kind: "text" as const, role: "assistant" as const, text: "Renamed it.", status: "complete" as const }];
    const repository = new ReviewRepository(root, join(root, "pi-sessions"), async () => ({ parts: projectedParts }));
    const anchor = { path: "src/app.ts", start: { diffLine: 2, newLine: 10, column: 3 }, end: { diffLine: 3, newLine: 11, column: 8 }, selectedText: "const value", contextBefore: "before", contextAfter: "after", diff: "@@" };
    const created = await repository.create("/project", "session", anchor, "Use a clearer name");
    expect(created.parts[0]).toMatchObject({ role: "user", deliveryState: "sending" });
    expect(await readFile(repository.reviewContextPath("/project", "session"), "utf8")).toContain("Code: src/app.ts · diff rows 2-3");
    expect((await repository.listSession("/project", "session")).filter((thread) => thread.status === "open")).toHaveLength(1);

    const runId = crypto.randomUUID();
    const claimed = await repository.claimPending("/project", "session", created.id, runId);
    expect(claimed?.submission).toMatchObject({ status: "running", runId });
    const answered = await repository.completeRun("/project", "session", created.id, runId, { sessionId: "pi-review", sessionFile: "/reviews/pi-review.jsonl" });
    expect(answered).toBeDefined();
    expect(answered!.agentSessionId).toBe("pi-review");
    expect(answered!.parts).toEqual(projectedParts);
    const record = await repository.get("/project", "session", created.id);
    expect(record).toMatchObject({ agentSessionId: "pi-review", agentSessionFile: "/reviews/pi-review.jsonl", pendingComments: [] });
    expect(record).not.toHaveProperty("parts");
    const replied = await repository.reply("/project", "session", created.id, "One more thing");
    expect(replied.parts.at(-1)).toMatchObject({ role: "user", text: "One more thing", deliveryState: "sending" });
    await repository.resolve("/project", "session", created.id, true);
    expect((await repository.listSession("/project", "session")).filter((thread) => thread.status === "open")).toHaveLength(0);
    expect((await new ReviewRepository(root, join(root, "pi-sessions"), async () => ({ parts: projectedParts })).listSession("/project", "session"))[0]?.status).toBe("resolved");
  });

  it("atomically claims pending comments and rejects stale completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-review-claims-")); directories.push(root);
    const repository = new ReviewRepository(root, join(root, "pi-sessions"));
    const anchor = { path: "src/app.ts", start: { diffLine: 1 }, end: { diffLine: 1 }, selectedText: "", contextBefore: "", contextAfter: "", diff: "" };
    const created = await repository.create("/project", "session", anchor, "Explain this");
    const firstRun = crypto.randomUUID();
    const secondRun = crypto.randomUUID();

    const [first, second] = await Promise.all([
      repository.claimPending("/project", "session", created.id, firstRun),
      repository.claimPending("/project", "session", created.id, secondRun)
    ]);
    const winner = first ?? second;
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(winner?.submission).toMatchObject({ status: "running" });

    const staleRun = winner?.submission?.runId === firstRun ? secondRun : firstRun;
    expect(await repository.completeRun("/project", "session", created.id, staleRun, { sessionId: "stale", sessionFile: "/stale.jsonl" })).toBeUndefined();
    expect((await repository.get("/project", "session", created.id))?.pendingComments).toHaveLength(1);

    await repository.reply("/project", "session", created.id, "A later comment");
    await repository.completeRun("/project", "session", created.id, winner!.submission!.runId, { sessionId: "winner", sessionFile: "/winner.jsonl" });
    expect((await repository.get("/project", "session", created.id))?.pendingComments).toEqual([expect.objectContaining({ body: "A later comment" })]);
  });

  it("recovers abandoned running claims as retryable failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-review-recovery-")); directories.push(root);
    const repository = new ReviewRepository(root, join(root, "pi-sessions"));
    const anchor = { path: "src/app.ts", start: { diffLine: 1 }, end: { diffLine: 1 }, selectedText: "", contextBefore: "", contextAfter: "", diff: "" };
    const created = await repository.create("/project", "session", anchor, "Explain this");
    await repository.claimPending("/project", "session", created.id, crypto.randomUUID());

    await repository.recoverRunning("/project");

    const recovered = await repository.get("/project", "session", created.id);
    expect(recovered?.submission).toMatchObject({ status: "failed", error: expect.stringContaining("Retry") });
    expect(recovered?.pendingComments).toHaveLength(1);
    expect(await repository.claimPending("/project", "session", created.id, crypto.randomUUID())).toBeDefined();
  });

  it("keeps a failed comment pending without projecting its failed Pi-session copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-reviews-")); directories.push(root);
    const projectedParts = [{ id: "pi-user", kind: "text" as const, role: "user" as const, text: "Are you sure?", status: "complete" as const }];
    const repository = new ReviewRepository(root, join(root, "pi-sessions"), async () => ({ parts: projectedParts }));
    const anchor = { path: "src/app.ts", start: { diffLine: 1 }, end: { diffLine: 1 }, selectedText: "", contextBefore: "", contextAfter: "", diff: "" };
    const created = await repository.create("/project", "session", anchor, "Are you sure?");
    const runId = crypto.randomUUID();
    await repository.claimPending("/project", "session", created.id, runId);

    const failed = await repository.failRun("/project", "session", created.id, runId, "Unsupported parameter: prompt_cache_options");

    expect(failed?.parts).toEqual([expect.objectContaining({ text: "Are you sure?", deliveryState: "sending" })]);
    const record = await repository.get("/project", "session", created.id);
    expect(record).toMatchObject({
      pendingComments: [expect.objectContaining({ body: "Are you sure?" })],
      submission: { status: "failed", error: "Unsupported parameter: prompt_cache_options" }
    });
    expect(record).not.toHaveProperty("agentSessionFile");
  });
});
