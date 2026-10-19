import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { encodeCrossSessionMessage } from "../../src/contracts/conversations/cross-session-message";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");
for (const state of ["default", "project", "reference"]) {
  test(`incoming communication is readable and navigable (${state})`, async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-session-messages-"));
    const paths = {
      cakeHome: join(temporaryRoot, "cake-home"),
      project: join(temporaryRoot, "project"),
      userData: join(temporaryRoot, "user-data"),
    };
    const scenario = findVisualCaptureScenario(
      state === "reference" ? "session-message-variants" : "session-messages",
    )!;
    await scenario.seed(paths, state === "default" ? "light" : "dark");
    if (state === "project") {
      const safePath = `--${resolve(paths.project)
        .replace(/^[/\\]/, "")
        .replace(/[/\\:]/g, "-")}--`;
      const file = join(
        paths.cakeHome,
        "pi",
        "sessions",
        safePath,
        "1970-01-01T00-00-00-000Z_visual-assistant-markdown-code.jsonl",
      );
      const entry = {
        type: "message",
        id: "missing-source",
        parentId: "incoming-1",
        timestamp: new Date(0).toISOString(),
        message: {
          role: "user",
          timestamp: 12,
          content: encodeCrossSessionMessage("Historical report from a now-unavailable session.", {
            version: 1,
            messageId: "43b09fbc-e8ab-4c05-b037-8dbd6f43e7b7",
            threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
            sequence: 2,
            expectsResponse: false,
            sender: {
              sessionId: "missing-session",
              title: "Session missing-session",
              kind: "project-session",
            },
          }),
        },
      };
      await writeFile(file, `${await readFile(file, "utf8")}${JSON.stringify(entry)}\n`);
    }
    const application = await electron.launch({
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
    try {
      const page = await application.firstWindow();
      await scenario.prepare(page, state);
      const card = page.getByRole("region", { name: "Message from another session" }).first();
      await expect(card.getByRole("heading", { name: "Completed" })).toBeVisible();
      await expect(card).toHaveCSS("border-width", "0px");
      await expect(card.locator("header")).toHaveCSS("border-bottom-width", "0px");
      await expect(card).not.toContainText("cake-session-message");
      const message = card.locator("..");
      const actions = message.locator('[data-slot="message-actions"]');
      await expect(actions.getByRole("button")).toHaveCount(1);
      const copy = actions.getByRole("button", { name: "Copy response", exact: true });
      await copy.focus();
      await expect(copy).toBeFocused();
      await copy.press("Enter");
      await expect(actions.getByRole("button", { name: "Copied response" })).toBeVisible();
      const copied = await application.evaluate(({ clipboard }) => clipboard.readText());
      expect(copied).toContain("Installed the **manual post-mortem skill**");
      expect(copied).not.toContain("cake-session-message");
      if (state === "reference") {
        const reply = page.getByRole("region", { name: "Message from another session" }).last();
        await expect(reply).toContainText("Response received.");
        await expect(reply).not.toContainText("Referenced Cake messages");
        await expect(reply).not.toContainText("messages.read");
        const replyMessage = reply.locator("..");
        await expect(replyMessage.getByRole("button")).toHaveCount(1);
        await replyMessage.getByRole("button", { name: "Copy response" }).click();
        await expect(replyMessage.getByRole("button", { name: "Copied response" })).toBeVisible();
        expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
          "Response received.",
        );
        const original = page.getByRole("button", { name: /Full agent response/ });
        await original.focus();
        await original.press("Enter");
        await expect(page.getByRole("heading", { name: "Skill installed" })).toBeVisible();
        await page.getByRole("button", { name: "Copy message", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "Copied message", exact: true }),
        ).toBeVisible();
        expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toContain(
          "## Skill installed",
        );
        await original.focus();
        await original.press("Enter");
        await expect(original).toHaveAttribute("aria-expanded", "false");
      }
      const context = page.getByRole("button", { name: "Cake · response mode", exact: true });
      await context.click();
      await expect(page.getByText(/Cake response mode: text/)).toBeVisible();
      await context.click();
      if (state === "project") {
        const fallback = page.getByRole("region", { name: "Message from another session" }).last();
        await expect(fallback).toContainText("Source title not recorded");
        await expect(fallback).toContainText("Historical report from a now-unavailable session.");
        await fallback.getByRole("link", { name: "Untitled session", exact: true }).click();
        await expect(
          page.getByText("Cake could not find Project Session missing-session", { exact: true }),
        ).toBeVisible();
        await expect(card).toBeVisible();
      }
      const source = card.getByRole("link", {
        name: "Add and globally install manual post-mortem skill",
      });
      await expect(source).toHaveAttribute("href", "cake://session/visual-report-source");
      await source.focus();
      await expect(source).toBeFocused();
      await source.press("Enter");
      await expect(page.locator('[data-slot="workspace-header"] strong')).toHaveText(
        "Add and globally install manual post-mortem skill",
      );
      await expect(page.getByText("Install the skill.", { exact: true })).toBeVisible();
    } finally {
      await application.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
