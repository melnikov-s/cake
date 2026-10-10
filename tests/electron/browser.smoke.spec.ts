import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const sessionId = "browser-smoke-session";
const otherSessionId = "browser-smoke-other-session";

test("Browser Mode embeds persistent Chromium, navigates, and attaches inspected elements", async () => {
  test.setTimeout(60_000);
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      `<!doctype html><html><head><title>${request.url === "/second" ? "Second page" : "Local app"}</title></head><body><main><button id="target">Save changes</button></main><script>document.cookie = "cakeBrowser=ready; path=/"</script></body></html>`,
    );
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Browser fixture server did not bind");
  const origin = `http://127.0.0.1:${address.port}`;

  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-browser-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
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
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
      draftsBySession: {},
    }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      trustedProjectPaths: [],
    }),
  );
  const persistedBrowserContext = `<cake-browser-attachment>${JSON.stringify({
    kind: "browser",
    name: "main#seeded",
    url: `${origin}/`,
    tagName: "main",
    selector: "main#seeded",
    outerHTML: '<main id="seeded">Fixture</main>',
    text: "Fixture",
  })}</cake-browser-attachment>`;
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
          content: [{ type: "text", text: `Test the app\n\n${persistedBrowserContext}` }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "| Layer | Status |\n| - | - |\n| Browser | **Running** |",
                "The browser keeps running while fullscreen content is displayed. ".repeat(12),
              ].join("\n\n"),
            },
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

  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-01-000Z_${otherSessionId}.jsonl`),
    [
      { type: "session", version: 3, id: otherSessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "other-user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Other browser fixture" }],
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
    await expect(page.getByRole("button", { name: "Open Browser Mode" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("main#seeded", { exact: true })).toBeVisible();
    await expect(page.getByText(/cake-browser-attachment/)).toHaveCount(0);
    // Warm both sessions so switching exercises the synchronous hydrated-session path.
    await page.locator(`.session-item[data-session-id="${otherSessionId}"]`).click();
    await expect(page.locator(".transcript").getByText("Other browser fixture")).toBeVisible();
    await page.locator(`.session-item[data-session-id="${sessionId}"]`).click();
    await expect(page.locator(".transcript").getByText("Test the app")).toBeVisible();
    await page.getByRole("button", { name: "Open Browser Mode" }).click();
    const addressInput = page.getByLabel("Browser address");
    await expect(addressInput).toBeVisible();
    await addressInput.fill(origin);
    await addressInput.press("Enter");

    const workspace = page.getByRole("region", { name: "Browser workspace", exact: true });
    const chatToggle = workspace.locator('[data-slot="header-chat-toggle"]');
    const sidebarToggle = workspace.locator('[data-slot="header-sidebar-toggle"]');
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(chatToggle).toHaveAccessibleName("Close chat");
    await chatToggle.click();
    await expect(composer).toBeHidden();
    await expect(chatToggle).toHaveAccessibleName("Open chat");
    await expect(chatToggle).toHaveAttribute("aria-expanded", "false");
    await chatToggle.click();
    await expect(composer).toBeVisible();
    await expect(sidebarToggle).toBeHidden();
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await expect(page.locator(`.session-item[data-session-id="${sessionId}"]`)).toBeHidden();
    await expect(sidebarToggle).toHaveAccessibleName("Open sidebar");
    expect((await sidebarToggle.boundingBox())?.x).toBeGreaterThanOrEqual(84);
    await sidebarToggle.click();
    await expect(page.locator(`.session-item[data-session-id="${sessionId}"]`)).toBeVisible();
    await expect(sidebarToggle).toBeHidden();
    await expect(page.getByRole("button", { name: "Toggle sidebar", exact: true })).toBeVisible();

    const browserState = (url: string) => () =>
      application.evaluate(async ({ webContents }, expectedUrl) => {
        const contents = webContents
          .getAllWebContents()
          .find((candidate) => candidate.getURL() === expectedUrl);
        if (!contents) return undefined;
        return contents.executeJavaScript(
          `({ title: document.title, cookie: document.cookie, text: document.querySelector("#target")?.textContent })`,
        );
      }, url);
    await expect.poll(browserState(`${origin}/`), { timeout: 20_000 }).toEqual({
      title: "Local app",
      cookie: "cakeBrowser=ready",
      text: "Save changes",
    });

    await addressInput.fill(`${origin}/second`);
    await addressInput.press("Enter");
    await expect.poll(browserState(`${origin}/second`)).toMatchObject({ title: "Second page" });

    const toggleTerminal = () =>
      application.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()
          ?.items.flatMap((entry) => entry.submenu?.items ?? [])
          .find((entry) => entry.label === "Toggle Terminal");
        if (!item) throw new Error("Toggle Terminal menu item missing");
        item.click({}, undefined);
      });
    const nativeBrowserBounds = () =>
      application.evaluate(({ BrowserWindow }, expectedUrl) => {
        const window = BrowserWindow.getAllWindows()[0];
        return window.contentView.children
          .find((child) => "webContents" in child && child.webContents.getURL() === expectedUrl)
          ?.getBounds();
      }, `${origin}/second`);
    const originalBounds = await nativeBrowserBounds();
    expect(originalBounds).toBeTruthy();
    const terminal = page.locator('section[aria-label="Terminal"]');
    const assertTerminalClearance = () =>
      expect
        .poll(async () => {
          const bounds = (await terminal.boundingBox())!;
          return (await nativeBrowserBounds())!.y - bounds.y - bounds.height;
        })
        .toBeGreaterThanOrEqual(0);
    await toggleTerminal();
    await expect(terminal).toHaveAttribute("aria-hidden", "false");
    await assertTerminalClearance();
    await terminal.locator(".xterm-screen:visible").click();
    await page.keyboard.type("printf CAKE_TERMINAL_ABOVE_BROWSER");
    await page.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows:visible")).toContainText(
      "CAKE_TERMINAL_ABOVE_BROWSER",
    );
    const resize = page.getByRole("separator", { name: "Resize terminal" });
    await resize.focus();
    await page.keyboard.press("ArrowDown");
    await expect(resize).toHaveAttribute("aria-valuenow", "376");
    await assertTerminalClearance();
    await terminal.getByRole("button", { name: "Pin terminal to bottom" }).click();
    await expect
      .poll(async () => {
        const browser = (await nativeBrowserBounds())!;
        return browser.y + browser.height - (await terminal.boundingBox())!.y;
      })
      .toBeLessThanOrEqual(1);
    await terminal.getByRole("button", { name: "Move terminal to top" }).click();
    await assertTerminalClearance();
    await toggleTerminal();
    await expect.poll(nativeBrowserBounds).toEqual(originalBounds);
    await expect.poll(browserState(`${origin}/second`)).toMatchObject({
      title: "Second page",
      cookie: "cakeBrowser=ready",
    });

    const inspect = page.getByRole("button", { name: "Select an element" });
    await inspect.click();
    await expect(inspect).toHaveAttribute("aria-pressed", "true");

    const target = await application.evaluate(async ({ webContents }, expectedUrl) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === expectedUrl);
      if (!contents) throw new Error("Browser contents not found");
      return contents.executeJavaScript(`(() => {
        const rect = document.querySelector("#target")?.getBoundingClientRect();
        return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : undefined;
      })()`);
    }, `${origin}/second`);
    if (!target) throw new Error("Browser target has no bounds");
    await application.evaluate(
      ({ webContents }, input: { expectedUrl: string; target: { x: number; y: number } }) => {
        const contents = webContents
          .getAllWebContents()
          .find((candidate) => candidate.getURL() === input.expectedUrl);
        if (!contents) throw new Error("Browser contents not found");
        contents.sendInputEvent({ type: "mouseMove", ...input.target });
        contents.sendInputEvent({
          type: "mouseDown",
          button: "left",
          clickCount: 1,
          ...input.target,
        });
        contents.sendInputEvent({
          type: "mouseUp",
          button: "left",
          clickCount: 1,
          ...input.target,
        });
      },
      { expectedUrl: `${origin}/second`, target },
    );

    await expect(inspect).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.locator(".workbench-composer").getByRole("button", { name: /#target/ }),
    ).toBeVisible();
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();

    const nativeBrowserVisible = () =>
      application.evaluate(({ BrowserWindow }, expectedUrl) => {
        const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find(
          (child) => "webContents" in child && child.webContents.getURL() === expectedUrl,
        );
        return view?.getVisible() ?? false;
      }, `${origin}/second`);
    await expect.poll(nativeBrowserVisible).toBe(true);
    const table = page.locator('.transcript [data-streamdown="table-wrapper"]');
    await table.getByRole("button", { name: "View table fullscreen" }).click({ force: true });
    const tableFullscreen = page.getByRole("dialog", { name: "Table", exact: true });
    await expect(tableFullscreen).toBeVisible();
    await expect.poll(nativeBrowserVisible).toBe(false);
    await page.keyboard.press("Escape");
    await expect(tableFullscreen).toHaveCount(0);
    await expect.poll(nativeBrowserVisible).toBe(true);
    await page.getByRole("button", { name: "View response fullscreen" }).click({ force: true });
    const reader = page.getByRole("dialog", { name: "Cake", exact: true });
    await expect(reader).toBeVisible();
    await expect.poll(nativeBrowserVisible).toBe(false);
    await reader.getByRole("button", { name: "View table fullscreen" }).click({ force: true });
    await expect(tableFullscreen).toBeVisible();
    await expect(tableFullscreen.locator('[data-streamdown="strong"]')).toHaveText("Running");
    expect(
      await tableFullscreen.evaluate((surface) => {
        const element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        return Boolean(element && surface.contains(element));
      }),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(tableFullscreen).toHaveCount(0);
    await expect(reader).toBeVisible();
    await expect.poll(nativeBrowserVisible).toBe(false);
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
    await expect.poll(nativeBrowserVisible).toBe(true);
    await expect.poll(nativeBrowserBounds).toEqual(originalBounds);

    await page.locator(`.session-item[data-session-id="${otherSessionId}"]`).click();
    await expect(page.locator(".transcript").getByText("Other browser fixture")).toBeVisible();
    await expect(addressInput).toBeHidden();
    await expect.poll(nativeBrowserVisible).toBe(false);
    await page.locator(`.session-item[data-session-id="${sessionId}"]`).click();
    await expect(addressInput).toBeVisible();
    await expect.poll(nativeBrowserVisible).toBe(true);

    // Local desktop mode intentionally permits explicitly reopening the same session in another
    // native window; the new owner can then navigate the transferred view.
    await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.flatMap((entry) => entry.submenu?.items ?? [])
        .find((entry) => entry.label === "New Cake Window");
      if (!item) throw new Error("New Cake Window menu item missing");
      item.click({}, undefined);
    });
    await expect.poll(() => application.windows().length).toBe(3);
    const second = application
      .windows()
      .find((window) => window !== page && window.url().includes("index.html"));
    if (!second) throw new Error("Second desktop window missing");
    await expect(second.locator(".transcript").getByText("Test the app")).toBeVisible();
    const secondAddress = second.getByLabel("Browser address");
    if (!(await secondAddress.isVisible()))
      await second.getByRole("button", { name: "Open Browser Mode" }).click();
    await expect(secondAddress).toBeVisible();
    await secondAddress.fill(origin);
    await secondAddress.press("Enter");
    await expect.poll(browserState(`${origin}/`)).toMatchObject({ title: "Local app" });
  } finally {
    await application.close();
    server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
