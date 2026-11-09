import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
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

test("hidden Side Chats stay cold at startup; opening and reentering hydrates only the requested transcript", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-demand-startup-"));
  const home = join(directory, "home");
  const cakeHome = join(directory, "cake");
  const userData = join(directory, "user-data");
  const database = join(cakeHome, "pi", "global-chat", "coordinator.sqlite");
  const reviews = join(cakeHome, "state", "reviews", digest(home), digest(CAKE_CHAT_SESSION_ID));
  const timestamp = new Date(0).toISOString();
  await Promise.all(
    [home, userData, join(cakeHome, "pi", "global-chat"), reviews].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  // Seed native Durable forks through their persistence authority, without model/network calls.
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const sidecarIds: string[] = [];
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const at = await root.commit(
      (tx) =>
        tx.appendEntry(root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "Selected conversation is ready", timestamp: 1 }],
        }),
      BACKGROUND_CONTEXT,
    );
    for (let index = 0; index < 15; index += 1) {
      const fork = await root.fork(at.id, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
      await fork.commit(
        (tx) =>
          tx.appendEntry(fork.id, {
            kind: "pi.user",
            model: [{ role: "user", content: `Original hidden transcript ${index}`, timestamp: 2 }],
          }),
        BACKGROUND_CONTEXT,
      );
      const id = `hidden-thread-${index}`;
      const sessionId = cakeChatSideChatSessionId(fork.id);
      sidecarIds.push(sessionId);
      await writeFile(
        join(reviews, `${digest(id)}.json`),
        JSON.stringify({
          id,
          title: `Hidden Side Chat ${index}`,
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
          agentSessionId: sessionId,
          pendingComments: [],
          status: "open",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
  const baseline = process.env.CAKE_DEMAND_BASELINE === "1";
  const label = baseline ? "before" : "after";
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
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByText("Selected conversation is ready", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Side chats, 15 open", exact: true }).click();
    await expect(page.getByText("Hidden Side Chat 14", { exact: true })).toBeVisible();
    const runtimeCount = () =>
      output
        .split(/\r?\n/)
        .filter(
          (line) =>
            line.includes("session-runtime-construct") &&
            line.includes("completed") &&
            sidecarIds.some((id) => line.includes(id)),
        ).length;
    // Measurement mode is only for the named pre-change source; normal regression checks require zero.
    if (baseline) await expect.poll(runtimeCount).toBe(15);
    else expect(runtimeCount()).toBe(0);
    const startupRuntimeCount = runtimeCount();
    const marks = await page.evaluate(() =>
      performance
        .getEntriesByType("mark")
        .filter((mark) => mark.name.startsWith("cake.startup."))
        .map((mark) => ({ phase: mark.name, rendererElapsedMs: mark.startTime })),
    );
    await page.getByText("Hidden Side Chat 7", { exact: true }).click();
    await expect(page.getByText("Original hidden transcript 7", { exact: true })).toBeVisible();
    if (!baseline) await expect.poll(runtimeCount).toBe(1);
    await mkdir(join(repository, ".visual-captures"), { recursive: true });
    await page.screenshot({
      path: join(repository, ".visual-captures", `side-chat-startup-${label}.png`),
    });
    console.log(
      JSON.stringify({
        source: process.env.CAKE_DEMAND_SOURCE ?? "working-tree",
        baseline,
        startupRuntimeCount,
        afterOpeningRuntimeCount: runtimeCount(),
        marks,
      }),
    );
    await page.getByRole("button", { name: "Close side chat", exact: true }).click();
    await expect(page.getByText("Original hidden transcript 7", { exact: true })).not.toBeVisible();
    await page.getByRole("button", { name: "Side chats, 15 open", exact: true }).click();
    await page.getByText("Hidden Side Chat 7", { exact: true }).click();
    await expect(page.getByText("Original hidden transcript 7", { exact: true })).toBeVisible();
    if (!baseline) expect(runtimeCount()).toBeLessThanOrEqual(2);
  } finally {
    await mkdir(join(repository, ".visual-captures"), { recursive: true });
    await writeFile(join(repository, ".visual-captures", `side-chat-startup-${label}.log`), output);
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
