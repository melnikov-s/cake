import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function chunk(delta: object, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "child-activity-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

test("background family children show running activity and only offer Mark as Unread when idle and read", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-child-activity-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  let childResponse: ServerResponse | undefined;
  let subagentResponse: ServerResponse | undefined;
  let subagentStarted = false;
  let firstRequest = true;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (data) => {
      body += data;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (firstRequest) {
        firstRequest = false;
        response.end(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "create-background-child",
                type: "function",
                function: {
                  name: "cake",
                  arguments: JSON.stringify({
                    command: "sessions.create-child",
                    input: { title: "Background worker", initialPrompt: "Child activity fixture" },
                  }),
                },
              },
            ],
          }) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
        );
      } else if (
        JSON.parse(body).messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("Subagent activity fixture"),
        )
      ) {
        subagentResponse = response;
        response.write(chunk({ content: "Inspecting shared UI components." }));
      } else if (
        !JSON.parse(body).messages.some((message: { role: string }) => message.role === "tool")
      ) {
        childResponse = response;
        response.write(chunk({ content: "Working on the child assignment." }));
      } else if (!subagentStarted) {
        subagentStarted = true;
        response.end(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "create-private-subagent",
                type: "function",
                function: {
                  name: "cake",
                  arguments: JSON.stringify({
                    command: "subagents.start",
                    input: { task: "Subagent activity fixture" },
                  }),
                },
              },
            ],
          }) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
        );
      } else {
        response.end(
          chunk({ content: "Child and subagent launched." }) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "activity-provider": {
          name: "Activity provider",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Activity fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "dark" }));
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [project],
    }),
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
    await page.getByRole("button", { name: "Model configuration" }).click({ timeout: 20_000 });
    await page.getByLabel("Search presets and models").fill("Activity fixture");
    await page
      .getByRole("button", { name: /Activity fixture/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await expect(composer).toBeFocused();
    await page.keyboard.type("Launch a background worker");
    await expect(composer).toHaveValue("Launch a background worker");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const parentId = await page
      .locator('[data-slot="session-pane"]')
      .getAttribute("data-session-id");
    await page.keyboard.press("Enter");
    await expect.poll(() => Boolean(childResponse)).toBe(true);
    const childRow = page
      .locator(`.session-item:not([data-session-id="${parentId}"])`)
      .filter({ hasText: "Background worker" });
    await expect(childRow).toHaveCount(1);
    await expect(childRow.locator('[aria-label="Running"]')).toBeVisible();
    await expect(page.locator('[data-slot="session-pane"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="session-pane"]')).toHaveAttribute(
      "data-session-id",
      parentId!,
    );

    const activity = page
      .locator('[data-slot="composer-dock"]')
      .getByRole("button", { name: "Activity · 2 running" });
    await expect(activity).toBeVisible();
    for (const width of [1280, 900]) {
      await application.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(width, 800);
      }, width);
      await expect
        .poll(() =>
          activity.evaluate((element) => {
            const strip = element.getBoundingClientRect();
            const dock = element.closest('[data-slot="composer-dock"]')!;
            const input = dock.querySelector("form")!.getBoundingClientRect();
            const chat = element.closest('[data-slot="chat"]')!;
            return (
              strip.bottom <= input.top &&
              Math.abs(strip.left - input.left - 16) < 2 &&
              Math.abs(input.right - strip.right - 16) < 2 &&
              parseFloat((chat as HTMLElement).style.getPropertyValue("--composer-dock-height")) >=
                chat.getBoundingClientRect().bottom - strip.top - 2
            );
          }),
        )
        .toBe(true);
    }
    await activity.click();
    const activityMenu = page.getByRole("dialog", { name: "Conversation activity" });
    await expect(
      activityMenu.getByRole("button", { name: "Open session: Background worker" }),
    ).toBeVisible();
    await activityMenu.press("Escape");
    await expect(activityMenu).toHaveCount(0);
    await expect(activity).toBeFocused();
    await activity.click();
    await activityMenu
      .getByRole("button", { name: "Inspect subagent: Subagent activity fixture" })
      .click();
    const subagentPanel = page.getByRole("complementary", { name: "Subagent" });
    await expect(subagentPanel).toContainText("Inspecting shared UI components.");
    await expect.poll(() => Boolean(subagentResponse)).toBe(true);
    subagentResponse!.end(chunk({}, "stop") + "data: [DONE]\n\n");
    await expect(subagentPanel).toContainText("Inspecting shared UI components.");
    // A narrow pane shows the inspected chat in place of the parent conversation.
    await subagentPanel.getByRole("button", { name: "Close Subagent" }).click();
    await expect(page.getByRole("button", { name: "Activity · 1 running" })).toBeVisible();

    // A collapsed Project uses the same hidden-child activity as a collapsed parent.
    // Measure the existing status column in both themes and sidebar viewport sizes.
    const projectHeader = page.locator('[data-slot="project-header"]').first();
    const projectStatus = projectHeader.locator('[data-slot="project-chat-status"]');
    const projectActions = projectHeader.locator('[data-slot="project-actions"]');
    const parentPane = page.locator('[data-slot="session-pane"]');
    for (const width of [1280, 900]) {
      await application.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(width, 800);
      }, width);
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        const childBounds = await childRow.getByRole("img", { name: "Running" }).boundingBox();
        const childRowBounds = await childRow.boundingBox();
        expect(childBounds).not.toBeNull();
        await expect(projectStatus.getByRole("img")).toHaveCount(0);
        await projectHeader.getByRole("button", { name: "Collapse project", exact: true }).click();
        await composer.click();
        const dot = projectStatus.getByRole("img", { name: "Running", exact: true });
        await expect(dot).toBeVisible();
        await expect(projectStatus).toHaveCSS("opacity", "1");
        const bounds = await dot.boundingBox();
        expect(bounds).not.toBeNull();
        const headerBounds = await projectHeader.boundingBox();
        // Focus can scroll the sidebar horizontally; compare row-relative status insets.
        const childInset =
          childRowBounds!.x + childRowBounds!.width - childBounds!.x - childBounds!.width / 2;
        const projectInset = headerBounds!.x + headerBounds!.width - bounds!.x - bounds!.width / 2;
        expect(Math.abs(projectInset - childInset)).toBeLessThan(1);
        await expect(childRow).toHaveCount(0);
        await expect(parentPane).toHaveAttribute("data-session-id", parentId!);
        await projectHeader.hover();
        await expect(projectStatus).toHaveCSS("opacity", "0");
        await expect(projectActions).toHaveCSS("opacity", "1");
        await projectHeader.getByRole("button", { name: "Expand project", exact: true }).click();
        await composer.click();
        await expect(projectStatus.getByRole("img")).toHaveCount(0);
        await expect(childRow.getByRole("img", { name: "Running" })).toBeVisible();
      }
    }

    // Inspect the real native menu without opening an OS popup in the hidden test window.
    await application.evaluate(({ Menu }) => {
      const build = Menu.buildFromTemplate.bind(Menu);
      const captured = Menu as typeof Menu & { sessionMenuLabels: string[] };
      captured.sessionMenuLabels = [];
      Menu.buildFromTemplate = (template) => {
        const menu = build(template);
        menu.popup = (options) => {
          captured.sessionMenuLabels = menu.items.map((item) => item.label);
          options.callback?.();
        };
        return menu;
      };
    });
    const sessionMenu = async () => {
      await application.evaluate(({ Menu }) => {
        (Menu as typeof Menu & { sessionMenuLabels: string[] }).sessionMenuLabels = [];
      });
      await childRow.locator(".session-row").click({ button: "right" });
      await expect
        .poll(() =>
          application.evaluate(
            ({ Menu }) => (Menu as typeof Menu & { sessionMenuLabels: string[] }).sessionMenuLabels,
          ),
        )
        .toContain("Rename");
      return application.evaluate(
        ({ Menu }) => (Menu as typeof Menu & { sessionMenuLabels: string[] }).sessionMenuLabels,
      );
    };
    expect(await sessionMenu()).not.toContain("Mark as Unread");

    childResponse!.end(chunk({}, "stop") + "data: [DONE]\n\n");
    await expect(childRow.locator('[aria-label="Running"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Activity ·/ })).toHaveCount(0);
    await expect(childRow.locator('[aria-label="Ready, unread"]')).toBeVisible();
    expect(await sessionMenu()).not.toContain("Mark as Unread");

    await childRow.locator(".session-row").click();
    await expect(childRow.locator('[aria-label="Ready, unread"]')).toHaveCount(0);
    expect(await sessionMenu()).toContain("Mark as Unread");
  } finally {
    await application.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
