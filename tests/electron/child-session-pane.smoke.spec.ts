import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { emitRendererEvent } from "./main-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function sessionEntries(sessionId: string, project: string, text: string) {
  const timestamp = new Date(0).toISOString();
  return [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
    {
      type: "message",
      id: `${sessionId}-user`,
      parentId: null,
      timestamp,
      message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
    },
  ];
}

async function writeSession(directory: string, sessionId: string, project: string, text: string) {
  await writeFile(
    join(directory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    `${sessionEntries(sessionId, project, text)
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
}

test("opens family children beside their parent and reuses the child pane", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-child-session-pane-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const parentSessionId = "family-parent";
  const backgroundChildSessionId = "family-child-background";
  const firstChildSessionId = "family-child-1";
  const secondChildSessionId = "family-child-2";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: parentSessionId,
      activeConversation: {
        kind: "project-session",
        workspacePath: project,
        sessionId: parentSessionId,
      },
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
      draftsBySession: {},
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
      trustedProjectPaths: [project],
    }),
  );
  await Promise.all([
    writeSession(sessionDirectory, parentSessionId, project, "Parent"),
    writeSession(sessionDirectory, backgroundChildSessionId, project, "Background child"),
    writeSession(sessionDirectory, firstChildSessionId, project, "First child"),
    writeSession(sessionDirectory, secondChildSessionId, project, "Second child"),
  ]);

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
    const panes = page.locator('[data-slot="session-pane"]');
    await expect(panes).toHaveCount(1, { timeout: 20_000 });
    await expect(panes.first()).toHaveAttribute("data-session-id", parentSessionId);

    await emitRendererEvent(application, {
      type: "project-session-control-requested",
      sessionId: parentSessionId,
      controlRequestId: "00000000-0000-4000-8000-000000000000",
      invocation: {
        _tag: "ProjectChildSession",
        childSessionId: backgroundChildSessionId,
        title: "Background child",
        familyId: "family-1",
        familyChildOrder: 0,
        placement: "none",
      },
    });
    await expect(panes).toHaveCount(1);
    await expect(panes.first()).toHaveAttribute("data-session-id", parentSessionId);

    await emitRendererEvent(application, {
      type: "project-session-control-requested",
      sessionId: parentSessionId,
      controlRequestId: "00000000-0000-4000-8000-000000000001",
      invocation: {
        _tag: "ProjectChildSession",
        childSessionId: firstChildSessionId,
        title: "First child",
        familyId: "family-1",
        familyChildOrder: 0,
        placement: "right",
      },
    });
    await expect(panes).toHaveCount(2);
    const parentPane = panes.filter({ has: page.getByText("Parent", { exact: true }) });
    const childPane = panes.filter({ has: page.getByText("First child", { exact: true }) });
    const parentInput = parentPane.getByLabel("Message");
    const childInput = childPane.getByLabel("Message");
    await expect(childPane).toHaveAttribute("data-session-id", firstChildSessionId);
    await expect(childPane).toHaveAttribute("data-focused", "true");
    await expect(
      page.locator(`.session-item[data-session-id="${firstChildSessionId}"]`),
    ).toHaveClass(/active/);

    // A stale async focus restoration in either mounted chat must not become pane-selection
    // authority. Before this regression, alternating programmatic focus changed the shell
    // selection on every focus event and could make the parent and child flash in the sidebar.
    await page.evaluate(
      ({ parentSessionId, childSessionId }) => {
        const input = (sessionId: string) =>
          document.querySelector<HTMLTextAreaElement>(
            `[data-slot="session-pane"][data-session-id="${sessionId}"] textarea`,
          )!;
        for (let index = 0; index < 10; index += 1) {
          input(parentSessionId).focus();
          input(childSessionId).focus();
        }
        input(parentSessionId).focus();
      },
      { parentSessionId, childSessionId: firstChildSessionId },
    );
    await expect(childPane).toHaveAttribute("data-focused", "true");
    await expect(
      page.locator(`.session-item[data-session-id="${firstChildSessionId}"]`),
    ).toHaveClass(/active/);

    // Pointer and keyboard traversal remain explicit user intents that select a pane.
    await parentInput.click();
    await expect(parentPane).toHaveAttribute("data-focused", "true");
    await childInput.click();
    await expect(childPane).toHaveAttribute("data-focused", "true");

    await emitRendererEvent(application, {
      type: "project-session-control-requested",
      sessionId: parentSessionId,
      controlRequestId: "00000000-0000-4000-8000-000000000002",
      invocation: {
        _tag: "ProjectChildSession",
        childSessionId: secondChildSessionId,
        title: "Second child",
        familyId: "family-1",
        familyChildOrder: 1,
        placement: "right",
      },
    });
    await expect(panes).toHaveCount(2);
    await expect(panes.nth(1)).toHaveAttribute("data-session-id", secondChildSessionId);
    await expect(
      page.locator(`[data-slot="session-pane"][data-session-id="${firstChildSessionId}"]`),
    ).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
