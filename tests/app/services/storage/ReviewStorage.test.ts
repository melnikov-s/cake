import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeReviewStorageTestAdapter } from "../../../../src/services/storage/ReviewStorageLive";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

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

describe("ReviewStorage Discussion metadata", () => {
  it("publishes a current-first revision stream for review mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-review-revisions-"));
    directories.push(root);
    const storage = makeReviewStorageTestAdapter(root, join(root, "pi-sessions")).service;
    const revisions = await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* storage
          .changes()
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* storage.createDiscussion("/project", "session", codeAnchor);
        return yield* Fiber.join(observer);
      }),
    );

    expect([...revisions]).toEqual([0, 1]);
  });

  it.each(["diff", "full"] as const)(
    "migrates persisted %s review anchors to file anchors",
    async (view) => {
      const root = await mkdtemp(join(tmpdir(), "cake-review-migration-"));
      directories.push(root);
      const storage = makeReviewStorageTestAdapter(root, join(root, "pi-sessions")).service;
      const created = await Effect.runPromise(
        storage.createDiscussion("/project", "session", codeAnchor),
      );
      const recordPath = join(
        root,
        digestKey("/project"),
        digestKey("session"),
        `${digestKey(created.id)}.json`,
      );
      const persisted = JSON.parse(await readFile(recordPath, "utf8"));
      persisted.anchor.view = view;
      await writeFile(recordPath, `${JSON.stringify(persisted, null, 2)}\n`);

      const [migrated] = await Effect.runPromise(
        storage.listDiscussionRecords("/project", "session"),
      );

      expect(migrated?.anchor.view).toBe("file");
      expect(JSON.parse(await readFile(recordPath, "utf8")).anchor.view).toBe("file");
    },
  );

  it("persists anchors and sidecar references but projects replies from Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-discussions-"));
    directories.push(root);
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
    const storage = makeReviewStorageTestAdapter(root, join(root, "pi-sessions"), async () => ({
      parts: projectedParts,
    })).service;
    const created = await Effect.runPromise(
      storage.createDiscussion("/project", "session", codeAnchor),
    );
    const linked = await Effect.runPromise(
      storage.linkDiscussionSidecar("/project", "session", created.id, {
        sessionId: "pi-discussion",
        sessionFile: "/reviews/pi-discussion.jsonl",
      }),
    );

    expect(linked).toMatchObject({
      agentSessionId: "pi-discussion",
      agentSessionFile: "/reviews/pi-discussion.jsonl",
      pendingComments: [],
    });
    const [projected] = await Effect.runPromise(storage.listSession("/project", "session"));
    expect(projected?.parts).toEqual(projectedParts);

    const recordPath = join(
      root,
      digestKey("/project"),
      digestKey("session"),
      `${digestKey(created.id)}.json`,
    );
    const persisted = JSON.parse(await readFile(recordPath, "utf8"));
    expect(persisted).not.toHaveProperty("parts");
    expect(persisted.pendingComments).toEqual([]);
  });

  it("refreshes the parent index and resolves Discussion anchors", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-message-comments-"));
    directories.push(root);
    const live = makeReviewStorageTestAdapter(root, join(root, "pi-sessions"));
    const storage = live.service;
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
    const created = await Effect.runPromise(storage.createDiscussion("/project", "parent", anchor));
    await Effect.runPromise(storage.resolve("/project", "parent", created.id, true));
    await Effect.runPromise(storage.refreshDiscussionContext("/project", "parent"));

    const context = await readFile(live.paths.reviewContextPath("/project", "parent"), "utf8");
    expect(context).toContain("important");
    expect(context).toContain(`${created.id} · resolved`);

    await Effect.runPromise(storage.deleteSession("/project", "parent"));
    expect(await Effect.runPromise(storage.listDiscussionRecords("/project", "parent"))).toEqual(
      [],
    );
  });
});

function digestKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
