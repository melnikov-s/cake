import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("does not mount collapsed work-log activity until it is expanded", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-work-log-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "work-log-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const oldSource = Array.from(
    { length: 80 },
    (_, index) => `export const old${index} = ${index};${index === 0 ? "x".repeat(180) : ""}`,
  ).join("\n");
  const newSource = Array.from(
    { length: 80 },
    (_, index) => `export const current${index} = ${index};${index === 0 ? "y".repeat(180) : ""}`,
  ).join("\n");

  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
      draftsBySession: {},
    }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Read the project" }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "assistant-tools",
        parentId: "user-1",
        timestamp,
        message: {
          role: "assistant",
          content: [
            ...Array.from({ length: 16 }, (_, index) => ({
              type: "toolCall",
              id: `read-${index}`,
              name: "read",
              arguments: { path: `src/file-${index}.ts` },
            })),
            {
              type: "toolCall",
              id: "call-1",
              name: "edit",
              arguments: {
                path: "src/app.ts",
                edits: [{ oldText: oldSource, newText: newSource }],
              },
            },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "tool-result",
        parentId: "assistant-tools",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "edit",
          content: [{ type: "text", text: "Successfully replaced text in src/app.ts" }],
          isError: false,
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "assistant-final",
        parentId: "tool-result",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The project is readable." }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 3,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );

  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
    },
  });

  try {
    const page = await application.firstWindow();
    const log = page.locator('[data-slot="activity-group"]');
    await expect(log).toHaveCount(1, { timeout: 20_000 });
    await expect(log.locator(":scope > div")).toHaveCount(0);
    await expect(log.locator('[data-slot="tool"]')).toHaveCount(0);

    await log.locator(":scope > summary").click();
    await expect(log).toHaveAttribute("open", "");

    const content = log.locator('[data-slot="work-log-content"]');
    const diffScroll = content.locator('[data-slot="work-log-diff-scroll"]');
    const activityToggle = content.getByRole("button", { name: /View steps/ });
    const fileHeader = diffScroll.locator('[aria-label^="File changes to"] > header');
    await expect(activityToggle).toBeVisible();
    await expect(fileHeader).toBeVisible();
    await expect
      .poll(() =>
        diffScroll.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);

    // The diff header pins inside its own viewport. The outer chat can still
    // be completing its own initial bottom alignment.
    const expectPinnedDiffHeader = () =>
      expect
        .poll(() =>
          diffScroll.evaluate((element) => {
            const header = element
              .querySelector('[aria-label^="File changes to"] > header')!
              .getBoundingClientRect();
            return Math.abs(header.top - element.getBoundingClientRect().top);
          }),
        )
        .toBeLessThanOrEqual(1);
    await expectPinnedDiffHeader();

    // Wide code scrolls within this file only. The work-log viewport and the
    // file header remain fitted to the transcript width.
    const codeScroll = diffScroll.getByRole("table", { name: "Code changes" });
    await expect
      .poll(() => codeScroll.evaluate((element) => element.scrollWidth > element.clientWidth))
      .toBe(true);
    expect(
      await diffScroll.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
    const headerLeft = await fileHeader.evaluate((element) => element.getBoundingClientRect().left);
    await codeScroll.evaluate((element) => element.scrollTo({ left: 120 }));
    await expect
      .poll(() => codeScroll.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    expect(await fileHeader.evaluate((element) => element.getBoundingClientRect().left)).toBe(
      headerLeft,
    );
    expect(await fileHeader.getByText("src/app.ts").isVisible()).toBe(true);

    await diffScroll.evaluate((element) => element.scrollTo({ top: 100 }));
    await expectPinnedDiffHeader();
    const diffScrollTop = await diffScroll.evaluate((element) => element.scrollTop);
    expect(diffScrollTop).toBeGreaterThan(0);

    await activityToggle.click();
    const activityScroll = content.locator('[data-slot="work-log-scroll"]');
    await expect.poll(() => log.locator('[data-slot="tool"]').count()).toBeGreaterThan(0);
    await expect
      .poll(() =>
        activityScroll.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    await expect(activityScroll).toContainText("src/app.ts");
    expect(await diffScroll.evaluate((element) => element.scrollTop)).toBe(diffScrollTop);

    await activityScroll.evaluate((element) => element.scrollTo({ top: 0 }));
    await expect.poll(() => activityScroll.evaluate((element) => element.scrollTop)).toBe(0);
    await content.getByRole("button", { name: /Hide steps/ }).click();
    await expect(log.locator('[data-slot="tool"]')).toHaveCount(0);
    expect(await diffScroll.evaluate((element) => element.scrollTop)).toBe(diffScrollTop);

    await content.getByRole("button", { name: /View steps/ }).click();
    await expect.poll(() => log.locator('[data-slot="tool"]').count()).toBeGreaterThan(0);
    await expect.poll(() => activityScroll.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await diffScroll.evaluate((element) => element.scrollTop)).toBe(diffScrollTop);

    await log.locator(":scope > summary").click();
    await expect(log).not.toHaveAttribute("open", "");
    await expect(log.locator(":scope > div")).toHaveCount(0);
    await expect(log.locator('[data-slot="tool"]')).toHaveCount(0);

    await page.keyboard.press("Control+o");
    await expect(log).toHaveAttribute("open", "");
    await expect.poll(() => log.locator('[data-slot="tool"]').count()).toBeGreaterThan(0);
    await expect(log.locator('[data-slot="tool"] [aria-expanded="true"]')).toHaveCount(0);
    await expect(log.locator('[data-slot="tool-details"]').first()).toBeHidden();

    await page.keyboard.press("Control+o");
    await expect(log).toHaveAttribute("open", "");
    await expect
      .poll(async () => {
        const tools = await log.locator('[data-slot="tool"]').count();
        const expanded = await log.locator('[data-slot="tool"] [aria-expanded="true"]').count();
        return tools > 0 && expanded === tools;
      })
      .toBe(true);
    await activityScroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await expect(log.locator('[data-slot="tool-details"]').last()).toContainText(
      "Successfully replaced text in src/app.ts",
    );

    await page.keyboard.press("Control+o");
    await expect(log).not.toHaveAttribute("open", "");
    await expect(log.locator(":scope > div")).toHaveCount(0);

    await log.locator(":scope > summary").click();
    await expect(log).toHaveAttribute("open", "");
    await expect.poll(() => log.locator('[data-slot="tool"]').count()).toBeGreaterThan(0);
    await expect(log.locator('[data-slot="tool"] [aria-expanded="true"]')).toHaveCount(0);

    // Verify the top-right work-log display menu.
    await page.getByRole("button", { name: "Work log display options" }).click();
    const controls = page.getByRole("dialog");
    await expect(controls).toBeVisible();
    const autoBtn = controls.getByRole("button", { name: "Auto view mode" });
    const diffBtn = controls.getByRole("button", { name: "Diff view mode" });
    const logBtn = controls.getByRole("button", { name: "Log view mode" });
    const collapseBtn = controls.getByRole("button", { name: "Collapsed work logs" });
    const compactBtn = controls.getByRole("button", { name: "Compact work logs" });
    const fullBtn = controls.getByRole("button", { name: "Full work logs" });

    await expect(autoBtn).toHaveAttribute("aria-pressed", "true");
    await expect(collapseBtn).toHaveAttribute("aria-pressed", "true");
    await expect(compactBtn).toHaveAttribute("aria-pressed", "false");

    await fullBtn.click();
    await expect
      .poll(async () => {
        const tools = await log.locator('[data-slot="tool"]').count();
        const expanded = await log.locator('[data-slot="tool"] [aria-expanded="true"]').count();
        return tools > 0 && expanded === tools;
      })
      .toBe(true);
    await expect(fullBtn).toHaveAttribute("aria-pressed", "true");

    await collapseBtn.click();
    await expect(log).not.toHaveAttribute("open", "");
    await expect(collapseBtn).toHaveAttribute("aria-pressed", "true");

    // Cycle view mode via shortcut Control+Shift+O
    await page.keyboard.press("Control+Shift+O");
    await expect(diffBtn).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Control+Shift+O");
    await expect(logBtn).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Control+Shift+O");
    await expect(autoBtn).toHaveAttribute("aria-pressed", "true");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
