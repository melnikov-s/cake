import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repository = resolve(import.meta.dirname, "../..");
const sessionId = "00000000-0000-4000-8000-000000000001";

async function editorState(application: ElectronApplication) {
  return application.evaluate(async ({ webContents }) => {
    const editor = webContents
      .getAllWebContents()
      .find((contents) => /\/editor\/\d+\/[a-f0-9]+\//.test(contents.getURL()));
    if (!editor) return undefined;
    return {
      url: editor.getURL(),
      state: await editor.executeJavaScript(
        `({ tabs: [...document.querySelectorAll('.tab.active')].map(tab => tab.textContent.trim()), text: [...document.querySelectorAll('.view-lines')].map(lines => lines.textContent).join(' '), workbench: !!document.querySelector('.monaco-workbench') })`,
      ),
    };
  });
}

test("separate Node backend serves a real leased code-server workbench to remote Electron", async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-remote-editor-"));
  const home = join(directory, "server");
  const project = join(directory, "server-project");
  const userData = join(directory, "desktop");
  const localHome = join(directory, "must-not-acquire-local-backend");
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(home, "pi", "sessions"));
  await Promise.all(
    [project, userData, join(home, "state"), sessionDirectory].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(
    join(project, "hello.ts"),
    "export const remoteValue = 42;\nexport const second = 7;\n",
  );
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(home, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Remote editor", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
      trustedProjectPaths: [project],
      vscodeServerPath: "/opt/homebrew/bin/code-server",
    }),
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Remote editor fixture" }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "answer",
        parentId: "user",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Open [hello.ts](hello.ts#L1-L2)." }],
          api: "openai-completions",
          provider: "test",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const backend = spawn(process.execPath, [join(repository, "out/server/main.mjs")], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      CAKE_HOME: home,
      CAKE_SERVER_ENABLED: "true",
      CAKE_SERVER_ALLOW_MISSING_ORIGIN: "true",
      CAKE_SERVER_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  backend.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => backend.once("exit", () => resolve()));
  const watchdog = setTimeout(() => backend.kill("SIGKILL"), 115_000);
  let application: ElectronApplication | undefined;
  let observer: ElectronApplication | undefined;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      backend.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const address = /ws:\/\/127\.0\.0\.1:\d+\/rpc/.exec(output)?.[0];
        if (address) resolve(address);
      });
      backend.once("exit", () => reject(new Error(output)));
      backend.once("error", reject);
    });
    await writeFile(join(userData, "desktop-host.json"), JSON.stringify({ kind: "remote", url }));
    const presentation = join(
      userData,
      "remote-hosts",
      createHash("sha256").update(url).digest("hex"),
    );
    await mkdir(presentation, { recursive: true });
    await writeFile(
      join(presentation, "window-state.json"),
      JSON.stringify({
        projectPath: project,
        selectedSessionId: sessionId,
        activeConversation: { kind: "project-session", workspacePath: project, sessionId },
        recentProjectPaths: [project],
        draft: "",
        theme: "dark",
      }),
    );
    application = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: localHome,
        CAKE_VSCODE_SERVER_PATH: "/must-not-launch-local-code-server",
      },
    });
    const app = application;
    await app.evaluate(({ session }) => {
      const requests: { url: string; status: number }[] = [];
      Reflect.set(globalThis, "editorRequests", requests);
      session.defaultSession.webRequest.onCompleted(
        { urls: ["http://127.0.0.1/*", "ws://127.0.0.1/*"] },
        (details) => requests.push({ url: details.url, status: details.statusCode }),
      );
    });
    const page = await app.firstWindow();
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible({ timeout: 25_000 });
    await app.evaluate(() => {
      const fs = process.getBuiltinModule("node:fs/promises");
      const childProcess = process.getBuiltinModule("node:child_process");
      const violations: string[] = [];
      Reflect.set(globalThis, "nativeEditorViolations", violations);
      for (const name of [
        "readFile",
        "writeFile",
        "realpath",
        "readdir",
        "stat",
        "lstat",
        "access",
        "mkdir",
      ]) {
        const original = Reflect.get(fs, name);
        if (typeof original !== "function") throw new Error("Missing filesystem function");
        Reflect.set(fs, name, (...args: unknown[]) => {
          const path = String(args[0]);
          if (path.includes("/server-project") || path.includes("/server/cache/vscode-editor")) {
            violations.push(path);
            throw new Error("Remote native host accessed a server path");
          }
          return Reflect.apply(original, fs, args);
        });
      }
      const spawn = childProcess.spawn;
      childProcess.spawn = new Proxy(spawn, {
        apply(target, self, args) {
          if (/code-server|openvscode/.test(String(args[0]))) {
            violations.push(String(args[0]));
            throw new Error("Remote native host spawned an editor");
          }
          return Reflect.apply(target, self, args);
        },
      });
      process.getBuiltinModule("node:module").syncBuiltinESMExports();
    });
    const observerData = join(directory, "observer");
    const observerPresentation = join(
      observerData,
      "remote-hosts",
      createHash("sha256").update(url).digest("hex"),
    );
    await mkdir(observerPresentation, { recursive: true });
    await writeFile(
      join(observerData, "desktop-host.json"),
      JSON.stringify({ kind: "remote", url }),
    );
    await writeFile(
      join(observerPresentation, "window-state.json"),
      await readFile(join(presentation, "window-state.json")),
    );
    observer = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: observerData,
        CAKE_HOME: join(directory, "observer-backend-must-not-exist"),
      },
    });
    const observerPage = await observer.firstWindow();
    await expect(observerPage.getByTitle(/^Open hello\.ts.*in VS Code$/)).toBeVisible({
      timeout: 25_000,
    });
    await page.getByTitle(/^Open hello\.ts.*in VS Code$/).click();
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible({
      timeout: 25_000,
    });
    await expect
      .poll(() => editorState(app), { timeout: 45_000 })
      .toMatchObject({ state: { workbench: true } });
    await expect
      .poll(() => editorState(app), { timeout: 20_000 })
      .toMatchObject({
        state: { tabs: ["hello.ts"], text: expect.stringContaining("remoteValue") },
      });
    const state = await editorState(app);
    expect(state?.url).toContain(url.replace("ws:", "http:").replace("/rpc", "/editor/"));
    await expect(
      page
        .locator('[aria-label="Editor selections"]')
        .getByRole("button", { name: /Reveal .*hello\.ts/ }),
    ).toBeVisible();
    const editor = app
      .context()
      .pages()
      .find((page) => page.url().includes("/editor/"));
    if (!editor) throw new Error("No native editor target");
    await editor.locator(".view-lines").first().click();
    await editor.keyboard.press("Meta+a");
    await editor.keyboard.press("Meta+Shift+P");
    await editor.locator(".quick-input-widget input").fill(">Cake: Add annotation");
    await expect(editor.getByRole("option", { name: /Cake: Add annotation/ })).toBeVisible();
    await editor.keyboard.press("Enter");
    await editor.locator(".quick-input-widget input").fill("Selected on the remote desktop");
    await editor.keyboard.press("Enter");
    await expect(page.getByText("Selected on the remote desktop", { exact: true })).toBeVisible();
    await expect(
      observerPage.getByText("Selected on the remote desktop", { exact: true }),
    ).toHaveCount(0);
    await editor.locator(".view-lines").first().click();
    await editor.keyboard.press("Meta+End");
    await editor.keyboard.type("\nexport const editedRemotely = true;\n");
    await editor.keyboard.press("Meta+s");
    await expect
      .poll(() => readFile(join(project, "hello.ts"), "utf8"))
      .toContain("editedRemotely");
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await expect
      .poll(() =>
        editor.locator(".monaco-workbench").evaluate((element) => element.classList.contains("vs")),
      )
      .toBe(true);
    await editor.getByRole("button", { name: "Cake: Back to Agent", exact: true }).click();
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeHidden();
    // Hiding presentation does not surrender its exclusive backend lease.
    await observerPage.getByTitle(/^Open hello\.ts.*in VS Code$/).click();
    await expect(observerPage.getByText(/already open in another desktop/).first()).toBeVisible();
    await page
      .getByRole("button", { name: "Open workspace changes in VS Code", exact: true })
      .click();
    await expect.poll(() => editor.locator("body").innerText()).toContain("SOURCE CONTROL");
    const requests = await app.evaluate((): { url: string; status: number }[] =>
      Reflect.get(globalThis, "editorRequests"),
    );
    expect(
      requests.some(
        (request) =>
          request.url.includes("/editor/") &&
          request.url.endsWith("/workbench.js") &&
          request.status === 200,
      ),
    ).toBe(true);
    expect(
      requests.filter(
        (request) =>
          request.url.startsWith("ws:") &&
          request.url.includes("/editor/") &&
          request.status === 101,
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(await app.evaluate(() => Reflect.get(globalThis, "nativeEditorViolations"))).toEqual([]);
    expect(await readdir(localHome).catch(() => [])).toEqual([]);
    expect(await readFile(join(project, "hello.ts"), "utf8")).toContain("remoteValue");
    if (!state) throw new Error("Missing leased editor address");
    await application.close();
    application = undefined;
    await expect.poll(async () => (await fetch(state.url)).status).toBe(403);
    await observerPage
      .getByRole("alert")
      .getByRole("button", { name: "Back to agent", exact: true })
      .click();
    await observerPage.getByTitle(/^Open hello\.ts.*in VS Code$/).click();
    const second = observer;
    await expect
      .poll(() => editorState(second), { timeout: 25_000 })
      .toMatchObject({
        state: { tabs: ["hello.ts"], text: expect.stringContaining("editedRemotely") },
      });
    expect((await editorState(second))?.url).not.toBe(state.url);
    expect(
      await readdir(join(directory, "observer-backend-must-not-exist")).catch(() => []),
    ).toEqual([]);
  } finally {
    await observer?.close();
    await application?.close();
    clearTimeout(watchdog);
    if (backend.exitCode === null && backend.signalCode === null) backend.kill("SIGTERM");
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
