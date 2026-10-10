import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("Pi Durable's Node SQLite adapter persists and reopens inside hidden Electron main", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-durable-electron-"));
  const repository = resolve(import.meta.dirname, "../..");
  const app = await electron.launch({
    args: [repository],
    cwd: repository,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_HOME: join(directory, "cake"),
      CAKE_ELECTRON_USER_DATA: join(directory, "user-data"),
    },
  });
  try {
    await app.firstWindow();
    const result = await app.evaluate(
      async (_electron, { storageUrl, durableUrl, modelsUrl, contextUrl, file }) => {
        // Playwright's evaluated function has no dynamic-import callback. Node's
        // require(ESM) loads these import-only packages by their resolved filenames.
        const { createRequire } = process.getBuiltinModule("node:module");
        const { fileURLToPath } = process.getBuiltinModule("node:url");
        const require = createRequire(file);
        const { openNodeSqliteStorage } = require(fileURLToPath(storageUrl));
        const { Harness, createRegistry } = require(fileURLToPath(durableUrl));
        const { createModels } = require(fileURLToPath(modelsUrl));
        const { BACKGROUND_CONTEXT: context } = require(fileURLToPath(contextUrl));
        const options = { models: createModels(), registry: createRegistry() };
        let harness = await Harness.open(await openNodeSqliteStorage(file), options, context);
        let root = await harness.root(context);
        await root.commit(
          (tx) =>
            tx.appendEntry(root.id, {
              kind: "pi.user",
              model: [{ role: "user", content: "Electron persistence proof", timestamp: 1 }],
            }),
          context,
        );
        await harness.close(context);
        harness = await Harness.open(await openNodeSqliteStorage(file), options, context);
        root = await harness.root(context);
        const page = await root.entries({}, 10, undefined, context);
        const messages = page.items
          .flatMap((entry: { model?: { content: string }[] }) => entry.model ?? [])
          .map((message: { content: string }) => message.content);
        await harness.close(context);
        return messages;
      },
      {
        storageUrl: import.meta.resolve("@earendil-works/pi-durable/storage/sqlite/node"),
        durableUrl: import.meta.resolve("@earendil-works/pi-durable"),
        modelsUrl: import.meta.resolve("@earendil-works/pi-durable-ai"),
        contextUrl: import.meta.resolve("@earendil-works/chord/context"),
        file: join(directory, "coordinator.sqlite"),
      },
    );
    expect(result).toEqual(["Electron persistence proof"]);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
