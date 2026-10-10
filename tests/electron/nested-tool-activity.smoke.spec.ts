import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { nestedUsage } from "../fixtures/nested-tool-activity";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const script =
  'const results = await Promise.all([tools.fixture_child({label: "slow"}), tools.fixture_child({label: "fast"}), tools.fixture_child({label: "error"})]); return results;';

test("authoritative chat discloses parallel script children, then restores metadata without invented output", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-nested-tool-activity-"));
  const userData = join(root, "user-data");
  const project = join(root, "project");
  const cakeHome = join(root, "cake-home");
  const agentDir = join(cakeHome, "pi");
  const responses = new Map<string, ServerResponse>();
  const server = createServer((request, response) =>
    responses.set(request.url!.slice(1), response),
  );
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const release = (label: string, status: number, output: string) => {
    const response = responses.get(label);
    if (!response) throw new Error(`Missing child request ${label}`);
    response.writeHead(status);
    response.end(output);
  };
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
      theme: "dark",
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
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "nested-fixture",
      defaultModel: "fixture",
      defaultTools: ["+codemode"],
    }),
  );
  // Only the external tool/provider boundaries are fixtures. Pi owns the real
  // QuickJS script, parallel child pipeline, cancellation, record and usage.
  await writeFile(
    join(agentDir, "extensions", "fixture.ts"),
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
export default (pi) => {
  pi.registerTool({ name: "fixture_child", label: "Fixture child", description: "Controlled child", parameters: Type.Object({ label: Type.String() }),
    async execute(_id, args, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: args.label + " partial output" }], details: {} });
      const response = await fetch(${JSON.stringify(endpoint)} + "/" + args.label, { signal });
      const output = await response.text();
      if (!response.ok) throw new Error(output);
      return { content: [{ type: "text", text: output }], details: {}, usage: ${JSON.stringify(nestedUsage)} };
    }
  });
  pi.registerProvider("nested-fixture", {
    name: "Nested fixture", api: "nested-fixture-api", apiKey: "fixture", baseUrl: "http://127.0.0.1:9",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const done = context.messages.at(-1)?.role === "toolResult";
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: done ? [{ type: "text", text: "Nested script finished" }] : [{ type: "toolCall", id: "nested-script", name: "codemode", arguments: { code: ${JSON.stringify(script)} } }],
        stopReason: done ? "stop" : "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); return stream;
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
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
    await composer.pressSequentially("Run parallel script children");
    await expect(composer).toHaveValue("Run parallel script children");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => responses.size).toBe(3);
    const log = page.locator('[data-slot="activity-group"]');
    await log.locator(":scope > summary").click();
    const parent = page.locator('[data-part-id="tool-nested-script"]');
    const parentTrigger = parent.getByRole("button", { name: /^codemode/ });
    await expect(parentTrigger).toHaveAttribute("aria-expanded", "false");
    await parentTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(parentTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(parent.getByText("Script", { exact: true })).toBeVisible();
    await expect(parent.locator('[data-streamdown="code-block-body"]').first()).toContainText(
      script,
    );
    const activity = parent.getByRole("region", { name: "Nested tool activity" });
    await expect(activity.locator('[data-slot="tool"]')).toHaveCount(3);
    const fast = activity.locator('[data-slot="tool"]').nth(1);
    await fast.getByRole("button", { name: /fixture_child/ }).click();
    await expect(fast.getByRole("button", { name: /fixture_child/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(fast.locator('[data-slot="tool-details"]')).toBeVisible();
    await expect(fast).toContainText('"label": "fast"');
    await expect(fast).toContainText("fast partial output");
    release("fast", 200, "fast returned output");
    await expect(fast).toContainText("fast returned output");
    await expect(parentTrigger).toHaveAttribute("aria-expanded", "true");
    release("error", 500, "Fixture child failed");
    await expect(page.getByText("Nested script finished", { exact: true })).toBeVisible();
    await expect(page.locator('[title*="15 billed tokens"]')).toBeVisible();
    await expect(parent).toContainText("Script failed");
    await expect(activity.locator('[data-slot="tool"]')).toHaveCount(3);

    // Reopen through the real session workflow. No ephemeral child output is
    // persisted; error summaries and the bounded record remain available.
    const sessionId = await page.locator(".session-item.active").getAttribute("data-session-id");
    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await page.locator(`.session-item[data-session-id='${sessionId}'] .session-row`).click();
    await expect(log).toBeVisible();
    if ((await log.getAttribute("open")) === null) await log.locator(":scope > summary").click();
    await expect(parentTrigger).toBeVisible();
    await expect(page.locator('[title*="15 billed tokens"]')).toBeVisible();
    if ((await parentTrigger.getAttribute("aria-expanded")) !== "true") await parentTrigger.click();
    await expect(parent.locator('[data-streamdown="code-block-body"]').first()).toContainText(
      script,
    );
    for (const child of await activity.locator('[data-slot="tool"]').all()) {
      const trigger = child.getByRole("button", { name: /fixture_child/ });
      if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(child.getByText(/Output unavailable in saved history/)).toBeVisible();
    }
    await expect(activity.locator('[data-slot="tool"]').nth(2)).toContainText(
      "Recorded error summary",
    );
    await expect(activity.locator('[data-slot="tool"]').nth(2)).toContainText(
      "Fixture child failed",
    );
    await parentTrigger.focus();
    await page.keyboard.press("Space");
    await expect(parentTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(activity).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(activity).toBeVisible();
    await page.keyboard.press("Control+o");
    await page.keyboard.press("Control+o");
    await expect(activity).toBeVisible();
    await expect(activity.locator('[aria-expanded="true"]')).toHaveCount(3);

    const transcripts = (await readdir(cakeHome, { recursive: true })).filter(
      (path) => path.endsWith(".jsonl") && path.includes(sessionId!),
    );
    expect(transcripts).toHaveLength(1);
    const entries = (await readFile(join(cakeHome, transcripts[0]!), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const result = entries.find(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    ).message;
    expect(result.isError).toBe(true);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.nestedCalls.calls).toHaveLength(3);
    expect(
      result.nestedCalls.calls.every((call: object) => !("output" in call) && !("usage" in call)),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    for (const response of responses.values()) response.destroy();
    await application.close();
    await new Promise<void>((closed) => server.close(() => closed()));
    await rm(root, { recursive: true, force: true });
  }
});
