import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario, seedArtifact } from "../../scripts/visual-capture/scenarios";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Artifact Library links an existing artifact to durable Project Chat and Cake Chat across reload", async () => {
  const testInfo = test.info();
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "cake-artifact-project-chat-link-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  const scenario = findVisualCaptureScenario("cake-chat")!;
  await scenario.seed(paths, "dark");
  await seedArtifact(
    paths,
    {
      protocol: "cake.artifact/v1",
      id: "library-link-report",
      sessionId: "visual-assistant-markdown-code",
      revision: 1,
      kind: "markdown",
      title: "Library link report",
      payload: {
        markdown: "# Project findings\n\nExisting artifact linked through the Artifact Library.",
      },
      fallback: { markdown: "Project findings" },
    },
    new Date(0).toISOString(),
  );
  const app = await electron.launch({
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
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await scenario.prepare(page, "project");
    const openLibrary = async () => {
      await page
        .getByRole("navigation", { name: "Projects and global utilities" })
        .getByRole("button", { name: "Artifacts", exact: true })
        .click();
      // Move focus out of the dynamic rail before selecting a covered library row.
      await page.mouse.move(800, 400);
      const report = page
        .getByRole("navigation", { name: "Artifact lineages", exact: true })
        .getByRole("button", { name: /Library link report/ });
      await report.focus();
      await report.press("Enter");
      await expect(
        page.getByRole("heading", { name: "Linked sessions", exact: true }),
      ).toBeVisible();
    };
    const storedLinks = async () => {
      const catalog = JSON.parse(
        await readFile(join(paths.cakeHome, "state", "artifacts", "catalog.json"), "utf8"),
      );
      return catalog.data.links.filter(
        (link: { lineageId: string }) => link.lineageId === "library-link-report",
      );
    };
    await openLibrary();
    await page.getByRole("button", { name: "Link to Project Chat", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unlink", exact: true })).toBeVisible();
    await expect(page.getByText("Project Chat", { exact: true })).toBeVisible();
    const projectTarget = {
      type: "session",
      sessionId: `project-chat:${createHash("sha256").update(paths.project).digest("hex")}`,
    };
    await expect
      .poll(storedLinks)
      .toContainEqual(
        expect.objectContaining({ target: projectTarget, selection: { mode: "follow-latest" } }),
      );
    await page.screenshot({ path: testInfo.outputPath("project-chat-linked.png") });
    await page.getByRole("button", { name: "Pin r1", exact: true }).click();
    await expect(page.getByText("Pinned r1", { exact: true })).toBeVisible();
    await page.reload();
    await page
      .getByRole("button", { name: /^Open Project Chat for / })
      .first()
      .click();
    await openLibrary();
    await expect(page.getByText("Pinned r1", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlink", exact: true })).toBeVisible();
    await expect.poll(storedLinks).toContainEqual(
      expect.objectContaining({
        target: projectTarget,
        selection: { mode: "pinned", revision: 1 },
      }),
    );
    await page.getByRole("button", { name: "Follow latest", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pin r1", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Unlink", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Link to Project Chat", exact: true }),
    ).toBeVisible();
    await expect
      .poll(storedLinks)
      .not.toContainEqual(expect.objectContaining({ target: projectTarget }));

    await page.getByRole("button", { name: "Close all artifacts", exact: true }).click();
    await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
    await openLibrary();
    await page.getByRole("button", { name: "Link to Cake Chat", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unlink", exact: true })).toBeVisible();
    const globalTarget = { type: "session", sessionId: CAKE_CHAT_SESSION_ID };
    await expect
      .poll(storedLinks)
      .toContainEqual(expect.objectContaining({ target: globalTarget }));
    await page.screenshot({ path: testInfo.outputPath("cake-chat-linked.png") });
    await page.getByRole("button", { name: "Unlink", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Link to Cake Chat", exact: true }),
    ).toBeVisible();
    await expect
      .poll(storedLinks)
      .not.toContainEqual(expect.objectContaining({ target: globalTarget }));
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
