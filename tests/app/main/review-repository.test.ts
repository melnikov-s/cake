import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewRepository } from "../../../src/main/review-repository";

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

describe("ReviewRepository Discussion metadata", () => {
  it.each(["diff", "full"] as const)(
    "migrates persisted %s review anchors to file anchors",
    async (view) => {
      const root = await mkdtemp(join(tmpdir(), "cake-review-migration-"));
      directories.push(root);
      const repository = new ReviewRepository(root, join(root, "pi-sessions"));
      const created = await repository.createDiscussion("/project", "session", codeAnchor);
      const recordPath = join(
        root,
        digestKey("/project"),
        digestKey("session"),
        `${digestKey(created.id)}.json`,
      );
      const persisted = JSON.parse(await readFile(recordPath, "utf8"));
      persisted.anchor.view = view;
      await writeFile(recordPath, `${JSON.stringify(persisted, null, 2)}\n`);

      const [migrated] = await repository.listDiscussionRecords("/project", "session");

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
    const repository = new ReviewRepository(root, join(root, "pi-sessions"), async () => ({
      parts: projectedParts,
    }));
    const created = await repository.createDiscussion("/project", "session", codeAnchor);
    const linked = await repository.linkDiscussionSidecar("/project", "session", created.id, {
      sessionId: "pi-discussion",
      sessionFile: "/reviews/pi-discussion.jsonl",
    });

    expect(linked).toMatchObject({
      agentSessionId: "pi-discussion",
      agentSessionFile: "/reviews/pi-discussion.jsonl",
      pendingComments: [],
    });
    const [projected] = await repository.listSession("/project", "session");
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
    const repository = new ReviewRepository(root, join(root, "pi-sessions"));
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
    const created = await repository.createDiscussion("/project", "parent", anchor);
    await repository.resolve("/project", "parent", created.id, true);
    await repository.refreshDiscussionContext("/project", "parent");

    const context = await readFile(repository.reviewContextPath("/project", "parent"), "utf8");
    expect(context).toContain("important");
    expect(context).toContain(`${created.id} · resolved`);

    await repository.deleteSession("/project", "parent");
    expect(await repository.listDiscussionRecords("/project", "parent")).toEqual([]);
  });
});

function digestKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
