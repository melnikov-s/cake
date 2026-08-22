import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("uses an intrinsic-height shared chat for code questions and toggles its header without resolving", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-code-chat-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(project, "src"), { recursive: true }),
  ]);
  await writeFile(join(project, "src/example.ts"), "export const answer = 42;\n");
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
    }),
  );
  await writeFile(
    join(userData, "application.json"),
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
      resolvedSessionIds: [],
      trustedProjectPaths: [],
    }),
  );

  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: join(temporaryRoot, "cake-home"),
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Browse project files" }).click();
    await page.getByTitle("src/example.ts").click();
    await expect(page.getByRole("table", { name: "Workspace file src/example.ts" })).toBeVisible();

    const source = page.getByRole("row").filter({ hasText: "export const answer = 42;" });
    await source.locator("code").evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf("answer") ?? -1;
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + "answer".length);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      throw new Error("Could not select answer");
    });
    await expect(page.getByLabel("New code chat on src/example.ts")).toHaveCount(0);

    await source.getByRole("button", { name: "Ask about line 1" }).click();
    const draft = page.getByLabel("New code chat on src/example.ts");
    const input = page.getByLabel("Message code chat");
    await expect(draft).toBeVisible();
    await expect(draft.locator(".transcript .user-message")).toHaveText("answer");
    await expect(input).toBeFocused();
    await input.fill("Why is this exported?");
    await expect(input).toHaveValue("Why is this exported?");
    await expect(draft.getByRole("button", { name: "Send" })).toBeEnabled();

    const dimensions = await draft.evaluate((element) => {
      const card = element.getBoundingClientRect();
      const lastMessage = Array.from(element.querySelectorAll(".transcript-item"))
        .at(-1)
        ?.getBoundingClientRect();
      const composer = element.querySelector(".workbench-composer")?.getBoundingClientRect();
      return {
        height: card.height,
        transcriptGap:
          lastMessage && composer ? composer.top - lastMessage.bottom : Number.POSITIVE_INFINITY,
        bottomGap: composer ? card.bottom - composer.bottom : Number.POSITIVE_INFINITY,
      };
    });
    expect(dimensions.height).toBeLessThan(460);
    expect(dimensions.transcriptGap).toBeLessThan(40);
    expect(dimensions.bottomGap).toBeLessThanOrEqual(12);

    await draft.getByRole("button", { name: "Send" }).click();
    const thread = page.getByRole("article", { name: "Review thread on src/example.ts" });
    await expect(thread).toBeVisible();
    await expect(thread.getByRole("button", { name: "Minimize" })).toHaveCount(0);
    await thread.getByRole("button", { name: "Collapse review thread" }).click();

    const collapsed = page.getByRole("button", { name: "Expand review thread" });
    await expect(collapsed).toBeVisible();
    await expect(collapsed).toContainText("Review thread");
    await collapsed.click();
    await expect(thread).toBeVisible();
    await expect(thread.getByRole("button", { name: "Resolve" })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
