import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-durable-ai";

/** Seed the coordinator's real persistence authority without invoking a model. */
export async function seedCakeChatHistory(cakeHome: string, text: string) {
  const database = join(cakeHome, "pi", "global-chat", "coordinator.sqlite");
  await mkdir(dirname(database), { recursive: true });
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    await root.commit(
      (transaction) =>
        transaction.appendEntry(root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: text, timestamp: 1 }],
        }),
      BACKGROUND_CONTEXT,
    );
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}
