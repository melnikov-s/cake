import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repository = resolve(import.meta.dirname, "../..");
const codeServerPath = "/opt/homebrew/bin/code-server";

test("Project Chat isolates history and restores its root workspace, while global Cake Chat has Browser", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-project-chat-"));
  const project = join(directory, "zombies");
  const cakeHome = join(directory, "cake");
  const userData = join(directory, "user-data");
  const requests: string[] = [];
  const attributions: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Project preview</title><h1>Project preview</h1>");
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const latest = JSON.stringify(JSON.parse(body).messages.at(-1)?.content);
    const summary = /Compaction: (?:compress message|merge lines)/.test(latest);
    const attribution = body.includes("Assign the LAST user message to one existing to-do");
    if (attribution) attributions.push(body);
    else if (!summary) requests.push(body);
    const content = attribution
      ? JSON.stringify({ todoId: null })
      : summary
        ? "talk: project guidance discussed"
        : `Reply ${requests.length}`;
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await Promise.all([
      mkdir(project),
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(join(cakeHome, "pi"), { recursive: true }),
      mkdir(userData),
      mkdir(join(directory, "home")),
      mkdir(join(project, ".agents/skills/project-fixture"), { recursive: true }),
      mkdir(join(cakeHome, "pi/skills/global-fixture"), { recursive: true }),
    ]);
    await writeFile(
      join(project, ".agents/skills/project-fixture/SKILL.md"),
      "---\nname: project-fixture\ndescription: Project fixture skill\n---\nPROJECT_SKILL_BODY\n",
    );
    await writeFile(
      join(cakeHome, "pi/skills/global-fixture/SKILL.md"),
      "---\nname: global-fixture\ndescription: Global fixture skill\n---\nGLOBAL_SKILL_BODY\n",
    );
    await writeFile(join(project, "example.ts"), "export const zombies = 7;\n");
    await writeFile(
      join(cakeHome, "pi", "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `${origin}/v1`,
            apiKey: "fixture",
            api: "openai-completions",
            models: [
              {
                id: "fixture",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const presetId = "00000000-0000-4000-8000-000000000001";
    const timestamp = new Date(0).toISOString();
    const sessionId = "sidebar-task";
    const sessionDirectory = cakeWorkspaceSessionDirectory(
      project,
      join(cakeHome, "pi", "sessions"),
    );
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
        { type: "session_info", id: "name", parentId: null, timestamp, name: "Sidebar task" },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: [
            { path: project, name: "Zombies", addedAt: timestamp, lastOpenedAt: timestamp },
          ],
          trustedProjectPaths: [project],
          unreadSessionIds: [sessionId],
          ...(existsSync(codeServerPath) ? { vscodeServerPath: codeServerPath } : null),
          modelPresets: [
            {
              id: presetId,
              name: "Fixture",
              provider: "fixture",
              modelId: "fixture",
              thinkingLevel: "off",
              fastMode: false,
            },
          ],
          defaultModelPresetId: presetId,
          utilityModel: { provider: "fixture", modelId: "fixture", thinkingLevel: "off" },
        },
      }),
    );
    const launch = () =>
      electron.launch({
        args: [repository],
        cwd: repository,
        env: {
          ...process.env,
          HOME: join(directory, "home"),
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_HOME: cakeHome,
          CAKE_ELECTRON_USER_DATA: userData,
          PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
    app = await launch();
    let page = await app.firstWindow();
    // Exclude inert outgoing transcript clones retained by the fade transition.
    const transcript = () =>
      page.locator(
        '[data-slot="content-transition"] > [data-slot="content-transition-live"] .transcript',
      );
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    let input = page.getByRole("combobox", { name: "Message Cake Chat" });
    await expect(input).toBeVisible();
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("GLOBAL_PRIVATE");
    await expect(input).toHaveValue("GLOBAL_PRIVATE");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await input.press("Enter");
    await expect(page.getByText("Reply 1", { exact: true })).toBeVisible();
    const verifySchedule = async (label: string) => {
      const requestCount = requests.length;
      // Cake Chat and Project Chat share the existing message-side-chat draft.
      await input.click();
      await input.pressSequentially("/side");
      await expect(
        page.getByRole("option", { name: /sidechat \[prompt\] Start a side chat Cake/ }),
      ).toBeVisible();
      await input.press("Enter");
      await expect(input).toHaveValue("");
      const sideChat = page.getByRole("complementary", { name: "Side chat" });
      await expect(sideChat).toBeVisible();
      const sideChatInput = sideChat.getByRole("combobox");
      await expect(sideChatInput).toBeFocused();
      await sideChatInput.pressSequentially("Draft a follow-up");
      await expect(sideChatInput).toHaveValue("Draft a follow-up");
      await expect(sideChat.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await sideChat.getByRole("button", { name: "Close Side chat" }).click();
      await expect(input).toBeFocused();
      expect(requests).toHaveLength(requestCount);
      await input.click();
      await expect(input).toBeFocused();
      await input.fill("/");
      await expect(page.getByRole("option", { name: /compact Manually/ })).toBeVisible();
      await expect(page.getByRole("option", { name: /model .*Switch model Pi CLI/ })).toBeVisible();
      await expect(
        page.getByRole("option", {
          name: /schedule .*Schedule a message to this conversation Cake/,
        }),
      ).toBeVisible();
      await input.fill("/sch");
      await input.press("Tab");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("/schedule ");
      await input.pressSequentially(`1d ${label}`);
      await expect(input).toHaveValue(`/schedule 1d ${label}`);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await input.press("Enter");
      await expect(input).toHaveValue("");
      const scheduled = page.getByRole("group", { name: "Scheduled", exact: true });
      await expect(scheduled.getByText(label, { exact: true })).toBeVisible();
      expect(requests).toHaveLength(requestCount);
      await scheduled.getByRole("button", { name: `Cancel scheduled message: ${label}` }).click();
      await expect(scheduled).toHaveCount(0);
      await input.fill("/schedule 0s Invalid reminder");
      await input.press("Enter");
      await expect(
        page.getByText("Schedule time must be a valid future duration or ISO timestamp", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(input).toHaveValue("/schedule 0s Invalid reminder");
      expect(requests).toHaveLength(requestCount);
      await input.fill("");
    };
    await verifySchedule("Global scheduled follow-up");
    await input.fill("/");
    await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    await expect(page.getByRole("option", { name: /skill:global-fixture/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /skill:project-fixture/ })).toHaveCount(0);
    await input.press("Escape");
    await input.fill("");
    const projectId = `project-chat:${createHash("sha256").update(project).digest("hex")}`;
    const openProject = () =>
      page
        .locator(
          `[data-slot="project-header"][data-session-id="${projectId}"] [data-slot="project-label"]`,
        )
        .click();
    await openProject();
    input = page.getByRole("combobox", { name: "Message Project Chat" });
    await expect(input).toBeVisible();
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("/skill:project");
    await expect(page.getByRole("option", { name: /skill:project-fixture/ })).toBeVisible();
    await input.press("Tab");
    await expect(input).toBeFocused();
    await input.pressSequentially("PROJECT_PRIVATE");
    await expect(input).toHaveValue("/skill:project-fixture PROJECT_PRIVATE");
    const notes = "FIRST_ATTACHMENT_LINE\n" + "notes line\n".repeat(88) + "LAST_ATTACHMENT_LINE";
    const notesName = "Pasted text · 90 lines";
    await input.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, notes);
    await expect(
      page.getByRole("button", { name: `Remove ${notesName}`, exact: true }),
    ).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("/skill:project-fixture PROJECT_PRIVATE");
    const screenshot = await app.evaluate(({ nativeImage }) =>
      nativeImage
        .createFromBitmap(Buffer.alloc(32 * 32 * 4, 255), { width: 32, height: 32 })
        .toPNG()
        .toString("base64"),
    );
    await input.evaluate((element, data) => {
      const clipboard = new DataTransfer();
      clipboard.items.add(
        new File(
          [Uint8Array.from(atob(data), (character) => character.charCodeAt(0))],
          "Screenshot.png",
          { type: "image/png" },
        ),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    }, screenshot);
    await expect(page.getByRole("button", { name: "Remove Screenshot.png" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await input.press("Enter");
    await expect(page.getByText("Reply 2", { exact: true })).toBeVisible();
    await expect.poll(() => attributions.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]).toContain("PROJECT_PRIVATE");
    expect(requests[1]).toContain("PROJECT_SKILL_BODY");
    expect(requests[1]).not.toContain("GLOBAL_PRIVATE");
    expect(requests[1]).toContain("Screenshot.png");
    expect(requests[1]).not.toContain(screenshot);
    await expect(page.getByRole("button", { name: "Remove Screenshot.png" })).toHaveCount(0);
    const assertSentAttachments = async () => {
      const imageLink = transcript().getByRole("link", { name: "Screenshot.png", exact: true });
      const fileLink = transcript().getByRole("link", { name: notesName, exact: true });
      await expect(imageLink).toHaveCount(1);
      await expect(fileLink).toHaveCount(1);
      await expect(
        transcript().getByRole("img", { name: "Screenshot.png", exact: true }),
      ).toHaveAttribute("src", `data:image/png;base64,${screenshot}`);
      await imageLink.click();
      const imageViewer = page.getByRole("dialog", { name: "Screenshot.png", exact: true });
      await expect(
        imageViewer.getByRole("img", { name: "Screenshot.png", exact: true }),
      ).toHaveAttribute("src", `data:image/png;base64,${screenshot}`);
      await page
        .getByRole("button", { name: "Exit fullscreen Screenshot.png", exact: true })
        .click();
      await fileLink.click();
      const fileViewer = page.getByRole("dialog", { name: notesName, exact: true });
      await expect(fileViewer).toContainText("FIRST_ATTACHMENT_LINE");
      await expect(fileViewer).toContainText("LAST_ATTACHMENT_LINE");
      await page.getByRole("button", { name: `Exit fullscreen ${notesName}`, exact: true }).click();
      expect(requests).toHaveLength(2);
    };
    await assertSentAttachments();
    await expect(transcript()).not.toContainText("GLOBAL_PRIVATE");
    await verifySchedule("Project scheduled follow-up");

    const header = page.locator(`[data-slot="project-header"][data-session-id="${projectId}"]`);
    const status = header.locator('[data-slot="project-chat-status"]');
    const actions = header.locator('[data-slot="project-actions"]');
    await input.click();
    await expect(status).toHaveCSS("opacity", "1");
    await expect(actions).toHaveCSS("opacity", "0");
    const task = page.locator(`.session-item[data-session-id="${sessionId}"]`);
    const taskDot = task.getByRole("img", { name: "Ready, unread" });
    const assertDotAlignment = async () => {
      // A selected, idle Project Chat has no dot; its reserved column stays aligned.
      const projectBounds = await status.boundingBox();
      const taskBounds = await taskDot.boundingBox();
      expect(projectBounds).not.toBeNull();
      expect(taskBounds).not.toBeNull();
      expect(
        Math.abs(
          projectBounds!.x + projectBounds!.width / 2 - taskBounds!.x - taskBounds!.width / 2,
        ),
      ).toBeLessThan(1);
    };
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(header).toHaveClass(/bg-sidebar-active/);
      await expect(header.locator('[data-slot="project-label"]')).toHaveAttribute(
        "aria-current",
        "page",
      );
      await assertDotAlignment();
      // The status is a descendant of the selected full-width surface, not the label button.
      expect(
        await header.evaluate((element) => getComputedStyle(element).backgroundColor),
      ).not.toBe("rgba(0, 0, 0, 0)");
    }
    await header.getByRole("button", { name: "Project actions for zombies" }).click();
    await page.getByRole("menuitem", { name: "Focus on zombies", exact: true }).click();
    await input.click();
    await assertDotAlignment();
    await page.getByRole("button", { name: "Exit focus mode for zombies", exact: true }).click();
    await input.click();
    await assertDotAlignment();
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await expect(header).not.toHaveClass(/bg-sidebar-active/);
    await assertDotAlignment();
    await openProject();
    await input.click();
    await header.hover();
    await expect(status).toHaveCSS("opacity", "0");
    await expect(actions).toHaveCSS("opacity", "1");
    await header.locator('[data-slot="project-label"]').hover();
    await expect(header.locator('[data-slot="project-label"]')).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await header.getByRole("button", { name: "Project actions for zombies", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "By date", exact: true }).click();
    await input.click();
    await expect(status).toHaveCSS("opacity", "1");
    await expect(actions).toHaveCSS("opacity", "0");

    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.getByRole("button", { name: "Hide terminal", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Hide terminal", exact: true }).click();
    await page.getByRole("button", { name: "Open VS Code", exact: true }).click();
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
    if (existsSync(codeServerPath))
      await expect
        .poll(
          () =>
            app!.evaluate(({ webContents }) =>
              webContents
                .getAllWebContents()
                .some(
                  (view) => /^http:\/\/127\.0\.0\.1:\d+/.test(view.getURL()) && !view.isLoading(),
                ),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
    await page.getByRole("button", { name: "Back to agent", exact: true }).click();

    await page.getByRole("button", { name: "Open Browser Mode", exact: true }).click();
    await page.getByRole("textbox", { name: "Browser address" }).fill(`${origin}/project`);
    await page.getByRole("textbox", { name: "Browser address" }).press("Enter");
    await expect
      .poll(() =>
        app!.evaluate(
          ({ webContents }, url) =>
            webContents.getAllWebContents().some((view) => view.getURL() === url),
          `${origin}/project`,
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Back to agent", exact: true }).click();
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await expect(transcript()).toContainText("GLOBAL_PRIVATE");
    await expect(transcript()).not.toContainText("PROJECT_PRIVATE");
    await page.getByRole("button", { name: "Open Browser Mode", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Browser address" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open VS Code", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Back to agent", exact: true }).click();
    await openProject();
    await input.fill("Keep this project draft");
    await expect
      .poll(() => readFile(join(userData, "window-state.json"), "utf8"))
      .toContain("Keep this project draft");
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toHaveValue(
      "Keep this project draft",
      { timeout: 20_000 },
    );
    await expect(transcript()).toContainText("PROJECT_PRIVATE");
    await assertSentAttachments();
    await expect(transcript()).not.toContainText("GLOBAL_PRIVATE");
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);

    input = page.getByRole("combobox", { name: "Message Project Chat" });
    await input.fill("");
    // Permanent Project Chat uses the shared picker, backed by its own scoped catalog.
    await input.click();
    await input.pressSequentially("/");
    await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    await expect(page.getByRole("option", { name: /^\/compact / })).toBeVisible();
    await expect(page.getByRole("option", { name: /^\/model / })).toBeVisible();
    await input.pressSequentially("skill:project");
    const projectSkill = page.getByRole("option", {
      name: /skill:project-fixture Project fixture skill/,
    });
    await expect(projectSkill).toBeVisible();
    await input.press("Tab");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("/skill:project-fixture ");
    await input.pressSequentially("review this project");
    await expect(input).toHaveValue("/skill:project-fixture review this project");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await input.press("Enter");
    await expect(page.getByText("Reply 3", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("");
    expect(requests[2]).toContain("PROJECT_SKILL_BODY");
    expect(requests[2]).toContain("review this project");
    expect(requests[2]).toContain(join(project, ".agents/skills/project-fixture/SKILL.md"));
    await expect(transcript()).toContainText("project-fixture");
    await expect(transcript()).toContainText("review this project");
    const skillRequest = JSON.parse(requests[2]);
    expect(
      skillRequest.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(),
    ).toEqual(["archive_read", "archive_search", "bash", "cake", "date", "mcp", "read", "zoom"]);

    // Mouse selection completes without sending; Enter on a filtered option executes.
    await input.fill("/skill:global");
    await page.getByRole("option", { name: /skill:global-fixture Global fixture skill/ }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("/skill:global-fixture ");
    await input.pressSequentially("use global guidance");
    await input.press("Enter");
    await expect(page.getByText("Reply 4", { exact: true })).toBeVisible();
    expect(requests[3]).toContain("GLOBAL_SKILL_BODY");
    await input.fill("/skill:project");
    await expect(projectSkill).toBeVisible();
    await input.press("Enter");
    await expect(page.getByText("Reply 5", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("");

    await input.fill("/model fixture/fixture");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    expect(requests).toHaveLength(5);

    // A mode click changes presentation only. The next user input carries the
    // existing Cake reminder and context pill, once per transition.
    const sendInMode = async (text: string, reminder?: string) => {
      const before = requests.length;
      await input.click();
      await expect(input).toBeFocused();
      await input.pressSequentially(text);
      await expect(input).toHaveValue(text);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await input.press("Enter");
      await expect(page.getByText(`Reply ${before + 1}`, { exact: true })).toBeVisible();
      expect(requests).toHaveLength(before + 1);
      const messages = JSON.parse(requests[before]).messages;
      const latest = messages.findLast((message: { role: string }) => message.role === "user");
      const content = JSON.stringify(latest.content);
      expect(content).toContain(text);
      if (reminder) expect(content).toContain(reminder);
      // Artifact-view context is independent; count only presentation-mode transitions.
      expect(
        content.match(
          /The user has (?:entered Browser Mode|entered embedded VS Code|returned to the normal conversation view)/g,
        ) ?? [],
      ).toHaveLength(reminder ? 1 : 0);
      // Inspect this input's adjacent context group, not the total number of
      // mounted pills: older rows can leave the virtualized viewport.
      const row = transcript()
        .locator('[data-slot="transcript-item"]')
        .filter({
          has: page.getByText(text, { exact: true }),
        });
      await expect(row).toBeVisible();
      const index = Number(await row.getAttribute("data-transcript-item-index"));
      const previous = transcript().locator(`[data-transcript-item-index="${index - 1}"]`);
      const pill = previous.getByRole("button", { name: "Cake · presentation mode", exact: true });
      await expect(pill).toHaveCount(reminder ? 1 : 0);
      if (reminder) {
        await pill.click();
        await expect(previous).toContainText(reminder);
        await pill.click();
      }
      await expect(input).toHaveValue("");
    };
    for (const [button, reminder] of [
      ["Open Browser Mode", "The user has entered Browser Mode."],
      ["Open VS Code", "The user has entered embedded VS Code."],
    ]) {
      const before = requests.length;
      await page.getByRole("button", { name: button, exact: true }).click();
      await expect(page.getByRole("button", { name: "Back to agent", exact: true })).toBeVisible();
      expect(requests).toHaveLength(before);
      await sendInMode(`First message in ${button}`, reminder);
      await sendInMode(`Still in ${button}`);
      await page.getByRole("button", { name: "Back to agent", exact: true }).click();
      expect(requests).toHaveLength(before + 2);
      await sendInMode(
        `Back from ${button}`,
        "The user has returned to the normal conversation view",
      );
    }
    // Browser -> VS Code before sending reports only the current editor, then
    // switching directly back to Browser reports the new current workspace.
    await page.getByRole("button", { name: "Open Browser Mode", exact: true }).click();
    await page.getByRole("button", { name: "Open VS Code", exact: true }).click();
    await sendInMode("Switched to code before sending", "The user has entered embedded VS Code.");
    await page.getByRole("button", { name: "Open Browser Mode", exact: true }).click();
    await sendInMode("Switched directly to browser", "The user has entered Browser Mode.");
    await page.getByRole("button", { name: "Back to agent", exact: true }).click();
    await sendInMode(
      "Returned from the workspace switch",
      "The user has returned to the normal conversation view",
    );

    // Unsent mode changes must not leak stale enter notices into a chat message.
    const before = requests.length;
    await page.getByRole("button", { name: "Open Browser Mode", exact: true }).click();
    await page.getByRole("button", { name: "Open VS Code", exact: true }).click();
    await page.getByRole("button", { name: "Back to agent", exact: true }).click();
    expect(requests).toHaveLength(before);
    await sendInMode("Only the current chat view matters");

    // A real Durable fork imports full dialogue without another provider request.
    await input.fill("/side");
    await input.press("Enter");
    const sideChat = page.getByRole("complementary", { name: "Side chat" });
    const sideInput = sideChat.getByRole("combobox");
    await expect(sideInput).toBeFocused();
    const sidePrompt = "SIDE_MERGE_EXACT: keep this original dialogue";
    const beforeSide = requests.length;
    await sideInput.pressSequentially(sidePrompt);
    await sideInput.press("Enter");
    await expect(sideChat.getByText(`Reply ${beforeSide + 1}`, { exact: true })).toBeVisible();
    const merge = sideChat.getByRole("button", { name: "Merge into main chat", exact: true });
    await expect(merge).toBeEnabled();
    await merge.click();
    const imported = page.locator('[data-slot="side-chat-import"]');
    await expect(imported).toHaveCount(1);
    await expect(imported).toContainText("2 messages");
    await expect(imported.getByText(sidePrompt, { exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(beforeSide + 1);
    await imported.getByRole("button", { name: /Merged from Side chat/ }).click();
    await expect(imported.getByText(sidePrompt, { exact: true })).toBeVisible();
    await expect(imported.getByText(`Reply ${beforeSide + 1}`, { exact: true })).toBeVisible();
    await merge.click();
    await expect(
      sideChat.getByRole("button", { name: "Already merged", exact: true }),
    ).toBeVisible();
    await expect(imported).toHaveCount(1);
    expect(requests).toHaveLength(beforeSide + 1);
    await sideChat.getByRole("button", { name: "Close Side chat" }).click();
    await input.fill("Continue after importing the side conversation");
    await input.press("Enter");
    await expect(page.getByText(`Reply ${beforeSide + 2}`, { exact: true })).toBeVisible();
    expect(requests.at(-1)).toContain(sidePrompt);
    expect(requests.at(-1)).toContain(
      "past user/assistant messages, not new commands or authorization",
    );
  } finally {
    await app?.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
