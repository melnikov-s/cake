import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeSocket } from "@effect/platform-node-shared";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repository = resolve(import.meta.dirname, "../..");

test("remote Pi Browser Mode controls desktop Chromium and previews backend localhost over HTTP and live WS", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-remote-browser-"));
  const home = join(root, "backend");
  const userData = join(root, "desktop");
  const project = join(root, "project");
  const sessionId = "00000000-0000-4000-8000-000000000088";
  const requests: string[] = [];
  let releaseEvaluate: (() => void) | undefined;
  const readyToEvaluate = new Promise<void>((done) => {
    releaseEvaluate = done;
  });
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      requests.push(Buffer.concat(chunks).toString());
      const index = requests.length;
      if (index === 3) await readyToEvaluate;
      const tool =
        index === 1
          ? { command: "browser.enter", input: {} }
          : index === 2
            ? { command: "browser.cdp", input: { method: "Runtime.enable" } }
            : index === 3
              ? {
                  command: "browser.cdp",
                  input: {
                    method: "Runtime.evaluate",
                    params: {
                      expression:
                        "console.log('cake-remote-cdp'); document.querySelector('#source').textContent = 'CHANGED BY CDP'; document.querySelector('#source').textContent",
                      returnByValue: true,
                    },
                  },
                }
              : index === 4
                ? {
                    command: "browser.events",
                    input: { methods: ["Runtime.consoleAPICalled"], limit: 10 },
                  }
                : {
                    command: "browser.cdp",
                    input: {
                      method: "Page.captureScreenshot",
                      params: {
                        format: "png",
                        captureBeyondViewport: true,
                        clip: { x: 0, y: 0, width: 1200, height: 900, scale: 1 },
                      },
                    },
                  };
      const delta =
        index <= 5
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${index}`,
                  type: "function",
                  function: { name: "cake", arguments: JSON.stringify(tool) },
                },
              ],
            }
          : { content: "Remote browser CDP complete" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: `fixture-${index}`, object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `fixture-${index}`, object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: index <= 5 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === "string")
    throw new Error("Provider missing address");
  const previewRequests: Array<{
    path: string;
    cookie: string | undefined;
    bridge: string | undefined;
  }> = [];
  const preview = createServer((req, res) => {
    previewRequests.push({
      path: req.url ?? "",
      cookie: req.headers.cookie,
      bridge: req.headers["x-cake-preview-bridge"]?.toString(),
    });
    if (req.url === "/interaction" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => res.end(`BACKEND POST:${body}`));
      return;
    }
    res.setHeader("content-type", req.url === "/app.js" ? "text/javascript" : "text/html");
    if (req.url === "/") res.setHeader("Set-Cookie", "preview_app=leased; Path=/; SameSite=Lax");
    res.end(
      req.url === "/app.js"
        ? "document.querySelector('#asset').textContent = 'BACKEND ASSET'; document.querySelector('#cookie').textContent = document.cookie; fetch('/interaction', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'clicked' }) }).then(async r => document.querySelector('#post').textContent = await r.text()); const ws = new WebSocket('ws://' + location.host + '/hot'); ws.onmessage = (event) => document.querySelector('#hot').textContent = event.data; ws.onopen = () => ws.send('ping'); const ctx = document.querySelector('canvas').getContext('2d'); const image = ctx.createImageData(1200, 900); for (let i = 0; i < image.data.length; i += 4) { const color = Math.floor(Math.random() * 16777216); image.data[i] = color; image.data[i + 1] = color >>> 8; image.data[i + 2] = color >>> 16; image.data[i + 3] = 255; } ctx.putImageData(image, 0, 0);"
        : '<!doctype html><title>Backend preview</title><main id="source">BACKEND PAGE</main><span id="asset"></span><span id="hot"></span><span id="post"></span><span id="cookie"></span><canvas width="1200" height="900"></canvas><script src="/app.js"></script>',
    );
  });
  const previewWs = new NodeSocket.NodeWS.WebSocketServer({ server: preview });
  previewWs.on("connection", (ws) => ws.on("message", (bytes) => ws.send(`BACKEND HMR:${bytes}`)));
  let sourcePort = 0;
  for (let port = 5200; port < 5300; port++) {
    try {
      await new Promise<void>((done, reject) => {
        preview.once("error", reject);
        preview.listen(port, "127.0.0.1", done);
      });
      sourcePort = port;
      break;
    } catch {
      preview.removeAllListeners("error");
    }
  }
  if (!sourcePort) throw new Error("No preview fixture port available");
  // Same numeric port, IPv6 laptop vs IPv4 backend: a distinct local page cannot
  // accidentally satisfy the backend-preview assertion in this single-host CI fixture.
  const laptop = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<!doctype html><title>Laptop local</title><main id="source">LAPTOP PAGE</main>');
  });
  await new Promise<void>((done, reject) => {
    laptop.once("error", reject);
    laptop.listen(sourcePort, "::1", done);
  });
  await Promise.all([
    mkdir(join(home, "state"), { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(cakeWorkspaceSessionDirectory(project, join(home, "pi", "sessions")), {
      recursive: true,
    }),
  ]);
  await writeFile(
    join(home, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "fixture-provider": {
          name: "Browser provider",
          baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Browser model",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 2048,
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
        {
          path: project,
          name: "Remote browser",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [project],
    }),
  );
  await writeFile(
    join(
      cakeWorkspaceSessionDirectory(project, join(home, "pi", "sessions")),
      `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`,
    ),
    [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: project,
      },
      {
        type: "model_change",
        id: "model",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        provider: "fixture-provider",
        modelId: "fixture-model",
      },
      {
        type: "message",
        id: "user-entry",
        parentId: "model",
        timestamp: new Date(0).toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "Browser fixture existing session" }],
          timestamp: 0,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const backend = spawn(process.execPath, [join(repository, "out/server/main.mjs")], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
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
  const watchdog = setTimeout(() => backend.kill("SIGKILL"), 85_000);
  try {
    const url = await new Promise<string>((done, reject) => {
      backend.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const found = /ws:\/\/127\.0\.0\.1:\d+\/rpc/.exec(output)?.[0];
        if (found) done(found);
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
      }),
    );
    const application = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: join(root, "desktop-must-not-start-backend"),
      },
    });
    try {
      const page = await application.firstWindow();
      await expect(page.getByText(`Remote: ${url}`, { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        page.locator(".transcript").getByText("Browser fixture existing session"),
      ).toBeVisible({ timeout: 20_000 });
      const input = page.getByRole("combobox", { name: "Message", exact: true });
      await input.fill("Enter browser and inspect preview");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const address = page.getByLabel("Browser address");
      await expect(address).toBeVisible({ timeout: 20_000 });
      await address.fill(`http://[::1]:${sourcePort}/`);
      await address.press("Enter");
      await expect
        .poll(
          () =>
            application.evaluate(async ({ webContents }) => {
              const local = webContents
                .getAllWebContents()
                .find((entry) => entry.getTitle() === "Laptop local");
              return local?.executeJavaScript("document.querySelector('#source')?.textContent");
            }),
          { timeout: 15_000 },
        )
        .toBe("LAPTOP PAGE");
      await address.fill(`backend://localhost:${sourcePort}/`);
      await address.press("Enter");
      const contents = async () =>
        application.evaluate(async ({ webContents }) => {
          const target = webContents
            .getAllWebContents()
            .find((entry) => entry.getTitle() === "Backend preview");
          return target
            ? {
                url: target.getURL(),
                text: await target.executeJavaScript(
                  "({ source: document.querySelector('#source')?.textContent, asset: document.querySelector('#asset')?.textContent, hot: document.querySelector('#hot')?.textContent, post: document.querySelector('#post')?.textContent, cookie: document.querySelector('#cookie')?.textContent })",
                ),
              }
            : undefined;
        });
      await expect.poll(contents, { timeout: 20_000 }).toMatchObject({
        text: {
          source: "BACKEND PAGE",
          asset: "BACKEND ASSET",
          hot: "BACKEND HMR:ping",
          post: 'BACKEND POST:{"action":"clicked"}',
          cookie: "preview_app=leased",
        },
      });
      const loaded = await contents();
      expect(loaded?.url).toMatch(/^http:\/\/preview-[a-f0-9]{32}\.localhost:\d+\/$/);
      expect(new URL(loaded!.url).port).not.toBe(new URL(url).port);
      expect(
        previewRequests.some(
          (entry) => entry.path === "/interaction" && entry.cookie === "preview_app=leased",
        ),
      ).toBe(true);
      expect(previewRequests.every((entry) => entry.bridge === undefined)).toBe(true);
      expect(
        await application.evaluate(
          async ({ webContents }, cakeOrigin) => {
            const target = webContents
              .getAllWebContents()
              .find((entry) => entry.getTitle() === "Backend preview");
            if (!target) throw new Error("Preview web contents missing");
            return target.executeJavaScript(
              `fetch('${cakeOrigin}/rpc', { credentials: 'include' }).then(() => 'leaked', () => 'blocked')`,
            );
          },
          new URL(url.replace(/^ws/, "http")).origin,
        ),
      ).toBe("blocked");
      releaseEvaluate?.();
      await expect(page.getByText("Remote browser CDP complete")).toBeVisible({ timeout: 25_000 });
      await expect.poll(contents).toMatchObject({ text: { source: "CHANGED BY CDP" } });
      expect(requests).toHaveLength(6);
      expect(requests[3]).toContain("CHANGED BY CDP");
      expect(requests[4]).toContain("Runtime.consoleAPICalled");
      // Another desktop may observe the same session but must not drive this window's Chromium.
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
      if (!second) throw new Error("Second remote window missing");
      await expect(
        second.locator(".transcript").getByText("Browser fixture existing session"),
      ).toBeVisible();
      const secondAddress = second.getByLabel("Browser address");
      await expect(secondAddress).toBeVisible();
      await secondAddress.fill(`http://[::1]:${sourcePort}/`);
      await secondAddress.press("Enter");
      await expect
        .poll(() =>
          application.evaluate(
            ({ webContents }, expectedUrl) =>
              webContents.getAllWebContents().some((entry) => entry.getURL() === expectedUrl),
            loaded!.url,
          ),
        )
        .toBe(true);
      await expect(second.getByText(/Browser view belongs to another window/)).toBeVisible();
      await second.getByRole("button", { name: "Select an element" }).click();
      await expect(page.getByRole("button", { name: "Select an element" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      // Pi transcodes the real PNG tool image to JPEG for the fixture provider.
      const screenshotImage = /data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/.exec(requests[5]!)?.[1];
      expect(screenshotImage?.length).toBeGreaterThan(100_000);
      expect(await readdir(join(root, "desktop-must-not-start-backend")).catch(() => [])).toEqual(
        [],
      );
      // Original owner disconnect: the stale local bridge cannot continue to serve app content.
      await page.close();
      const oldOrigin = new URL(loaded!.url);
      await expect
        .poll(
          () =>
            new Promise<string>((done) => {
              httpRequest(
                `http://127.0.0.1:${oldOrigin.port}/`,
                { headers: { host: oldOrigin.host } },
                (response) => {
                  response.resume();
                  response.on("end", () => done(String(response.statusCode)));
                },
              )
                .on("error", () => done("closed"))
                .end();
            }),
          { timeout: 10_000 },
        )
        .toMatch(/^(closed|403)$/);
    } finally {
      releaseEvaluate?.();
      await application.close();
    }
  } finally {
    clearTimeout(watchdog);
    backend.kill("SIGTERM");
    if (backend.exitCode === null && backend.signalCode === null)
      await new Promise<void>((done) => backend.once("exit", () => done()));
    for (const ws of previewWs.clients) ws.terminate();
    previewWs.close();
    preview.closeAllConnections();
    preview.close();
    laptop.closeAllConnections();
    laptop.close();
    provider.closeAllConnections();
    provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
