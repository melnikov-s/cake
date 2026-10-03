import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { startMcpServer } from "../fixtures/mcp-server";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("a command-only fresh chat retains native MCP through switching, OAuth cancellation, and its first message", async () => {
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
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
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
    await page.locator(`.session-item[data-session-id='${commandSessionId}'] .session-row`).click();
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

    await composer.fill("/mcp login oauth");
    await page.getByRole("button", { name: "Send", exact: true }).click();
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
    expect(userMessages[0].message.content).toEqual([{ type: "text", text: "Run the MCP script" }]);

    // Commands in an established conversation and ordinary first-message
    // promotion retain their existing paths.
    await composer.fill("/mcp");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(/oauth: connected/).last()).toBeVisible();
    await expect(composer).toHaveValue("");
    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await expect(composer).toBeFocused();
    await composer.pressSequentially("Initialize fixture session");
    await expect(composer).toHaveValue("Initialize fixture session");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Fixture session ready", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
