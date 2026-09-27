import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { Effect } from "effect";
import { connectClient } from "../integration/fixtures/network-client";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("remote Electron loads backend widgets and companion actions, then Pi reviews native settled pixels", async () => {
  test.setTimeout(70_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-remote-widget-"));
  const home = join(directory, "server");
  const userData = join(directory, "desktop");
  const project = join(directory, "server-project");
  const fixture = join(directory, "fixture-package");
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(home, "pi", "sessions"));
  const providerRequests: string[] = [];
  const reviewedSource = `import React, { useEffect, useState } from 'react'; export default function Reviewed() { const [ready, setReady] = useState(false); useEffect(() => { const timer = setTimeout(() => setReady(true), 300); return () => clearTimeout(timer); }, []); return <main style={{ background: ready ? 'rgb(0,220,220)' : 'rgb(255,165,0)', minHeight: 430 }}><h1>{ready ? 'REVIEWED SETTLED' : 'WAITING'}</h1></main>; }`;
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      providerRequests.push(Buffer.concat(chunks).toString("utf8"));
      const index = providerRequests.length;
      const tool = {
        command: "widgets.present",
        input: {
          widget: {
            id: "remote-reviewed",
            title: "Remote reviewed widget",
            brief: "Show settled cyan pixels",
            fallback: { markdown: "Settled cyan widget" },
          },
        },
      };
      const content =
        index === 2
          ? `\`\`\`cake-react\n${reviewedSource}\n\`\`\``
          : index === 3
            ? "ACCEPT_CURRENT"
            : "Reviewed widget complete";
      const delta =
        index === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "call-widget",
                  type: "function",
                  function: { name: "cake", arguments: JSON.stringify(tool) },
                },
              ],
            }
          : { content };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: `fixture-${index}`, object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `fixture-${index}`, object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: index === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === "string")
    throw new Error("Missing provider address");
  await Promise.all([
    mkdir(join(home, "state"), { recursive: true }),
    mkdir(join(fixture, "extensions"), { recursive: true }),
    mkdir(join(fixture, "cake"), { recursive: true }),
    mkdir(join(project, ".pi"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  await writeFile(
    join(home, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "fixture-provider": {
          name: "Widget fixture",
          baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Widget vision fixture",
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
          name: "Remote widget project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [project],
    }),
  );
  await writeFile(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ packages: ["../../fixture-package"] }),
  );
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "remote-widget-fixture",
      version: "1.0.0",
      pi: { extensions: ["extensions/fixture.ts"] },
      cake: {
        companions: [
          {
            id: "remote-fixture",
            extension: "extensions/fixture.ts",
            entry: "cake/fixture.tsx",
            slot: "composer.above",
            actions: ["increment"],
          },
        ],
      },
    }),
  );
  await writeFile(
    join(fixture, "cake", "fixture.tsx"),
    `export default function Fixture({ state, dispatch, ui }) { return <ui.Button onClick={() => dispatch("increment")}>Remote companion count: {state.count}</ui.Button>; }`,
  );
  await writeFile(
    join(fixture, "extensions", "fixture.ts"),
    `export default function(pi) { let count = 1; const publish = () => pi.events.emit("cake:companion:state", { id: "remote-fixture", state: { count } }); pi.on("session_start", publish); pi.events.on("cake:companion:action", (event) => { if (event?.id === "remote-fixture" && event.action === "increment") { count++; publish(); } }); pi.registerCommand("remote-fixture", { description: "Open remote companion", handler() {} }); }`,
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
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
          content: [{ type: "text", text: "Remote fixture existing session" }],
          timestamp: 0,
        },
      },
    ]
      .map((item) => JSON.stringify(item))
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
  const timeout = setTimeout(() => server.kill("SIGKILL"), 65_000);
  try {
    const url = await new Promise<string>((done, reject) => {
      server.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const address = /ws:\/\/127\.0\.0\.1:\d+\/rpc/.exec(output)?.[0];
        if (address) done(address);
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
        selectedSessionId: sessionId,
        activeConversation: { kind: "project-session", workspacePath: project, sessionId },
        recentProjectPaths: [project],
        draft: "",
      }),
    );
    const compiled = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* connectClient(url);
          return yield* client["widgets.compile-inline-widget"]({
            language: "react",
            capability: "display",
            source: `import React, { useState, useEffect } from "react";
export default function RemoteWidget() {
  const [count, setCount] = useState(0);
  const [settled, setSettled] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setSettled(true), 300); return () => clearTimeout(timer); }, []);
  return <main style={{ background: settled ? 'rgb(0,220,220)' : 'rgb(255,165,0)', minHeight: 430 }}><h1>{settled ? 'REMOTE SETTLED' : 'WAITING'}</h1><button onClick={() => setCount(count + 1)}>Remote count {count}</button></main>;
}`,
          });
        }),
      ),
    );
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: join(directory, "local-must-not-exist"),
      },
    });
    try {
      const page = await application.firstWindow();
      await expect(page.getByText(`Remote: ${url}`, { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        page.locator(".transcript").getByText("Remote fixture existing session"),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("button", { name: "Remote companion count: 1" })).toBeVisible({
        timeout: 20_000,
      });
      await page.getByRole("button", { name: "Remote companion count: 1" }).click();
      await expect(page.getByRole("button", { name: "Remote companion count: 2" })).toBeVisible();
      await page.evaluate((widget) => {
        const frame = document.createElement("iframe");
        frame.title = "Remote widget smoke";
        frame.sandbox.add("allow-scripts");
        frame.src = widget.url;
        document.body.append(frame);
      }, compiled.widget);
      const frame = page.frameLocator('iframe[title="Remote widget smoke"]');
      await expect(frame.getByText("REMOTE SETTLED")).toBeVisible({ timeout: 15_000 });
      await frame.getByRole("button", { name: "Remote count 0" }).click();
      await expect(frame.getByRole("button", { name: "Remote count 1" })).toBeVisible();
      await page.evaluate(() => {
        const invalid = document.createElement("iframe");
        invalid.title = "Revoked remote widget";
        invalid.sandbox.add("allow-scripts");
        invalid.src = `cake-widget://document/${crypto.randomUUID()}`;
        document.body.append(invalid);
      });
      await expect(
        page
          .frameLocator('iframe[title="Revoked remote widget"]')
          .getByText("Widget document not found"),
      ).toBeVisible();
      const pixels = await application.evaluate((_electron, widget) => {
        const capture = (
          globalThis as typeof globalThis & {
            cakeSmokeRemoteCaptureWidget?: (
              widget: typeof compiled.widget,
            ) => Promise<{ pngBase64: string; diagnostics: string[] }>;
          }
        ).cakeSmokeRemoteCaptureWidget;
        if (!capture) throw new Error("Missing remote native capture");
        return capture(widget);
      }, compiled.widget);
      expect(pixels.pngBase64.length).toBeGreaterThan(1000);
      const colors = await application.evaluate(({ nativeImage }, base64) => {
        const bitmap = nativeImage.createFromBuffer(Buffer.from(base64, "base64")).toBitmap();
        let cyan = 0;
        let orange = 0;
        for (let index = 0; index < bitmap.length; index += 4) {
          const blue = bitmap[index] ?? 0;
          const green = bitmap[index + 1] ?? 0;
          const red = bitmap[index + 2] ?? 0;
          if (red < 30 && green > 180 && blue > 180) cyan++;
          if (red > 180 && green > 100 && green < 190 && blue < 30) orange++;
        }
        return { cyan, orange };
      }, pixels.pngBase64);
      expect(colors.cyan).toBeGreaterThan(20_000);
      expect(colors.orange).toBe(0);
      expect(pixels.diagnostics).toContain("host=hidden-offscreen");
      expect(pixels.diagnostics.some((item) => item.includes("contentHeight="))).toBe(true);
      const input = page.getByRole("combobox", { name: "Message", exact: true });
      await input.fill("Present a visually reviewed remote widget");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByText("Reviewed widget complete")).toBeVisible({ timeout: 30_000 });
      expect(providerRequests).toHaveLength(4);
      expect(providerRequests[1]).toContain("Build this presentation");
      const reviewImage = JSON.stringify(JSON.parse(providerRequests[2]!)).match(
        /data:image\/png;base64,([A-Za-z0-9+/=]+)/,
      )?.[1];
      expect(reviewImage?.length).toBeGreaterThan(1000);
      const reviewedColors = await application.evaluate(({ nativeImage }, base64) => {
        const bitmap = nativeImage.createFromBuffer(Buffer.from(base64, "base64")).toBitmap();
        let cyan = 0,
          orange = 0;
        for (let index = 0; index < bitmap.length; index += 4) {
          const blue = bitmap[index] ?? 0,
            green = bitmap[index + 1] ?? 0,
            red = bitmap[index + 2] ?? 0;
          if (red < 30 && green > 180 && blue > 180) cyan++;
          if (red > 180 && green > 100 && green < 190 && blue < 30) orange++;
        }
        return { cyan, orange };
      }, reviewImage!);
      expect(reviewedColors.cyan).toBeGreaterThan(20_000);
      expect(reviewedColors.orange).toBe(0);
      await expect(page.getByLabel("Remote reviewed widget", { exact: true })).toBeVisible();
    } finally {
      await application.close();
    }
  } finally {
    clearTimeout(timeout);
    server.kill("SIGTERM");
    await new Promise<void>((done) => server.once("exit", () => done()));
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
