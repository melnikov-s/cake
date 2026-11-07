import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const launchNavigation = (paths: { cakeHome: string; userData: string }) =>
  electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: paths.userData,
      CAKE_HOME: paths.cakeHome,
      PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });

async function expectComposerControlsFit(input: Locator) {
  await expect
    .poll(() =>
      input.evaluate((element) => {
        const form = element.closest("form")!;
        const bounds = form.getBoundingClientRect();
        const buttons = [
          ...form.querySelectorAll<HTMLButtonElement>('[data-slot="composer-toolbar"] button'),
        ].filter((button) => button.getBoundingClientRect().width > 0);
        const outside: string[] = [];
        const covered: string[] = [];
        const overlapping: string[] = [];
        for (const [index, button] of buttons.entries()) {
          const rect = button.getBoundingClientRect();
          const name = button.getAttribute("aria-label") ?? button.textContent ?? "button";
          if (
            rect.left < bounds.left - 1 ||
            rect.right > bounds.right + 1 ||
            rect.top < bounds.top - 1 ||
            rect.bottom > bounds.bottom + 1
          )
            outside.push(name);
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          if (hit !== button && !button.contains(hit)) covered.push(name);
          for (const other of buttons.slice(index + 1)) {
            const next = other.getBoundingClientRect();
            if (
              Math.min(rect.right, next.right) - Math.max(rect.left, next.left) > 1 &&
              Math.min(rect.bottom, next.bottom) - Math.max(rect.top, next.top) > 1
            )
              overlapping.push(name);
          }
        }
        return { outside, covered, overlapping };
      }),
    )
    .toEqual({ outside: [], covered: [], overlapping: [] });
}

test("project home and native Browser keep conversation drafts, companion identity and To-do context", async () => {
  test.setTimeout(120_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-chat-first-navigation-"));
  const paths = {
    cakeHome: join(temporary, "cake-home"),
    project: join(temporary, "project"),
    userData: join(temporary, "user-data"),
  };
  const scenario = findVisualCaptureScenario("chat-first-navigation")!;
  const cleanup = await scenario.seed(paths, "dark");
  const application = await launchNavigation(paths);
  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 900),
    );
    await scenario.prepare(page, "project-todos", application);
    const homeDraft = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
    await homeDraft.click();
    await expect(homeDraft).toBeFocused();
    await homeDraft.pressSequentially("Keep the Project Chat draft");
    await expect(homeDraft).toHaveValue("Keep the Project Chat draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expectComposerControlsFit(homeDraft);

    await scenario.prepare(page, "browser", application);
    const workerDraft = page.getByRole("combobox", { name: "Message", exact: true });
    await workerDraft.click();
    await expect(workerDraft).toBeFocused();
    await workerDraft.pressSequentially("Keep the worker conversation draft");
    await expect(workerDraft).toHaveValue("Keep the worker conversation draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expectComposerControlsFit(workerDraft);
    await page.getByRole("button", { name: /^Side chats/ }).click();
    await page
      .getByRole("dialog", { name: "Open side chats" })
      .getByRole("button", { name: "Selection-path audit", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Browser workspace", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Reply to side chat", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close Side chat", exact: true }).click();
    await expect(workerDraft).toHaveValue("Keep the worker conversation draft");
    await page.getByRole("button", { name: "Model configuration", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Model configuration", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Close chat", exact: true }).click();
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await expect(workerDraft).toHaveValue("Keep the worker conversation draft");
    await expect(page.getByRole("navigation", { name: "Conversation breadcrumb" })).toContainText(
      "Keyboard Editing & Navigation",
    );

    const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
    await workspace.getByRole("button", { name: /^To-dos / }).click();
    await workspace
      .getByRole("button", { name: "Review conversation navigation", exact: true })
      .click();
    await workspace
      .getByRole("button", {
        name: "Attach to-do as context: Review conversation navigation",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Remove To-do · Review conversation navigation",
        exact: true,
      }),
    ).toBeVisible();
    await expect(workerDraft).toHaveValue("Keep the worker conversation draft");
    await page.getByRole("button", { name: "Back to agent", exact: true }).click();
    await expect(workerDraft).toHaveValue("Keep the worker conversation draft");
    await expect(
      page.getByRole("button", {
        name: "Remove To-do · Review conversation navigation",
        exact: true,
      }),
    ).toBeVisible();

    await scenario.prepare(page, "side-chat", application);
    const discussionBody = page.getByText(
      "The selection-path audit discussion stays focused here, with its original parent in the breadcrumb.",
      { exact: true },
    );
    await expect(discussionBody).toBeVisible();
    const discussionDraft = page.getByRole("combobox", { name: "Reply to side chat", exact: true });
    await discussionDraft.click();
    await expect(discussionDraft).toBeFocused();
    await discussionDraft.pressSequentially("Keep the discussion draft");
    await expect(discussionDraft).toHaveValue("Keep the discussion draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page
      .getByRole("navigation", { name: "Conversation breadcrumb" })
      .getByRole("button", { name: "Focus restoration", exact: true })
      .click();
    await expect(workerDraft).toHaveValue("Keep the worker conversation draft");
    await page.getByRole("button", { name: /^Side chats/ }).click();
    await page
      .getByRole("dialog", { name: "Open side chats" })
      .getByRole("button", { name: "Selection-path audit", exact: true })
      .click();
    await expect(discussionBody).toBeVisible();
    await expect(discussionDraft).toHaveValue("Keep the discussion draft");
    await page
      .getByRole("navigation", { name: "Conversation breadcrumb" })
      .getByRole("button", { name: "Focus restoration", exact: true })
      .click();
    await expect(workerDraft).toHaveValue("Keep the worker conversation draft");
    await expectComposerControlsFit(workerDraft);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(workerDraft).toHaveValue("");
    await expect(
      page.getByText("Keep the worker conversation draft", { exact: true }),
    ).toBeVisible();

    const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
    await rail.getByRole("button", { name: "Open Project Chat for cake", exact: true }).click();
    await expect(homeDraft).toHaveValue("Keep the Project Chat draft");
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Close Workspace", exact: true }).click();
    await expect(rail.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(rail.getByRole("button", { name: "Automations", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Workspace", exact: true })).toBeVisible();
    const windows = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
      })),
    );
    expect(windows.every((window) => !window.visible && !window.focused)).toBe(true);
  } finally {
    await application.close();
    if (typeof cleanup === "function") await cleanup();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Discussion-owned subagent launches through supported controls and its released history cold-browses without restart", async () => {
  test.setTimeout(180_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-discussion-worker-"));
  const paths = {
    cakeHome: join(temporary, "cake-home"),
    project: join(temporary, "project"),
    userData: join(temporary, "user-data"),
  };
  const scenario = findVisualCaptureScenario("chat-first-navigation")!;
  const cleanup = await scenario.seed(paths, "dark");
  let application = await launchNavigation(paths);
  try {
    let page = await application.firstWindow();
    // The maintained state submits real Discussion tool calls and validates committed public
    // parent identity before/after subagents.close; no synthetic nested launch metadata.
    await scenario.prepare(page, "discussion-worker", application);
    await expect(page.getByText(/Nested review complete\./)).toBeVisible();
    await application.close();
    application = await launchNavigation(paths);
    page = await application.firstWindow();
    await scenario.prepare(page, "sessions", application);
    const tree = page.getByRole("region", { name: "Sessions", exact: true });
    await tree.getByRole("button", { name: /^Focus restoration(?: |$)/ }).click();
    await page.getByRole("button", { name: /^Side chats/ }).click();
    await page
      .getByRole("dialog", { name: "Open side chats" })
      .getByRole("button", { name: "Selection-path audit", exact: true })
      .click();
    const discussion = page.getByRole("complementary", { name: "Side chat", exact: true });
    await discussion.getByRole("button", { name: /^Side chats and subagents,/ }).click();
    const menu = page.getByRole("dialog", { name: "Open side chats" });
    await expect(
      menu.getByRole("button", { name: "Nested discussion review", exact: true }),
    ).toContainText("Resources released");
    await menu.getByRole("button", { name: "Nested discussion review", exact: true }).click();
    await expect(page.getByText(/Nested review complete\./)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("navigation", { name: "Conversation breadcrumb" })).toContainText(
      "Selection-path audit",
    );
    const directory = join(paths.cakeHome, "state", "private-workers");
    const active = await Promise.all(
      (await readdir(directory))
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const record: { data: { task: string } } = JSON.parse(
            await readFile(join(directory, file), "utf8"),
          );
          return record.data.task;
        }),
    );
    expect(active).not.toContain("Nested discussion review");
  } finally {
    await application.close().catch(() => undefined);
    if (typeof cleanup === "function") await cleanup();
    await rm(temporary, { recursive: true, force: true });
  }
});
