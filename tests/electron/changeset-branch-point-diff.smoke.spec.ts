import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const exec = promisify(execFile);

test("changeset clicks compare the branch point with dirty content, including added, deleted and renamed paths", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-changeset-diff-"));
  const project = join(root, "project");
  const userData = join(root, "user-data");
  const cakeHome = join(root, "cake-home");
  const sessionId = "changeset-diff-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: project })).stdout.trim();
  await Promise.all([
    mkdir(project),
    mkdir(userData),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await git("-c", "init.defaultBranch=main", "init");
  await git("config", "user.name", "Cake Test");
  await git("config", "user.email", "cake@example.test");
  await writeFile(join(project, "app.ts"), "export const value = 0;\n");
  await writeFile(join(project, "deleted.ts"), "export const deleted = true;\n");
  await writeFile(join(project, "old-name.ts"), "export const renamed = true;\n");
  await git("add", ".");
  await git("commit", "-m", "Initial project");
  const branchPoint = await git("rev-parse", "HEAD");
  await git("checkout", "-b", "agent/review");
  for (const [value, subject] of [
    [1, "First session commit"],
    [2, "Second session commit"],
  ] as const) {
    await writeFile(join(project, "app.ts"), `export const value = ${value};\n`);
    await git("add", ".");
    await git("commit", "-m", subject);
  }
  await git("checkout", "main");
  await writeFile(join(project, "upstream.txt"), "Unrelated upstream change\n");
  await git("add", ".");
  await git("commit", "-m", "Advance upstream");
  await git("checkout", "agent/review");
  await writeFile(join(project, "app.ts"), "export const value = 3;\n");
  await rm(join(project, "deleted.ts"));
  await rm(join(project, "old-name.ts"));
  await writeFile(join(project, "new-name.ts"), "export const renamed = true;\n");
  await writeFile(join(project, "added.ts"), "export const added = true;\n");
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId, theme: "dark" }),
  );
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
          content: [{ type: "text", text: "Review changes" }],
          timestamp: 0,
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
    await page.getByRole("button", { name: "Search sessions", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Search sessions", exact: true })
      .locator(`[data-session-id="${sessionId}"]`)
      .click();
    await page.getByRole("button", { name: "Review changes · 2 commits" }).click();
    const changes = page.getByRole("complementary", { name: "Changes" });
    await changes.getByRole("button", { name: /First session commit/ }).click();
    await changes
      .getByRole("button", { name: /app.ts/ })
      .first()
      .click();
    const workbench = (source: string) =>
      application.evaluate(async ({ webContents }, source) => {
        for (const contents of webContents.getAllWebContents()) {
          if (contents.getURL().startsWith("http://127.0.0.1:"))
            return contents.executeJavaScript(source);
        }
        return undefined;
      }, source);
    const activeTab = () => workbench('document.querySelector(".tab.active")?.textContent?.trim()');
    const diffText = () =>
      workbench(
        'document.querySelector(".monaco-diff-editor")?.textContent?.replaceAll("\\u00a0", " ")',
      );
    await expect
      .poll(activeTab, { timeout: 20_000 })
      .toBe(`app.ts (${branchPoint} ↔ Working Tree)`);
    await expect.poll(diffText).toContain("value = 0");
    await expect.poll(diffText).toContain("value = 3");
    const screenshot = await application.evaluate(async ({ webContents }) => {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.getURL().startsWith("http://127.0.0.1:"))
          return (await contents.capturePage()).toPNG().toString("base64");
      }
      throw new Error("Missing embedded workbench");
    });
    await writeFile(
      testInfo.outputPath("changeset-branch-point-diff.png"),
      Buffer.from(screenshot, "base64"),
    );
    // The list deliberately represents renames as deletion + addition.
    for (const file of ["added.ts", "deleted.ts", "old-name.ts", "new-name.ts"]) {
      await changes.getByRole("button", { name: new RegExp(file) }).click();
      await expect
        .poll(activeTab, { timeout: 20_000 })
        .toBe(`${file} (${branchPoint} ↔ Working Tree)`);
      await expect
        .poll(() => workbench('!!document.querySelector(".monaco-diff-editor")'))
        .toBe(true);
    }
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
