import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, UserEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-durable-ai";
import { cakeChatSideChatSessionId } from "../../src/contracts/cake-chats/cake-chat-identity";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { store, windowStateDocument } from "./window-state";

export const sideChatTabTitles = [
  "Auto-merge Workflow Investigation",
  "User-authorized five-minute review",
  "Hide Show More When Messages Settle",
  "Project Chat Screenshot Layout Review",
  "Settled Overlay Follow-up Verification",
] as const;

export async function seedSideChatTabs(
  cakeHome: string,
  userData: string,
  project: string,
  theme: "dark" | "light",
  count: number = sideChatTabTitles.length,
) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const sessionId = `project-chat:${hash(project)}`;
  const timestamp = new Date(0).toISOString();
  const directory = join(cakeHome, "pi", "project-chats", hash(project));
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      version: 7,
      data: {
        ...defaultApplicationState(),
        projects: [
          { path: project, name: "Tab fixture", addedAt: timestamp, lastOpenedAt: timestamp },
        ],
      },
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    windowStateDocument({ settingsStore: store({}, { appearance: store({ theme }) }) }),
  );
  const storage = await openNodeSqliteStorage(join(directory, "coordinator.sqlite"));
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const entry = await root.commit(
      (tx) =>
        tx.appendEntry(UserEntry, root.id, {
          model: [{ role: "user", content: "A parent conversation", timestamp: 1 }],
        }),
      BACKGROUND_CONTEXT,
    );
    for (let index = 0; index < count; index++) {
      const fork = await root.fork(
        entry.id,
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT,
      );
      await fork.commit(
        (tx) =>
          tx.appendEntry(UserEntry, fork.id, {
            model: [{ role: "user", content: "A side conversation", timestamp: 2 }],
          }),
        BACKGROUND_CONTEXT,
      );
      const records = join(cakeHome, "state", "reviews", hash(project), hash(sessionId));
      await mkdir(records, { recursive: true });
      await writeFile(
        join(records, `${hash(`tab-side-chat-${index}`)}.json`),
        JSON.stringify({
          id: `tab-side-chat-${index}`,
          title: sideChatTabTitles[index],
          workspacePath: project,
          sessionId,
          agentSessionId: cakeChatSideChatSessionId(fork.id, sessionId),
          anchor: {
            path: `session:${sessionId}/message/${entry.id}`,
            view: "message",
            messageId: String(entry.id),
            entryId: String(entry.id),
            start: { diffLine: 0 },
            end: { diffLine: 0 },
            selectedText: "",
            contextBefore: "",
            contextAfter: "",
            diff: "",
          },
          pendingComments: [],
          status: "open",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);
  }
}
