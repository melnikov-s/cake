import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";
import { showSessions } from "./fixtures/workspace-navigation";

const repository = resolve(import.meta.dirname, "../..");

test("Sessions selections reveal and focus the selected Chat without leaving its workspace mode", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-sessions-chat-"));
  const project = join(temporary, "project");
  const cakeHome = join(temporary, "cake-home");
  const userData = join(temporary, "user-data");
  const directory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  await Promise.all(
    [project, userData, directory, join(cakeHome, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId: "source" }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Selection focus", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
    }),
  );
  for (const sessionId of ["source", "target"]) {
    await writeFile(
      join(directory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
        { type: "session_info", id: "title", parentId: null, timestamp, name: sessionId },
        {
          type: "message",
          id: "message",
          parentId: "title",
          timestamp,
          message: {
            role: "user",
            timestamp: 0,
            content: [{ type: "text", text: `${sessionId} conversation` }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  }
  const application = await electron.launch({
    args: [repository],
    cwd: repository,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_HOME: cakeHome,
      CAKE_ELECTRON_USER_DATA: userData,
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    await page
      .getByRole("button", { name: "Open Project Chat for Selection focus", exact: true })
      .click();
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    const tabs = page.getByRole("group", { name: "Companion content", exact: true });
    const modes = page.getByRole("group", { name: "Conversation workspace", exact: true });
    const select = async (id: string, keyboard = false) => {
      const button = page.locator(
        `[data-slot="conversation-navigator-row"][data-session-id="${id}"] .session-row > button`,
      );
      if (keyboard) {
        await button.focus();
        await button.press("Enter");
      } else await button.click();
      await expect(
        page.locator(".transcript").getByText(`${id} conversation`, { exact: true }),
      ).toBeVisible();
      await expect(input).toBeFocused();
    };
    const sessions = async () => {
      await tabs.getByRole("button", { name: "Sessions", exact: true }).click();
      await expect(page.getByRole("region", { name: "Sessions", exact: true })).toBeVisible();
    };
    const expectChat = async (id: string, mode: "Main" | "Browser" | "VS Code", draft: string) => {
      await expect(modes.getByRole("button", { name: mode, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      if (mode !== "Main") {
        await expect(
          page.getByRole("region", { name: `${mode} workspace`, exact: true }),
        ).toBeVisible();
        await expect(tabs.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
      }
      await expect(
        page.locator(".transcript").getByText(`${id} conversation`, { exact: true }),
      ).toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(draft);
      await input.press("End");
      await input.pressSequentially(" typed");
      await expect(input).toHaveValue(`${draft} typed`);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await input.fill(draft);
    };
    await showSessions(page);
    await select("source");
    for (const mode of ["Browser", "VS Code"] as const) {
      await modes.getByRole("button", { name: mode, exact: true }).click();
      await expect(input).toBeVisible();
      await input.fill(`${mode} source draft`);
      // The layout's same-session no-op still needs an explicit Chat reveal and focus.
      await sessions();
      await select("source");
      await expectChat("source", mode, `${mode} source draft`);
      await sessions();
      await select("target");
      await modes.getByRole("button", { name: mode, exact: true }).click();
      await expect(input).toBeVisible();
      await input.fill(`${mode} target draft`);
      await sessions();
      await select("source");
      await expectChat("source", mode, `${mode} source draft`);
      // Different retained target, selected using native keyboard activation.
      await sessions();
      await select("target", true);
      await expectChat("target", mode, `${mode} target draft`);
      await page.screenshot({ path: testInfo.outputPath(`sessions-selected-chat-${mode}.png`) });
      // Tab switching itself must not be globally forced back to Chat.
      await tabs.getByRole("button", { name: "Todos", exact: true }).click();
      await expect(tabs.getByRole("button", { name: "Todos", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      // Permanent Project Chat uses the other Sessions-row component.
      const homeInput = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
      const selectHome = async () => {
        await page
          .getByRole("region", { name: "Sessions", exact: true })
          .getByRole("button", { name: "Selection focus", exact: true })
          .click();
        await expect(homeInput).toBeFocused();
      };
      await sessions();
      await selectHome();
      await modes.getByRole("button", { name: mode, exact: true }).click();
      await homeInput.fill(`${mode} home draft`);
      await sessions();
      await selectHome();
      await expect(tabs.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(modes.getByRole("button", { name: mode, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(homeInput).toHaveValue(`${mode} home draft`);
      await homeInput.press("End");
      await homeInput.pressSequentially(" typed");
      await expect(homeInput).toHaveValue(`${mode} home draft typed`);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await sessions();
      await select("source");
      await sessions();
      await selectHome();
      await expect(tabs.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(modes.getByRole("button", { name: mode, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(homeInput).toHaveValue(`${mode} home draft typed`);
      await sessions();
      await select("source");
    }
    await modes.getByRole("button", { name: "Main", exact: true }).click();
    await showSessions(page);
    await select("source");
    await expectChat("source", "Main", "VS Code source draft");
    await showSessions(page);
    await select("target");
    await modes.getByRole("button", { name: "Main", exact: true }).click();
    await showSessions(page);
    await select("source");
    await showSessions(page);
    await select("target");
    await expectChat("target", "Main", "VS Code target draft");
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await application.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
