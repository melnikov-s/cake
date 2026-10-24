import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-durable-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { _electron as electron, expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

test("Project and global Cake Chat restore Pi-recorded ordinary tool timers after reload", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-tool-timers-"));
  const repository = resolve(import.meta.dirname, "../..");
  const paths = {
    cakeHome: join(root, "cake"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await findVisualCaptureScenario("assistant-markdown-code")!.seed(paths, "dark");
    const hash = createHash("sha256").update(paths.project).digest("hex");
    const calls = [
      {
        id: "parity",
        name: "cake",
        arguments: { command: "sessions.list", input: { query: "parity" } },
        durationMs: 32_021,
      },
      {
        id: "audit",
        name: "cake",
        arguments: { command: "sessions.list", input: { query: "audit" } },
        durationMs: 38_224,
      },
      { id: "zoom", name: "zoom", arguments: { id: 0, n: 1 }, durationMs: 5 },
    ];
    for (const directory of [
      join(paths.cakeHome, "pi", "global-chat"),
      join(paths.cakeHome, "pi", "project-chats", hash),
    ]) {
      await mkdir(directory, { recursive: true });
      const harness = await Harness.open(
        await openNodeSqliteStorage(join(directory, "coordinator.sqlite")),
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
      try {
        const conversation = await harness.root(BACKGROUND_CONTEXT);
        await conversation.commit(async (tx) => {
          await tx.appendEntry(conversation.id, {
            kind: "pi.assistant",
            model: [
              {
                role: "assistant",
                content: calls.map(({ id, name, arguments: args }) => ({
                  type: "toolCall",
                  id,
                  name,
                  arguments: args,
                })),
                api: "openai-completions",
                provider: "openai",
                model: "fixture",
                stopReason: "toolUse",
                timestamp: 1_000_000,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              },
            ],
          });
          for (const call of calls) {
            const message = {
              role: "toolResult" as const,
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text" as const, text: "Done" }],
              isError: false,
              timestamp: 1_080_000,
              durationMs: call.durationMs,
            };
            await tx.appendEntry(conversation.id, { kind: "pi.tool-result", model: [message] });
          }
        }, BACKGROUND_CONTEXT);
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
    }
    app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: paths.cakeHome,
        CAKE_ELECTRON_USER_DATA: paths.userData,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    const verify = async () => {
      const summary = page.getByText("Work log", { exact: true });
      await summary.click();
      for (const [index, elapsed] of ["32s", "38s", undefined].entries()) {
        const timer = page
          .locator(`[data-part-id="tool-${calls[index]!.id}"]`)
          .getByLabel("elapsed time");
        if (elapsed) await expect(timer).toHaveText(elapsed);
        else await expect(timer).toHaveCount(0);
      }
    };
    await verify();
    await page.reload();
    await verify();
    await page
      .locator(
        `[data-slot="project-header"][data-session-id="project-chat:${hash}"] [data-slot="project-label"]`,
      )
      .click();
    await verify();
    await page.reload();
    await verify();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
