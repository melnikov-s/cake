import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import { durableInputText } from "../../../../src/services/pi-durable/durable-input-presentation";
import {
  setDurableUserMessageMarkdown,
  UserMessagePresentationDoc,
} from "../../../../src/services/pi-durable/durable-message-presentation";
import { durableModels } from "../../../fixtures/durable-chat";
import { researchMarkdown, researchOrigin } from "../../../fixtures/subagent-report";

const context = BACKGROUND_CONTEXT;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture(database?: string) {
  if (!database) {
    const directory = await mkdtemp(join(tmpdir(), "cake-message-presentation-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    database = join(directory, "chat.sqlite");
  }
  const storage = await openNodeSqliteStorage(database);
  const harness = await Harness.open(
    storage,
    { models: durableModels().models, registry: createRegistry() },
    context,
  );
  cleanup.push(() => harness.close(context));
  const root = await harness.root(context, {
    agent: { model: { provider: "fixture", modelId: "fixture" } },
  });
  const send = async (text: string, markdown: boolean, report = false) => {
    const submission = await root.submit(
      {
        type: "input",
        content: durableInputText(text, [], markdown, false, report ? researchOrigin : undefined),
      },
      context,
    );
    const settled = await submission.wait(context);
    if (settled.status !== "done" || settled.type !== "input") throw new Error("Input failed");
    return settled;
  };
  const history = (conversation: Conversation = root) =>
    conversation.commit(
      async (tx) =>
        readDurableOriginalPage(
          {
            entries: (query, limit, cursor) =>
              tx.scanEntries({ ...query, conversationId: conversation.id }, limit, cursor),
          },
          undefined,
          undefined,
          (await tx.doc(UserMessagePresentationDoc, conversation.id)).overrides,
        ),
      context,
    );
  return { database, storage, harness, root, send, history };
}

it("preserves delegated provenance and exact SDK originals/context across both display switches and SQLite reopen", async () => {
  const f = await fixture();
  const settled = await f.send(researchMarkdown, true, true);
  const before = await f.history();
  const report = before.parts.find((part) => part.kind === "text" && part.subagentReport);
  if (report?.kind !== "text" || !report.entryId) throw new Error("Missing report");
  const originals = await f.root.entries({}, 200, undefined, context);
  const modelContext = await f.root.context(context);
  await setDurableUserMessageMarkdown(f.root, report.entryId, false);
  expect((await f.history()).parts).toContainEqual({ ...report, renderAs: undefined });
  expect(await f.root.entries({}, 200, undefined, context)).toEqual(originals);
  expect(await f.root.context(context)).toEqual(modelContext);
  await f.harness.close(context);
  const reopened = await fixture(f.database);
  expect((await reopened.history()).parts).toContainEqual({ ...report, renderAs: undefined });
  await setDurableUserMessageMarkdown(reopened.root, report.entryId, true);
  expect((await reopened.history()).parts).toEqual(before.parts);
  await expect(
    setDurableUserMessageMarkdown(reopened.root, String(settled.answer), false),
  ).rejects.toThrow("not in the active conversation");
  await expect(setDurableUserMessageMarkdown(reopened.root, "not-an-entry", true)).rejects.toThrow(
    "not in the active conversation",
  );
});

it("surfaces a genuine SDK storage write failure, keeps originals/preferences atomic, and permits retry after reopen", async () => {
  const f = await fixture();
  await f.send("# Keep original", true);
  const before = await f.history();
  const user = before.parts.find((part) => part.kind === "text" && part.role === "user");
  if (user?.kind !== "text" || !user.entryId) throw new Error("Missing original");
  const originals = await f.root.entries({}, 200, undefined, context);
  vi.spyOn(f.storage, "commit").mockRejectedValueOnce(new Error("Formatting disk write failed"));
  await expect(setDurableUserMessageMarkdown(f.root, user.entryId, false)).rejects.toThrow(
    "Formatting disk write failed",
  );
  // Storage errors close the SDK Harness; production recovery, like this test, must reopen it.
  expect(await f.harness.closed).toMatchObject({ reason: "failed" });
  const reopened = await fixture(f.database);
  expect((await reopened.history()).parts).toEqual(before.parts);
  expect(await reopened.root.entries({}, 200, undefined, context)).toEqual(originals);
  await setDurableUserMessageMarkdown(reopened.root, user.entryId, false);
  expect((await reopened.history()).parts).toContainEqual({ ...user, renderAs: undefined });
});
