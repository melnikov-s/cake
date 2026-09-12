import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("sidebar avatars glance locally and acknowledge selection without idle animation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-sidebar-avatar-"));
  const userData = join(root, "user-data");
  const project = join(root, "project");
  const cakeHome = join(root, "cake-home");
  const sessions = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = "2026-01-01T00:00:00.000Z";
  await Promise.all(
    [userData, project, sessions, join(cakeHome, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      selectedSessionId: "avatar-one",
      activeConversation: {
        kind: "project-session",
        workspacePath: project,
        sessionId: "avatar-one",
      },
    }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Avatar project", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
      trustedProjectPaths: [project],
    }),
  );
  for (const id of ["avatar-one", "avatar-two"]) {
    await writeFile(
      join(sessions, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
      [
        { type: "session", version: 3, id, timestamp, cwd: project },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: { role: "user", content: [{ type: "text", text: id }], timestamp: 0 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
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
    const first = page.locator('.session-item[data-session-id="avatar-one"]');
    const second = page.locator('.session-item[data-session-id="avatar-two"]');
    const avatar = first.locator('[data-slot="avatar"]');
    const look = avatar.locator(".dbga-hop .dbga-look");
    const otherLook = second.locator(".dbga-hop .dbga-look");
    await expect(avatar).toHaveAttribute("data-animated", "interaction");
    await expect(otherLook).toHaveCount(1);
    await page.mouse.move(1, 1);
    await expect(look).toHaveCSS("transform", "none");
    await avatar.evaluate((element) => {
      for (const target of element.querySelectorAll(".dbga-hop, .dbga-eye")) {
        const animate = target.animate.bind(target);
        target.animate = (...args: Parameters<Element["animate"]>) => {
          element.setAttribute(
            "data-reactions",
            String(Number(element.getAttribute("data-reactions")) + 1),
          );
          return animate(...args);
        };
      }
    });
    await first.locator(".session-title").hover();
    await expect(look).toHaveCSS("transform", "matrix(1, 0, 0, 1, 1.5, 0)");
    await expect(otherLook).toHaveCSS("transform", "none");
    expect(await avatar.getAttribute("data-reactions")).toBeNull();
    await expect
      .poll(() => avatar.evaluate((element) => element.getAnimations({ subtree: true }).length))
      .toBe(0);

    await first.locator(".session-row > button").click();
    await expect(avatar).toHaveAttribute("data-reactions", "3");
    await expect(first).toHaveClass(/active/);
    // Repeated selection retriggers feedback, including keyboard activation.
    await first.locator(".session-row > button").press("Enter");
    await expect(avatar).toHaveAttribute("data-reactions", "6");

    await second.locator(".session-title").hover();
    await expect(look).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    await expect(otherLook).toHaveCSS("transform", "matrix(1, 0, 0, 1, 1.5, 0)");
    expect(
      await avatar.evaluate((element) => element.getAnimations({ subtree: true }).length),
    ).toBe(0);
    await first.getByRole("button", { name: /Change session status/ }).click();
    await expect(page.getByRole("radiogroup", { name: "Session status" })).toBeVisible();
    await expect(avatar).toHaveAttribute("data-reactions", "6");
    await page.keyboard.press("Escape");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(look).toHaveCSS("transform", "none");
    await first.locator(".session-title").hover();
    await first.locator(".session-row > button").click();
    await expect(look).toHaveCSS("transform", "none");
    await expect(avatar).toHaveAttribute("data-reactions", "6");
    expect(
      await avatar.evaluate((element) => element.getAnimations({ subtree: true }).length),
    ).toBe(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await second.locator(".session-row > button").click();
    await expect(second).toHaveClass(/active/);
    await expect(otherLook).toHaveCSS("transform", "matrix(1, 0, 0, 1, 1.5, 0)");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
