import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { startMcpServer } from "../fixtures/mcp-server";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const remote of [false, true]) {
  test(`${remote ? "remote" : "local"} Settings and command-only chat retain native MCP through config reload, OAuth cancellation and first message`, async () => {
    test.setTimeout(60_000);
    const root = await mkdtemp(join(tmpdir(), "cake-mcp-smoke-"));
    const userData = join(root, "user-data");
    const project = join(root, "project");
    const cakeHome = join(root, "cake-home");
    const agentDir = join(cakeHome, "pi");
    const server = await startMcpServer();
    await Promise.all([
      mkdir(userData, { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(join(agentDir, "extensions"), { recursive: true }),
    ]);
    await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "system" }));
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
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { oauth: { url: server.url, exposure: "direct" } } }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "mcp-fixture",
        defaultModel: "fixture",
        defaultTools: ["+codemode"],
      }),
    );
    // A provider-free model fixture calls the real packaged codemode worker/WASM,
    // which invokes the real native MCP HTTP transport after sign-in.
    await writeFile(
      join(agentDir, "extensions", "provider.ts"),
      `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default (pi) => {
  pi.registerProvider("mcp-fixture", {
    name: "MCP fixture", api: "mcp-fixture-api", apiKey: "fixture", baseUrl: "http://127.0.0.1:9",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const initializing = context.messages.at(-1)?.role === "user" && JSON.stringify(context.messages.at(-1)).includes("Initialize fixture session");
      const last = context.messages.at(-1);
      const complete = initializing || last?.role === "toolResult";
      const verified = last?.role === "toolResult" && !last.isError && JSON.stringify(last.content).includes("OAuth MCP result") && JSON.stringify(last.content).includes("Script completed");
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: complete ? [{ type: "text", text: initializing ? "Fixture session ready" : verified ? "Packaged MCP script finished" : "Script failed: " + JSON.stringify(last) }] : [{ type: "toolCall", id: "packaged-script", name: "codemode", arguments: { code: "const r = await tools.mcp__oauth__echo({}); console.log(r.content[0].text);" } }],
        stopReason: complete ? "stop" : "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    }
  });
};
`,
    );
    const localHome = join(root, "desktop-must-not-start-backend");
    const backend = remote
      ? spawn(process.execPath, [join(repositoryRoot, "out/server/main.mjs")], {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            CAKE_HOME: cakeHome,
            PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
            PI_CODING_AGENT_SESSION_DIR: "",
            CAKE_SERVER_ENABLED: "true",
            CAKE_SERVER_ALLOW_MISSING_ORIGIN: "true",
            CAKE_SERVER_PORT: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        })
      : undefined;
    const backendExit = backend
      ? new Promise<void>((resolve) => backend.once("exit", () => resolve()))
      : Promise.resolve();
    const backendTimeout = backend ? setTimeout(() => backend.kill("SIGKILL"), 55_000) : undefined;
    if (backend) {
      let output = "";
      backend.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const url = await new Promise<string>((resolve, reject) => {
        backend.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const match = /ws:\/\/127\.0\.0\.1:\d+\/rpc/.exec(output)?.[0];
          if (match) resolve(match);
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
        await readFile(join(userData, "window-state.json")),
      );
    }
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: process.env.TMPDIR,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: remote ? localHome : cakeHome,
        PI_CODING_AGENT_DIR: join(remote ? localHome : cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      await expect(composer).toBeVisible({ timeout: 20_000 });
      // Verify/select the unbilled fake provider before any prompt; never rely on ambient auth fallback.
      const configuration = page.getByRole("button", { name: "Model configuration", exact: true });
      const selectFixture = async () => {
        await configuration.click();
        await page.getByLabel("Search presets and models").fill("Fixture");
        await page.getByRole("button", { name: "Fixture fixture", exact: true }).click();
        await page.getByRole("button", { name: "Apply", exact: true }).click();
        await expect(configuration).toContainText("Fixture");
      };
      await selectFixture();
      await composer.click();
      await expect(composer).toBeFocused();
      await composer.pressSequentially("/mcp");
      await expect(composer).toHaveValue("/mcp");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await composer.press("Escape");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByText(/oauth: needs sign-in/).last()).toBeVisible();
      await expect(composer).toHaveValue("");
      await expect(page.locator("article").filter({ hasText: /^You.*\/mcp/ })).toHaveCount(0);
      expect(
        (await readdir(cakeHome, { recursive: true })).filter((path) => path.endsWith(".jsonl")),
      ).toEqual([]);

      const commandSession = page.locator(".session-item.active");
      await expect(commandSession).toHaveCount(1);
      const commandSessionId = await commandSession.getAttribute("data-session-id");
      await page.getByRole("button", { name: "New chat in project", exact: true }).click();
      await expect(composer).toHaveValue("");
      await expect(composer).toBeFocused();
      // Exceed the four-session idle observation budget. The command-only
      // identity must release its runtime, then reopen without a disk transcript.
      for (let index = 0; index < 5; index += 1) {
        await selectFixture();
        await composer.click();
        await expect(composer).toBeFocused();
        await composer.pressSequentially(`Initialize fixture session ${index}`);
        await expect(composer).toHaveValue(`Initialize fixture session ${index}`);
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect(page.getByText("Fixture session ready", { exact: true })).toBeVisible();
        await expect(composer).toHaveValue("");
        await page.getByRole("button", { name: "New chat in project", exact: true }).click();
        await expect(composer).toBeFocused();
      }
      expect(
        (await readdir(cakeHome, { recursive: true })).some(
          (path) => path.endsWith(".jsonl") && path.includes(commandSessionId!),
        ),
      ).toBe(false);
      await page
        .locator(`.session-item[data-session-id='${commandSessionId}'] .session-row`)
        .click();
      await expect(page.locator(".session-item.active")).toHaveAttribute(
        "data-session-id",
        commandSessionId!,
      );
      await composer.click();
      await expect(composer).toBeFocused();
      await composer.pressSequentially("/mcp login oauth");
      await expect(composer).toHaveValue("/mcp login oauth");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const redirectInput = page.getByPlaceholder("http://127.0.0.1:.../callback?code=...");
      await expect(redirectInput).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByText("Sign-in cancelled.", { exact: true })).toBeVisible();
      expect(server.tokenRequests()).toBe(0);

      // Native configuration Settings uses the same backend files and dialog routing.
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByRole("button", { name: /^MCP servers/ }).click();
      await page.getByRole("button", { name: "Add MCP server", exact: true }).click();
      const serverName = page.getByRole("textbox", { name: "MCP server name", exact: true });
      await serverName.click();
      await expect(serverName).toBeFocused();
      await serverName.pressSequentially("disabled_fixture");
      await expect(serverName).toHaveValue("disabled_fixture");
      const executable = page.getByRole("textbox", { name: "MCP executable or URL", exact: true });
      await executable.click();
      await expect(executable).toBeFocused();
      await executable.pressSequentially("never-launch-this-command");
      await expect(executable).toHaveValue("never-launch-this-command");
      await page.getByRole("switch", { name: "Enabled in configuration", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Save MCP server", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "Save MCP server", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Edit disabled_fixture", exact: true }),
      ).toBeVisible();
      expect(
        JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8")).mcpServers.disabled_fixture,
      ).toMatchObject({ command: "never-launch-this-command", enabled: false });
      await page.getByRole("button", { name: "Remove disabled_fixture", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Edit disabled_fixture", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("combobox", { name: "MCP configuration scope", exact: true })
        .selectOption("project");
      await expect(page.getByRole("button", { name: "Sign in oauth", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Sign in oauth", exact: true }).click();
      await expect(redirectInput).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByText("Sign-in cancelled.", { exact: true }).last()).toBeVisible();
      expect(server.tokenRequests()).toBe(0);
      await expect(page.getByRole("button", { name: "Sign in oauth", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Sign in oauth", exact: true }).click();
      await expect(redirectInput).toBeVisible();
      const notice = page.getByText(/Sign in to MCP server "oauth" in your browser:/).last();
      const authorizationText = await notice.innerText();
      const authorization = new URL(
        authorizationText.match(/http:\/\/127\.0\.0\.1:\d+\/authorize\S+/)?.[0] ?? "",
      );
      const redirect = new URL(authorization.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "fixture-code");
      redirect.searchParams.set("state", authorization.searchParams.get("state") ?? "");
      await redirectInput.click();
      await expect(redirectInput).toBeFocused();
      await redirectInput.pressSequentially(redirect.href);
      await expect(redirectInput).toHaveValue(redirect.href);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(
        page.getByText('Signed in to MCP server "oauth" (1 tools).', { exact: true }),
      ).toBeVisible();
      expect(await readFile(join(agentDir, "mcp-auth.json"), "utf8")).toContain("fixture-token");
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();

      await composer.click();
      await expect(composer).toBeFocused();
      await composer.pressSequentially("Run the MCP script");
      await expect(composer).toHaveValue("Run the MCP script");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByText("Packaged MCP script finished", { exact: true })).toBeVisible();
      expect(server.calls()).toBe(1);
      const transcripts = (await readdir(cakeHome, { recursive: true })).filter(
        (path) => path.endsWith(".jsonl") && path.includes(commandSessionId!),
      );
      expect(transcripts).toHaveLength(1);
      const entries = (await readFile(join(cakeHome, transcripts[0]!), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const userMessages = entries.filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].message.content).toEqual([
        { type: "text", text: "Run the MCP script" },
      ]);

      // Commands in an established conversation and ordinary first-message
      // promotion retain their existing paths.
      await composer.fill("/mcp");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByText(/oauth: connected/).last()).toBeVisible();
      await expect(composer).toHaveValue("");
      await page.getByRole("button", { name: "New chat in project", exact: true }).click();
      await expect(composer).toBeFocused();
      await selectFixture();
      await composer.click();
      await expect(composer).toBeFocused();
      await composer.pressSequentially("Initialize fixture session");
      await expect(composer).toHaveValue("Initialize fixture session");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByText("Fixture session ready", { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
      if (remote) expect(await readdir(localHome).catch(() => [])).toEqual([]);
    } finally {
      await application.close();
      if (backendTimeout) clearTimeout(backendTimeout);
      if (backend) {
        backend.kill("SIGTERM");
        await backendExit;
      }
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
