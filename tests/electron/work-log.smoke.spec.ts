import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

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
    windowState({ project, sessionId, theme: "dark" }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });

  try {
    const page = await application.firstWindow();
    // Select explicitly: legacy window-state navigation is no longer an active selection.
    await page.getByRole("button", { name: "Search sessions", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Search sessions", exact: true })
      .locator(`[data-session-id="${sessionId}"]`)
      .click();
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

    // The restored two-icon control sits immediately after Terminal.
    const trigger = page.getByRole("button", { name: "Work log display options", exact: true });
    const terminalBounds = await page
      .getByRole("button", { name: "Terminal", exact: true })
      .boundingBox();
    const triggerBounds = await trigger.boundingBox();
    expect(terminalBounds).not.toBeNull();
    expect(triggerBounds).not.toBeNull();
    expect(triggerBounds!.x).toBeGreaterThanOrEqual(terminalBounds!.x + terminalBounds!.width);
    expect(Math.abs(triggerBounds!.y - terminalBounds!.y)).toBeLessThanOrEqual(1);
    const openOptions = async () => {
      await trigger.focus();
      await page.keyboard.press("Enter");
      const controls = page.getByRole("dialog", { name: "Work log display options" });
      await expect(controls).toBeVisible();
      await expect(controls.getByRole("button", { name: "Auto view mode" })).toBeFocused();
      return controls;
    };
    const closeOptions = async () => {
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
    };
    let controls = await openOptions();
    await expect(controls.getByRole("button", { name: "Auto view mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(controls.getByRole("button", { name: "Collapsed work logs" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await controls.getByRole("button", { name: "Full work logs" }).click();
    await closeOptions();
    await expect(log).toHaveAttribute("open", "");
    await expect
      .poll(async () => {
        const tools = await log.locator('[data-slot="tool"]').count();
        const expanded = await log.locator('[data-slot="tool"] [aria-expanded="true"]').count();
        return tools > 0 && expanded === tools;
      })
      .toBe(true);

    controls = await openOptions();
    await expect(controls.getByRole("button", { name: "Full work logs" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await controls.getByRole("button", { name: "Collapsed work logs" }).click();
    await closeOptions();
    await expect(log).not.toHaveAttribute("open", "");

    // Existing shortcuts continue to update the same saved settings.
    for (const label of ["Diff view mode", "Log view mode", "Auto view mode"]) {
      await page.keyboard.press("Control+Shift+O");
      controls = await openOptions();
      await expect(controls.getByRole("button", { name: label })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await closeOptions();
    }
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
