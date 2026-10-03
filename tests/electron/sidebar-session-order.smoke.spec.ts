import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const resolveSelected of [true, false]) {
  test(`keeps session date order after resolving a ${resolveSelected ? "selected" : "non-selected"} newer row`, async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-sidebar-session-order-"));
    const userData = join(temporaryRoot, "user-data");
    const project = join(temporaryRoot, "project");
    const cakeHome = join(temporaryRoot, "cake-home");
    const sessionDirectory = cakeWorkspaceSessionDirectory(
      project,
      join(cakeHome, "pi", "sessions"),
    );
    const ids = ["newer", "previous", "older"];
    await Promise.all([
      mkdir(userData, { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
      mkdir(join(cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(userData, "window-state.json"),
      JSON.stringify({
        projectPath: project,
        selectedSessionId: "previous",
        activeConversation: {
          kind: "project-session",
          workspacePath: project,
          sessionId: "previous",
        },
        recentProjectPaths: [project],
        theme: "system",
      }),
    );
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
        trustedProjectPaths: [],
      }),
    );
    for (const [index, id] of ids.entries()) {
      const timestamp = new Date(Date.UTC(index === 0 ? 2100 : 2020, 0, 3 - index));
      const path = join(
        sessionDirectory,
        `${timestamp.toISOString().replaceAll(":", "-").replace(".", "-")}_${id}.jsonl`,
      );
      await writeFile(
        path,
        [
          { type: "session", version: 3, id, timestamp: timestamp.toISOString(), cwd: project },
          {
            type: "message",
            id: `user-${id}`,
            parentId: null,
            timestamp: timestamp.toISOString(),
            message: {
              role: "user",
              content: [{ type: "text", text: id }],
              timestamp: timestamp.getTime(),
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      await utimes(path, timestamp, timestamp);
    }
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
      const rows = page.locator('[data-slot="project-group"] .session-item');
      const order = () =>
        rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-session-id")),
        );
      await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
      await expect.poll(order).toEqual(ids);
      const row = (id: string) => page.locator(`.session-item[data-session-id="${id}"]`);
      await row("previous").locator(".session-row").click();
      await expect(row("previous")).toHaveClass(/active/);
      if (resolveSelected) {
        await row("newer").locator(".session-row").click();
        await expect(row("newer")).toHaveClass(/active/);
      }
      await row("newer").locator(".session-resolve-action").click();
      await expect(row("previous")).toHaveClass(/active/);
      await expect.poll(order).toEqual(["previous", "older"]);
      await row("older").locator(".session-row").click();
      await expect(row("older")).toHaveClass(/active/);
      await expect.poll(order).toEqual(["previous", "older"]);
    } finally {
      await application.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
