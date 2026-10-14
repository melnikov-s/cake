import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { seedWorkflowCheckpoint } from "../fixtures/workflow-checkpoint";
import { workflowSource, workflowRunFixture } from "../fixtures/dynamic-workflow";
import type { CakeEvent } from "../../src/contracts/application/cake-rpc-contract";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("inspects workflow details and preserves native project composer input in a hidden window", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-workflow-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "workflow-native-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId, theme: "dark" }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Workflow project", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "workflow-user",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Audit route authentication." }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "workflow-assistant",
        parentId: "workflow-user",
        timestamp,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "The workflow completed. Inspect its frozen program below." },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  await seedWorkflowCheckpoint(cakeHome, sessionId, project);
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
    const card = page.locator('[data-slot="workflow-progress"]');
    await expect(card.getByText("audit-auth", { exact: true })).toBeVisible();
    const composer = page.getByRole("combobox", { name: "Message" });
    await composer.focus();
    await expect(composer).toBeFocused();
    await composer.pressSequentially("Retain this draft while inspecting the run");
    await expect(composer).toHaveValue("Retain this draft while inspecting the run");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await card.getByRole("button", { name: "Details" }).click();
    const panel = page.getByRole("complementary", { name: "Workflow details" });
    await expect(panel).toBeVisible();
    const source = panel.getByRole("region", { name: "Frozen workflow source" });
    await expect(source.locator("code")).toBeVisible();
    await expect
      .poll(() => source.locator("code > span").allTextContents())
      .toEqual(workflowSource.trim().split("\n"));
    // Use actual keyboard input in the native controlled field, not a jsdom focus claim.
    const name = panel.getByRole("textbox", { name: "Workflow name" });
    await name.focus();
    await name.press("ControlOrMeta+A");
    await name.pressSequentially("audit-reusable");
    await expect(name).toBeFocused();
    await expect(name).toHaveValue("audit-reusable");
    await expect(panel.getByRole("button", { name: "Save workflow", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "Close Workflow details" }).click();
    await expect(panel).toHaveCount(0);
    await expect(composer).toHaveValue("Retain this draft while inspecting the run");
    await composer.focus();
    await expect(composer).toBeFocused();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const requestId = "af8396cb-8901-4ef7-bd6b-9f63104344ce";
    const uiRequestId = "de0f4bcf-cba6-4963-92b0-62a0bc67b0fa";
    const proposal: Extract<CakeEvent, { type: "ui-request" }> = {
      type: "ui-request",
      requestId,
      uiRequestId,
      sessionId,
      kind: "workflow-choice",
      title: "audit-auth",
      message: "Audit route authentication",
      workflow: {
        ownerSessionId: sessionId,
        program: workflowRunFixture({ projectPath: project }).program,
      },
    };
    const emit = (event: CakeEvent) =>
      application.evaluate((_electron, value) => {
        const publish = Reflect.get(globalThis, "cakeSmokeEmitRendererEvent") as (
          input: CakeEvent,
        ) => void;
        publish(value);
      }, event);
    // Native portal/focus/dismissal proof uses the repository's validated event hook.
    // The real coordinator + launch path is covered by workflow-proposal domain tests.
    const choice = page.getByRole("alertdialog", { name: "audit-auth" });
    // Off by default: drain the same event stream using a non-dialog marker.
    await emit(proposal);
    await emit({
      type: "extension-ui-intent",
      sessionId,
      intent: {
        kind: "notify",
        id: "feature-gate-marker",
        message: "Workflow feature gate processed",
        tone: "info",
      },
    });
    await expect(page.getByText("Workflow feature gate processed", { exact: true })).toBeVisible();
    await expect(choice).toHaveCount(0);
    await expect(composer).toHaveValue("Retain this draft while inspecting the run");
    await emit({ type: "ui-request-settled", uiRequestId, sessionId });
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /^Experimental/ }).click();
    const experiment = page.getByRole("switch", { name: "Dynamic workflows" });
    await expect(experiment).not.toBeChecked();
    await experiment.click();
    await expect(experiment).toBeChecked();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(cakeHome, "state", "application.json"), "utf8")).data
            ?.experimentalFeatures?.dynamicWorkflows,
      )
      .toBe(true);
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await emit(proposal);
    await expect(choice).toBeVisible();
    await expect(choice.getByRole("button", { name: "Continue normally" })).toBeFocused();
    await expect(choice.getByRole("list", { name: "Proposed phases" })).toContainText("Discover");
    await choice.getByRole("button", { name: "View script" }).click();
    const script = choice.getByRole("region", { name: "Proposed workflow script" });
    await expect
      .poll(() => script.locator("code").first().locator(":scope > span").allTextContents())
      .toEqual(workflowSource.trim().split("\n"));
    await choice.getByRole("button", { name: "Continue normally" }).click();
    await expect(choice).toHaveCount(0);
    await expect(composer).toHaveValue("Retain this draft while inspecting the run");
    await emit({ ...proposal, uiRequestId: "811c1a28-59d9-49ce-8ca6-6399cf0fd53e" });
    await expect(choice).toBeVisible();
    await choice.getByRole("button", { name: "Continue normally" }).press("Escape");
    await expect(choice).toHaveCount(0);
    await composer.focus();
    await expect(composer).toBeFocused();
    // Visiting Settings remounted the composer; explicitly place the caret for this append.
    await composer.press("ControlOrMeta+A");
    await composer.press("ArrowRight");
    await composer.pressSequentially(" and after the choice");
    await expect(composer).toHaveValue(
      "Retain this draft while inspecting the run and after the choice",
    );
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
