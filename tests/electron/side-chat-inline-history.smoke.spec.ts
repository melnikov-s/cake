import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, type EntryId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-durable-ai";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatSessionId,
} from "../../src/contracts/cake-chats/cake-chat-identity";

const repository = resolve(import.meta.dirname, "../..");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

for (const localCount of [1, 230]) {
  test(`Side Chat preloads inline originals and anchors upward pagination (${localCount} local turns)`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), "cake-inline-history-"));
    const home = join(directory, "home");
    const cakeHome = join(directory, "cake");
    const userData = join(directory, "user-data");
    const database = join(cakeHome, "pi", "global-chat", "coordinator.sqlite");
    const reviews = join(cakeHome, "state", "reviews", digest(home), digest(CAKE_CHAT_SESSION_ID));
    await Promise.all(
      [home, userData, join(cakeHome, "pi", "global-chat"), reviews].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    const harness = await Harness.open(
      await openNodeSqliteStorage(database),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      let at: EntryId | undefined;
      for (let index = 0; index < 650; index++) {
        const entry = await root.commit(
          (tx) =>
            tx.appendEntry(root.id, {
              kind: "pi.user",
              model: [{ role: "user", content: `Parent original ${index}`, timestamp: index + 1 }],
            }),
          BACKGROUND_CONTEXT,
        );
        at = entry.id;
      }
      if (at === undefined) throw new Error("Missing fork point");
      const fork = await root.fork(at, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
      await root.commit(
        (tx) =>
          tx.appendEntry(root.id, {
            kind: "pi.user",
            model: [{ role: "user", content: "LATER PARENT MUST NOT LEAK", timestamp: 900 }],
          }),
        BACKGROUND_CONTEXT,
      );
      for (let index = 0; index < localCount; index++)
        await fork.commit(
          (tx) =>
            tx.appendEntry(fork.id, {
              kind: "pi.user",
              model: [{ role: "user", content: `Side original ${index}`, timestamp: 1000 + index }],
            }),
          BACKGROUND_CONTEXT,
        );
      const id = "inline-history-thread";
      await writeFile(
        join(reviews, `${digest(id)}.json`),
        JSON.stringify({
          id,
          title: "History investigation",
          workspacePath: home,
          sessionId: CAKE_CHAT_SESSION_ID,
          anchor: {
            path: `session:${CAKE_CHAT_SESSION_ID}`,
            view: "session",
            start: { diffLine: 0 },
            end: { diffLine: 0 },
            selectedText: "",
            contextBefore: "",
            contextAfter: "",
            diff: "",
          },
          agentSessionId: cakeChatSideChatSessionId(fork.id),
          pendingComments: [],
          status: "open",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }),
      );
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
    const app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        HOME: home,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: cakeHome,
        CAKE_ELECTRON_USER_DATA: userData,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    let output = "";
    app.process().stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    app.process().stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("button", { name: "Side chats, 1 open", exact: true }).click();
      await page.getByText("History investigation", { exact: true }).click();
      const panel = page.getByRole("complementary", { name: "History investigation", exact: true });
      await expect(
        panel.getByText(`Side original ${localCount - 1}`, { exact: true }),
      ).toBeVisible();
      const transcript = panel.locator(".transcript");
      await expect(panel.getByRole("button", { name: "Original history" })).toHaveCount(0);
      if (localCount === 1) {
        await expect(panel.locator('[data-slot="history-divider"]')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("inline-preloaded-divider.png") });
      }
      // Use real reader input: changing scrollTop behind LegendList's active
      // measurement anchor can intentionally be ignored as a stale native event.
      await transcript.hover({ position: { x: 20, y: 200 } });
      let pages = 0;
      let reachedEnd = false;
      for (let step = 0; step < 240; step++) {
        const before = await transcript.evaluate((element) => {
          const top = element.getBoundingClientRect().top;
          const row = [...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]")]
            .filter((row) => row.getBoundingClientRect().bottom > top + 1)
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
          return {
            scrollTop: element.scrollTop,
            id: row?.dataset.transcriptAnchorId,
            y: row?.getBoundingClientRect().y,
          };
        });
        if (
          before.scrollTop <= 1 &&
          (await panel.getByText("Earlier messages", { exact: true }).count()) === 0
        ) {
          reachedEnd = true;
          break;
        }
        const nearStart = before.scrollTop < 1500;
        await page.mouse.wheel(0, nearStart ? -120 : -1200);
        const samples = await transcript.evaluate(async (element, id) => {
          const samples = [];
          for (let frame = 0; frame < 6; frame++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const row = [
              ...element.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]"),
            ].find((row) => row.dataset.transcriptAnchorId === id);
            samples.push({ scrollTop: element.scrollTop, y: row?.getBoundingClientRect().y });
          }
          return samples;
        }, before.id);
        if (nearStart) {
          expect(before.y).toBeDefined();
          for (const sample of samples) {
            expect(sample.y, JSON.stringify({ step, before, samples })).toBeDefined();
            const delta = sample.y! - before.y!;
            expect(delta).toBeGreaterThanOrEqual(-3);
            expect(delta).toBeLessThanOrEqual(123);
          }
        }
        await expect(
          panel.getByRole("button", { name: "Retry loading earlier messages" }),
        ).toHaveCount(0);
        const after = samples.at(-1)!;
        if (nearStart && after.scrollTop > before.scrollTop + 1000) {
          console.log(JSON.stringify({ localCount, page: ++pages, before, after }));
          await page.screenshot({ path: testInfo.outputPath(`upward-page-${pages}.png`) });
        }
      }
      expect(reachedEnd).toBe(true);
      expect(pages).toBeGreaterThanOrEqual(localCount === 1 ? 3 : 4);
      await expect(panel.getByText("Parent original 0", { exact: true })).toBeVisible();
      await expect(panel.getByText("Earlier messages", { exact: true })).toHaveCount(0);
      await expect(panel.getByText("LATER PARENT MUST NOT LEAK", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Close side chat", exact: true }).click();
      await expect(panel).toHaveCount(0);
    } catch (error) {
      const page = await app.firstWindow();
      await page.screenshot({ path: testInfo.outputPath("failure.png") });
      await writeFile(
        testInfo.outputPath("failure-dom.txt"),
        await page.locator("body").innerText(),
      );
      throw error;
    } finally {
      await writeFile(testInfo.outputPath("app.log"), output);
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
