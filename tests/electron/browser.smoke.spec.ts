import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const sessionId = "browser-smoke-session";

test("Browser Mode embeds persistent Chromium, navigates, and attaches inspected elements", async () => {
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
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Open Browser Mode" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("main#seeded", { exact: true })).toBeVisible();
    await expect(page.getByText(/cake-browser-attachment/)).toHaveCount(0);
    await page.getByRole("button", { name: "Open Browser Mode" }).click();
    const addressInput = page.getByLabel("Browser address");
    await expect(addressInput).toBeVisible();
    await addressInput.fill(origin);
    await addressInput.press("Enter");

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
  } finally {
    await application.close();
    server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
