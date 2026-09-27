import { Effect } from "effect";
import { connectClient } from "../integration/fixtures/network-client";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("remote Electron uses the full shell and only the server owns agent state", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-remote-desktop-"));
  const userData = join(directory, "desktop");
  const localHome = join(directory, "local-backend-must-not-exist");
  const home = join(directory, "server");
  const project = join(directory, "server-project");
  const id = "00000000-0000-4000-8000-000000000001";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(home, "pi", "sessions"));
  const responses: ServerResponse[] = [];
  const providerRequests: string[] = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => providerRequests.push(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    responses.push(response);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  await Promise.all(
    [userData, project, sessionDirectory, join(home, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const selectedLaptopFile = join(directory, "selected-on-desktop.txt");
  await writeFile(selectedLaptopFile, "DESKTOP_FILE_BYTES_ONLY");
  await writeFile(
    join(home, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "fixture-provider": {
          name: "Remote fixture",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Remote model",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 4096,
              maxTokens: 1024,
            },
            {
              id: "fixture-alternate",
              name: "Remote alternate",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 4096,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(home, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Remote project", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
      trustedProjectPaths: [project],
    }),
  );
  const transcript = join(sessionDirectory, `1970-01-01T00-00-00-000Z_${id}.jsonl`);
  await writeFile(
    transcript,
    [
      { type: "session", version: 3, id, timestamp, cwd: project },
      {
        type: "model_change",
        id: "model",
        parentId: null,
        timestamp,
        provider: "fixture-provider",
        modelId: "fixture-model",
      },
      {
        type: "message",
        id: "user-entry",
        parentId: "model",
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Existing remote transcript" }],
          timestamp: 0,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const server = spawn(process.execPath, [join(repositoryRoot, "out/server/main.mjs")], {
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
  server.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const serverExit = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  const timeout = setTimeout(() => server.kill("SIGKILL"), 85_000);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      server.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const url = /ws:\/\/127\.0\.0\.1:\d+\/rpc/.exec(output)?.[0];
        if (url) resolve(url);
      });
      server.once("exit", () => reject(new Error(output)));
      server.once("error", reject);
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
        selectedSessionId: id,
        activeConversation: { kind: "project-session", workspacePath: project, sessionId: id },
        recentProjectPaths: [project],
        draft: "",
      }),
    );
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: localHome,
      },
    });
    try {
      const page = await application.firstWindow();
      page.setDefaultTimeout(15_000);
      await page.addInitScript(() => {
        const send = WebSocket.prototype.send;
        const subscribe = WebSocket.prototype.addEventListener;
        const unsubscribe = WebSocket.prototype.removeEventListener;
        const listeners = new WeakMap<EventListenerOrEventListenerObject, EventListener>();
        let pending: string | undefined;
        WebSocket.prototype.send = function (data) {
          if (typeof data === "string") {
            const request = JSON.parse(data);
            if (
              Reflect.get(window, "dropNextPromptReceipt") &&
              request._tag === "Request" &&
              request.tag === "sessionChats.prompt"
            )
              pending = String(request.id);
          }
          send.call(this, data);
        };
        WebSocket.prototype.addEventListener = function (type, listener, options) {
          if (type !== "message" || !listener) return subscribe.call(this, type, listener, options);
          const wrapped: EventListener = (event) => {
            const message = JSON.parse((event as MessageEvent).data);
            if (pending && message._tag === "Exit" && String(message.requestId) === pending) {
              pending = undefined;
              Reflect.set(window, "dropNextPromptReceipt", false);
              this.close();
              return;
            }
            if (typeof listener === "function") listener.call(this, event);
            else listener.handleEvent(event);
          };
          listeners.set(listener, wrapped);
          subscribe.call(this, type, wrapped, options);
        };
        WebSocket.prototype.removeEventListener = function (type, listener, options) {
          unsubscribe.call(
            this,
            type,
            listener ? (listeners.get(listener) ?? listener) : listener,
            options,
          );
        };
      });
      await page.reload();
      await expect(
        page.locator(".transcript").getByText("Existing remote transcript", { exact: true }),
      ).toBeVisible({ timeout: 25_000 });
      await expect(page.getByText(`Remote: ${url}`, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Model configuration", exact: true }).click();
      await page.getByRole("button", { name: "Change model", exact: true }).click();
      await page
        .getByRole("button", { name: "Remote alternate fixture-alternate", exact: true })
        .click();
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Model configuration", exact: true }),
      ).toContainText("Remote alternate");
      await expect
        .poll(() => readFile(transcript, "utf8"))
        .toContain('"modelId":"fixture-alternate"');
      const input = page.getByRole("combobox", { name: "Message", exact: true });
      await input.click();
      await input.pressSequentially("Remote milestone prompt");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Remote milestone prompt");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => responses.length).toBeGreaterThan(0);
      responses[0]!.write(
        `data: ${JSON.stringify({ id: "remote", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: { content: "Streaming from the server" }, finish_reason: null }] })}\n\n`,
      );
      await expect(
        page.locator(".transcript").getByText("Streaming from the server", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(input).toBeEnabled();
      await expect.poll(() => readFile(transcript, "utf8")).toContain("Remote milestone prompt");
      await expect(readdir(localHome)).rejects.toThrow();
      await expect(readdir(join(userData, "remote-hosts"))).resolves.toEqual([
        createHash("sha256").update(url).digest("hex"),
      ]);
      await expect(readdir(home)).resolves.not.toContain("window-state.json");
      // A native menu event reaches the local host, while the PTY and its cwd are on the server.
      const toggleTerminal = () =>
        application.evaluate(({ Menu }) => {
          const item = Menu.getApplicationMenu()
            ?.items.flatMap((entry) => entry.submenu?.items ?? [])
            .find((entry) => entry.label === "Toggle Terminal");
          if (!item) throw new Error("Missing native terminal menu");
          item.click({}, undefined);
        });
      await toggleTerminal();
      const panel = page.locator('section[aria-label="Terminal"]');
      await expect(panel).toHaveAttribute("aria-hidden", "false");
      await panel.locator(".xterm-screen:visible").click();
      await page.keyboard.type("pwd; printf REMOTE_PTY > remote-pty-proof.txt");
      await page.keyboard.press("Enter");
      await expect
        .poll(() => readFile(join(project, "remote-pty-proof.txt"), "utf8"))
        .toBe("REMOTE_PTY");
      await toggleTerminal();
      await page.getByRole("button", { name: "Open Cake Draw", exact: true }).click();
      await expect(page.getByRole("region", { name: "Cake Draw whiteboard" })).toBeVisible();
      await expect
        .poll(() => readdir(join(home, "state", "draw-boards", "boards")))
        .toHaveLength(1);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* connectClient(url);
            const [board] = yield* client["draw.list"]({ sessionId: id });
            if (!board) throw new Error("Missing remote Draw board");
            const target = { sessionId: id, boardId: board.id };
            const saved = yield* client["draw.save"]({
              ...target,
              expectedRevision: board.revision,
              snapshot: { elements: [] },
            });
            expect(saved.revision).toBe(board.revision + 1);
            const conflict = yield* client["draw.save"]({
              ...target,
              expectedRevision: board.revision,
              snapshot: {},
            }).pipe(Effect.flip);
            expect(conflict).toMatchObject({ _tag: "DrawBoardError", code: "revision-conflict" });
            const current = yield* client["draw.read"](target);
            expect(current.snapshot).toEqual({ elements: [] });
          }),
        ),
      );
      await page.getByRole("button", { name: "Back to agent", exact: true }).click();
      await expect(input).toBeVisible();
      // Drop only the accepted prompt receipt. The server keeps the turn; the client never replays it.
      await page.evaluate(() => Reflect.set(window, "dropNextPromptReceipt", true));
      await input.fill("Lost receipt remote prompt");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByText(/Delivery uncertain/)).toBeVisible();
      await expect(page.getByText(`Remote: ${url}`, { exact: true })).toBeVisible();
      await expect(input).toHaveValue("Lost receipt remote prompt");
      await expect
        .poll(
          async () =>
            (await readFile(transcript, "utf8")).split("Lost receipt remote prompt").length - 1,
        )
        .toBe(1);
      await expect(
        page.locator(".transcript").getByText("Lost receipt remote prompt", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "I checked the server state", exact: true }).click();
      await input.fill("");
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(readdir(localHome)).rejects.toThrow();
      // The real Pi tool boundary asks a structured question; its answer stays on the server.
      await input.fill("Ask a remote question");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => responses.length).toBeGreaterThanOrEqual(3);
      const question = {
        command: "interview.open",
        input: {
          request: {
            protocol: "cake.request/v1",
            id: "remote-question",
            title: "Remote question",
            responseSchema: { type: "object", properties: { answer: { type: "string" } } },
            view: {
              type: "form",
              fields: [{ id: "answer", type: "text", label: "Remote answer" }],
            },
            fallback: { markdown: "Choose a remote answer" },
          },
        },
      };
      responses[2]!.write(
        `data: ${JSON.stringify({ id: "question", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-question", type: "function", function: { name: "cake", arguments: JSON.stringify(question) } }] }, finish_reason: null }] })}\n\n`,
      );
      responses[2]!.end(
        `data: ${JSON.stringify({ id: "question", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
      await page.getByLabel("Remote answer", { exact: true }).fill("Server-side answer");
      await page.getByRole("button", { name: "Submit", exact: true }).click();
      await expect.poll(() => responses.length).toBeGreaterThanOrEqual(4);
      responses[3]!.write(
        `data: ${JSON.stringify({ id: "answer", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: { content: "[Device link](https://example.com/remote)" }, finish_reason: null }] })}\n\n`,
      );
      responses[3]!.end(
        `data: ${JSON.stringify({ id: "answer", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      await expect.poll(() => readFile(transcript, "utf8")).toContain("Server-side answer");
      await application.evaluate(({ shell }) => {
        Object.defineProperty(shell, "openExternal", {
          configurable: true,
          value: async (url: string) => {
            Reflect.set(globalThis, "openedOnDevice", url);
          },
        });
      });
      await page.getByRole("link", { name: "Device link", exact: true }).click();
      await expect
        .poll(() => application.evaluate(() => Reflect.get(globalThis, "openedOnDevice")))
        .toBe("https://example.com/remote");
      // A native composer menu must not infer remote utility-model availability from local state.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* connectClient(url);
            yield* client["workspaces.set-utility-model"]({
              model: {
                provider: "fixture-provider",
                modelId: "fixture-model",
                thinkingLevel: "off",
              },
            });
          }),
        ),
      );
      await application.evaluate(({ Menu }) => {
        const popup = Menu.prototype.popup;
        Menu.prototype.popup = function (options) {
          const reword = this.items.find((item) => item.label === "Reword");
          if (!reword) return popup.call(this, options);
          Reflect.set(globalThis, "remoteRewordEnabled", reword.enabled);
          if (reword.enabled) reword.click({}, undefined);
          options?.callback?.();
        };
      });
      await input.fill("Rewrite remote selection");
      await input.evaluate((element: HTMLTextAreaElement) => element.select());
      await input.click({ button: "right" });
      await expect
        .poll(() => application.evaluate(() => Reflect.get(globalThis, "remoteRewordEnabled")))
        .toBe(true);
      await expect.poll(() => responses.length).toBeGreaterThanOrEqual(5);
      responses[4]!.end(
        `data: ${JSON.stringify({ id: "reword", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: { content: "Remote rewrite" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "reword", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      await expect(input).toHaveValue("Remote rewrite");
      await expect(input).toBeFocused();
      // The native chooser grants only this device's selected bytes; the backend
      // receives an upload token, then materializes an accepted, server-owned path.
      await application.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
      }, selectedLaptopFile);
      await input.fill("Read selected file");
      await page.getByRole("button", { name: "Attach files" }).click();
      await expect(page.getByText("@ selected-on-desktop.txt")).toBeVisible();
      await expect(input).toHaveValue("Read selected file");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => responses.length).toBeGreaterThanOrEqual(6);
      await expect
        .poll(() => readdir(join(home, "state", "attachments", "accepted")))
        .toHaveLength(1);
      const [materialized] = await readdir(join(home, "state", "attachments", "accepted"));
      expect(
        await readFile(
          join(home, "state", "attachments", "accepted", materialized!, "selected-on-desktop.txt"),
          "utf8",
        ),
      ).toBe("DESKTOP_FILE_BYTES_ONLY");
      await expect.poll(() => providerRequests.length).toBeGreaterThanOrEqual(6);
      expect(providerRequests[5]).toContain(materialized!);
      // Pi's file attachment contract is an @server-path mention, not inline
      // bytes. Drive the real Pi read tool and prove provider receives the bytes.
      const serverAttachmentPath = join(
        home,
        "state",
        "attachments",
        "accepted",
        materialized!,
        "selected-on-desktop.txt",
      );
      responses[5]!.write(
        `data: ${JSON.stringify({ id: "read-file", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-read-file", type: "function", function: { name: "read", arguments: JSON.stringify({ path: serverAttachmentPath }) } }] }, finish_reason: null }] })}\n\n`,
      );
      responses[5]!.end(
        `data: ${JSON.stringify({ id: "read-file", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
      await expect
        .poll(() => providerRequests.some((body) => body.includes("DESKTOP_FILE_BYTES_ONLY")))
        .toBe(true);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      // A pasted image larger than the default 1MiB socket request cap transfers
      // in chunks and reaches the real Pi/provider image preparation path.
      const pasted = Buffer.alloc(1_400_000, 7);
      await input.fill("Inspect pasted image");
      await input.evaluate((element, data) => {
        const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
        const file = new File([bytes], "large-paste.png", { type: "image/png" });
        const clipboard = new DataTransfer();
        clipboard.items.add(file);
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard,
          }),
        );
      }, pasted.toString("base64"));
      await expect(page.getByAltText("large-paste.png")).toBeVisible();
      await expect(input).toHaveValue("Inspect pasted image");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => responses.length).toBeGreaterThanOrEqual(8);
      await expect
        .poll(() =>
          providerRequests.some(
            (body) =>
              body.includes("Inspect pasted image") &&
              body.includes(pasted.toString("base64").slice(0, 1000)),
          ),
        )
        .toBe(true);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(readdir(localHome)).rejects.toThrow();
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByRole("button", { name: "Network & privacy", exact: true }).click();
      await expect(page.getByLabel("Cake server URL")).toHaveValue(url);
      await expect(
        page.getByRole("button", { name: "Return to local", exact: true }),
      ).toBeVisible();
    } finally {
      await application.close();
    }
  } finally {
    clearTimeout(timeout);
    server.kill("SIGTERM");
    await serverExit;
    for (const response of responses) response.destroy();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed remote connection can retry and deliberately relaunch local, then select a remote host in Settings", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-remote-recovery-"));
  const userData = join(directory, "desktop");
  const home = join(directory, "backend");
  await mkdir(userData, { recursive: true });
  const unused = createServer();
  await new Promise<void>((resolve) => unused.listen(0, "127.0.0.1", resolve));
  const address = unused.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const url = `ws://127.0.0.1:${address.port}/rpc`;
  await new Promise<void>((resolve) => unused.close(() => resolve()));
  await writeFile(join(userData, "desktop-host.json"), JSON.stringify({ kind: "remote", url }));
  const launch = () =>
    electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: home,
      },
    });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Retry connection" })).toBeEnabled({
      timeout: 15_000,
    });
    await expect(
      page.getByText("Not connected. Your local backend has not been started."),
    ).toBeVisible();
    await expect(readdir(home)).rejects.toThrow();
    await application.evaluate(({ dialog }) => {
      Object.defineProperty(dialog, "showMessageBox", {
        configurable: true,
        value: async () => ({ response: 0 }),
      });
    });
    await page.getByRole("button", { name: "Return to local" }).click();
    await expect
      .poll(() => readFile(join(userData, "desktop-host.json"), "utf8"))
      .toContain('"remote"');
    await application.evaluate(({ app, dialog }) => {
      Object.defineProperty(dialog, "showMessageBox", {
        configurable: true,
        value: async () => ({ response: 1 }),
      });
      Object.defineProperty(app, "relaunch", { configurable: true, value: () => {} });
    });
    const closed = application.waitForEvent("close");
    await page.getByRole("button", { name: "Return to local" }).click();
    await closed;
    expect(JSON.parse(await readFile(join(userData, "desktop-host.json"), "utf8"))).toEqual({
      kind: "local",
    });
    application = await launch();
    page = await application.firstWindow();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: "Network & privacy", exact: true }).click();
    await expect(page.getByText("Current host: This computer", { exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Enable browser sharing" })).toBeVisible();
    await page.getByLabel("Cake server URL").fill(url.replace("ws:", "http:"));
    await application.evaluate(({ app, dialog }) => {
      Object.defineProperty(dialog, "showMessageBox", {
        configurable: true,
        value: async () => ({ response: 1 }),
      });
      Object.defineProperty(app, "relaunch", { configurable: true, value: () => {} });
    });
    const switched = application.waitForEvent("close");
    await page.getByRole("button", { name: "Connect on relaunch" }).click();
    await switched;
    expect(JSON.parse(await readFile(join(userData, "desktop-host.json"), "utf8"))).toEqual({
      kind: "remote",
      url,
    });
  } finally {
    await application.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
